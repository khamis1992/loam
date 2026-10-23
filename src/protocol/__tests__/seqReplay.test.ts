/**
 * O4: socket replay by durable log sequence (BUILD_SPEC §6.4).
 *
 * A client that sends `lastSeq` on `join_session` must receive exactly the
 * frames with `seq > lastSeq`, in order, and nothing it already has. The
 * `lastMessageId` cursor path keeps its pre-O4 behaviour.
 *
 * The adapter runs against a throwaway `LOAM_DATA_DIR` with a fake `runTask` and
 * a fake task lookup, so no real model, task or data dir is touched. The adapter
 * owns its own `ProtocolStore`; the test seeds sessions through the adapter's
 * store and drives the real HTTP login chain and socket.io transport.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { io, type Socket as IoSocket } from "socket.io-client";
import type { RunTaskOptions } from "../../server/http.js";
import type { Task } from "../../server/db.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-seq-replay-"));
process.env.LOAM_DATA_DIR = tmpDir;
process.env.MANUS_LOCAL_DATA_DIR = tmpDir;

const { startProtocolAdapter } = await import("../adapter.js");
const { resetDb } = await import("../../server/sqliteStore.js");
const { purgeSession } = await import("../eventLog.js");
type ClientMessage = import("../types.js").ClientMessage;
type ServerEnvelope = import("../types.js").ServerEnvelope;
type ProtocolStore = import("../store.js").ProtocolStore;

/** A persisted chat frame with no log sequence yet; `appendEvent` stamps it. */
function envelope(id: string, sessionId: string, content: string): ServerEnvelope {
  return {
    id,
    type: "event",
    sessionId,
    timestamp: 1_700_000_000_000,
    event: {
      id,
      type: "chat",
      timestamp: 1_700_000_000_000,
      sender: "assistant",
      messageType: "text",
      content,
      attachments: [],
    },
  };
}

/**
 * Seed six chat frames plus the one `status` row the store writes on
 * `ensureSession`, so the six chat frames carry durable log sequences 2..7.
 */
function seed(store: ProtocolStore, sessionId: string): ServerEnvelope[] {
  store.ensureSession(sessionId, "task_" + sessionId, "Seq");
  const frames: ServerEnvelope[] = [];
  for (let i = 1; i <= 6; i++) {
    const frame = envelope(`evt_${sessionId}_${i}`, sessionId, `frame ${i}`);
    store.appendEvent(sessionId, frame);
    frames.push(frame);
  }
  return frames;
}

function request(
  port: number,
  method: string,
  p: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; json: any; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: p,
        method,
        headers: {
          ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : {}, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/** The adapter's dev login chain, performed the way a real client does it. */
async function loginChain(port: number): Promise<string> {
  const login = await request(port, "GET", "/login?nonce=seq&type=signIn");
  assert.equal(login.status, 302, "login redirect expected");
  const loginToken = new URLSearchParams(String(login.headers.location ?? "").split("?")[1] ?? "").get("token");
  assert.ok(loginToken, "login redirect missing token");
  const gen = await request(port, "POST", "/user.v1.UserAuthService/GenerateTempAuthCode", {}, loginToken);
  assert.equal(gen.status, 200, "GenerateTempAuthCode expected 200");
  const exch = await request(port, "POST", "/user.v1.UserAuthPublicService/ExchangeTokenByCode", { token: gen.json.token });
  assert.equal(exch.status, 200, "ExchangeTokenByCode expected 200");
  return String(exch.json.token);
}

let adapter: Awaited<ReturnType<typeof startProtocolAdapter>> | undefined;
let token = "";

const fakeTasks = new Map<string, Task>();

async function setup(): Promise<void> {
  resetDb();
  const runTask = async (opts: RunTaskOptions): Promise<{ taskId: string; text: string }> => {
    fakeTasks.set(opts.taskId!, {
      id: opts.taskId!,
      title: "seq",
      prompt: opts.prompt,
      status: "done",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
      steps: [],
    });
    return { taskId: opts.taskId!, text: "" };
  };
  adapter = await startProtocolAdapter({
    cfg: { workspace: tmpDir } as never,
    runTask,
    getTask: (id: string) => fakeTasks.get(id),
    port: 0,
  });
  token = await loginChain(adapter.port);
}

async function teardown(): Promise<void> {
  if (adapter) {
    await adapter.close();
    adapter = undefined;
  }
  resetDb();
}

function connect(): IoSocket {
  return io(`http://127.0.0.1:${adapter!.port}`, {
    transports: ["websocket"],
    auth: { token },
    query: { locale: "en", tz: "UTC", clientType: "desktop", clientVersion: "0.0.0" },
  });
}

async function connected(socket: IoSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
}

interface Replay {
  /** Durable log seq the frame reported, or undefined when it had none. */
  seq?: number;
  /** Payload ids inside `eventsNotifyEventsAfter`, in order. */
  ids: string[];
}

/** Join and resolve the resulting `eventsNotifyEventsAfter` frame. */
function replayAfter(socket: IoSocket, m: ClientMessage): Promise<Replay> {
  return new Promise<Replay>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for replay frame")), 5000);
    const onMessage = (msg: ServerEnvelope) => {
      if (msg.type !== "event" || msg.event.type !== "eventsNotifyEventsAfter") return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      const events = (msg.event as unknown as { events?: Array<{ id?: string }> }).events ?? [];
      resolve({ seq: msg.seq, ids: events.map((e) => String(e.id ?? "")) });
    };
    socket.on("message", onMessage);
    socket.emit("message", m);
  });
}

function join(sessionId: string, extra: Partial<ClientMessage> = {}): ClientMessage {
  return {
    type: "join_session",
    id: "join-" + Math.random().toString(36).slice(2),
    timestamp: Date.now(),
    sessionId,
    version: 2,
    ...extra,
  } as ClientMessage;
}

describe("socket replay by sequence (O4)", () => {
  before(setup);
  after(teardown);

  it("replays exactly seq 4,5,6 when the client sends lastSeq=3 of 6", async () => {
    const sessionId = "ses_seq_6";
    const frames = seed(adapter!.store, sessionId);
    // The six chat frames are log sequences 2..7 (seq 1 is the store's status
    // row), so "3 of 6 frames seen" is the cursor lastSeq=4.
    assert.deepEqual(frames.map((f) => f.seq), [2, 3, 4, 5, 6, 7]);

    const socket = connect();
    await connected(socket);
    const replay = await replayAfter(socket, join(sessionId, { lastSeq: 4 }));

    // lastSeq=4 -> only the frames with seq > 4 (5,6,7), i.e. frames 4,5,6.
    assert.deepEqual(replay.ids, [frames[3]!.id, frames[4]!.id, frames[5]!.id]);
    // The replay frame reports the highest seq it delivered, so a client can
    // advance its cursor past everything just replayed.
    assert.equal(replay.seq, 7);
    socket.disconnect();
  });

  it("treats the log sequence as the cursor, not the frame index", async () => {
    const sessionId = "ses_seq_cursor";
    const frames = seed(adapter!.store, sessionId);

    const socket = connect();
    await connected(socket);
    // The third of six frames has log seq 4; a client holding it must get the
    // remaining three, not a fixed "skip 3" slice.
    const replay = await replayAfter(socket, join(sessionId, { lastSeq: frames[2]!.seq }));
    assert.deepEqual(replay.ids, [frames[3]!.id, frames[4]!.id, frames[5]!.id]);
    socket.disconnect();
  });

  it("falls back to lastMessageId when the client sends no lastSeq", async () => {
    const sessionId = "ses_seq_id";
    const frames = seed(adapter!.store, sessionId);

    const socket = connect();
    await connected(socket);
    const replay = await replayAfter(socket, join(sessionId, { lastMessageId: frames[1]!.id }));
    assert.deepEqual(replay.ids, [frames[2]!.id, frames[3]!.id, frames[4]!.id, frames[5]!.id]);
    socket.disconnect();
  });

  it("replays nothing for an unknown session and everything for lastSeq=0", async () => {
    const socket = connect();
    await connected(socket);
    const empty = await replayAfter(socket, join("ses_seq_unknown"));
    assert.deepEqual(empty.ids, []);
    // An empty replay carries no seq to advance to.
    assert.equal(empty.seq, undefined);
    socket.disconnect();

    const sessionId = "ses_seq_zero";
    const frames = seed(adapter!.store, sessionId);
    const socket2 = connect();
    await connected(socket2);
    const all = await replayAfter(socket2, join(sessionId, { lastSeq: 0 }));
    assert.deepEqual(all.ids, frames.map((f) => f.id));
    assert.equal(all.seq, 7);
    socket2.disconnect();
  });

  it("lets a client advance its cursor, so a rejoin sends nothing twice", async () => {
    const sessionId = "ses_seq_live";
    const frames = seed(adapter!.store, sessionId);

    const socket = connect();
    await connected(socket);
    const replay = await replayAfter(socket, join(sessionId, { lastSeq: 4 }));
    assert.deepEqual(replay.ids, [frames[3]!.id, frames[4]!.id, frames[5]!.id]);
    assert.equal(replay.seq, 7);

    // A frame appended after the join takes the next log sequence.
    const live = envelope("evt_seq_live_extra", sessionId, "live");
    adapter!.store.appendEvent(sessionId, live);
    assert.equal(live.seq, 8);

    // The client that recorded seq 7 from the replay must now receive only the
    // frame appended afterwards — never the three it already has.
    const again = await replayAfter(socket, join(sessionId, { lastSeq: replay.seq }));
    assert.deepEqual(again.ids, [live.id]);
    assert.equal(again.seq, 8);
    socket.disconnect();
  });

  it("does not replay a session that was purged", async () => {
    const sessionId = "ses_seq_purge";
    seed(adapter!.store, sessionId);
    purgeSession(sessionId);

    const socket = connect();
    await connected(socket);
    assert.deepEqual((await replayAfter(socket, join(sessionId, { lastSeq: 0 }))).ids, []);
    socket.disconnect();
  });

  it("replays by sequence after a restart, when no frame id was ever seen", async () => {
    // This is the case a `lastMessageId` cursor cannot serve: the client knows
    // its seq but has no event id for it (e.g. it reloaded and lost its cache).
    const sessionId = "ses_seq_restart";
    seed(adapter!.store, sessionId);

    await adapter!.close();
    adapter = await startProtocolAdapter({
      cfg: { workspace: tmpDir } as never,
      runTask: async () => ({ taskId: "", text: "" }),
      getTask: () => undefined,
      port: 0,
    });

    const socket = connect();
    await connected(socket);
    const replay = await replayAfter(socket, join(sessionId, { lastSeq: 4 }));
    assert.deepEqual(replay.ids, [
      "evt_" + sessionId + "_4",
      "evt_" + sessionId + "_5",
      "evt_" + sessionId + "_6",
    ]);
    socket.disconnect();
  });
});
