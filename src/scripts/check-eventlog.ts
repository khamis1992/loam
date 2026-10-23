/**
 * O7: end-to-end check for the durable append-only event log (BUILD_SPEC §0.6).
 *
 * The spec's definition of done is four observable properties, each proven here:
 *
 *  (a) UPDATE or DELETE on `session_events` throws — the log is append-only.
 *  (b) A kill -9 mid-run loses no committed event. A child process appends
 *      events and records its committed high-water mark; this parent kills it
 *      with `taskkill /F /PID` (Windows) or `SIGKILL` (POSIX) and then reads the
 *      log back, proving every committed event survived the hard kill.
 *  (c) A socket reconnect with `lastSeq` replays exactly the missing events, in
 *      order, and nothing the client already has.
 *  (d) An interrupted run resumes from its last durable worker checkpoint without
 *      re-running completed tool calls, and a tool that started without a terminal
 *      event makes resume require explicit confirmation.
 *
 * No model API is contacted: every agent-facing call uses a fixture client, so
 * the check is deterministic and offline.
 *
 * The child process is the ONLY process this script kills, and only the one it
 * spawned itself (BUILD_SPEC §12).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { io, type Socket as IoSocket } from "socket.io-client";

import type { Config } from "../config.js";
import type { ChatOptions, ChatResult, OllamaClient } from "../ollama.js";
import type { ExecutionCheckpoint, WorkerCheckpoint } from "../agent/checkpoint.js";
import type { RunTaskOptions } from "../server/http.js";
import type { Task } from "../server/db.js";
import type { ClientMessage, ServerEnvelope } from "../protocol/types.js";
import type { Plan } from "../agent/planner.js";

/**
 * The data directory is resolved before any import, because `dataDir()` reads the
 * environment on first use. The child inherits this directory and must not
 * re-create it: a second `mkdtempSync` would send it to a different file, and the
 * parent would then be reading a database the writer never touched.
 */
const dataDir = process.env.LOAM_DATA_DIR ?? process.env.MANUS_LOCAL_DATA_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "loam-eventlog-"));
process.env.LOAM_DATA_DIR = dataDir;
process.env.MANUS_LOCAL_DATA_DIR = dataDir;
fs.mkdirSync(dataDir, { recursive: true });

// ---------------------------------------------------------------------------
// Child mode: the kill -9 durability target. Appends events one at a time and
// records the committed high-water mark after each append, so the parent can
// prove nothing it reported was lost when the process is killed.
// ---------------------------------------------------------------------------
const childMode = process.argv.indexOf("--child");
if (childMode >= 0) {
  const sessionId = process.argv[childMode + 1]!;
  const markerPath = process.argv[childMode + 2]!;
  const total = Number(process.argv[childMode + 3] ?? 50);
  const { append } = await import("../protocol/eventLog.js");
  for (let i = 1; i <= total; i++) {
    append(sessionId, "chat_event", { i, note: "child" }, { idempotencyKey: `child:${sessionId}:${i}` });
    fs.writeFileSync(markerPath, JSON.stringify({ sessionId, committed: i }));
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  process.exit(0);
}

/** Kill only this child process. Windows has no SIGKILL, so use taskkill /F. */
function killChild(pid: number): void {
  if (process.platform === "win32") {
    spawn("taskkill", ["/F", "/PID", String(pid)], { windowsHide: true, stdio: "ignore" });
  } else {
    process.kill(pid, "SIGKILL");
  }
}


async function checkBKillDurability(): Promise<string> {
  const { after, headSeq } = await import("../protocol/eventLog.js");
  const { database } = await import("../server/sqliteStore.js");
  const sessionId = "ses_eventlog_kill";
  const markerPath = path.join(dataDir, "committed.json");
  // Open the database here so the file exists before the writer is spawned; the
  // child then appends to the same file this process reads back. WAL means this
  // connection sees the child's committed rows without reopening.
  const db = database();
  assert.ok(String(db.location() ?? "").endsWith("manus.db"), `unexpected database location ${db.location()}`);
  const total = 60;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), "--child", sessionId, markerPath, String(total)],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
  );
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});

  // Wait until the child reports at least 8 committed events, so the kill lands
  // in the middle of the run rather than before it starts.
  const deadline = Date.now() + 20_000;
  let committed = 0;
  while (Date.now() < deadline) {
    try {
      committed = Number((JSON.parse(fs.readFileSync(markerPath, "utf8")) as { committed: number }).committed);
    } catch {
      committed = 0;
    }
    if (committed >= 8) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(committed >= 8, "child never reported a committed event");

  killChild(child.pid!);
  const exit = await new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  assert.notEqual(exit, 0, "the child must be killed mid-run, not exit on its own");

  // The marker may lag the log by one append; read the final high-water mark.
  const reported = Number((JSON.parse(fs.readFileSync(markerPath, "utf8")) as { committed: number }).committed);

  // The parent is a separate process from the writer, so this read proves the
  // child's committed writes survived the child's death.
  const events = after(sessionId, 0, 5000);
  const seqs = events.map((e) => e.seq);
  const head = headSeq(sessionId);
  assert.equal(seqs.length, head, "every committed seq 1..N must be present");
  assert.deepEqual(
    seqs,
    Array.from({ length: head }, (_, i) => i + 1),
    "sequence numbers must be gap-free and 1-based",
  );
  assert.ok(head >= reported, `log head ${head} must cover the ${reported} reported committed events`);
  for (const event of events) {
    assert.deepEqual(event.payload, { i: event.seq, note: "child" }, `seq ${event.seq} payload must match`);
  }
  return `kill -9 after ${reported} committed events: head ${head}, all ${head} rows intact and gap-free`;
}

async function checkAImmutability(): Promise<string> {
  const { after } = await import("../protocol/eventLog.js");
  const { database } = await import("../server/sqliteStore.js");
  // A session that already has rows: the kill test's child session.
  const sessionId = "ses_eventlog_kill";
  const events = after(sessionId, 0, 5000);
  assert.ok(events.length > 0, "expected the kill test to leave rows in the log");
  const before = events[0]!;
  assert.deepEqual(before.payload, { i: 1, note: "child" });

  const db = database();
  assert.throws(
    () => db.prepare("UPDATE session_events SET payload='{}' WHERE session_id=?").run(sessionId),
    /immutable/,
    "UPDATE on session_events must be rejected",
  );
  assert.throws(
    () => db.prepare("DELETE FROM session_events WHERE session_id=?").run(sessionId),
    /immutable/,
    "DELETE on session_events must be rejected",
  );
  // The failed writes must not have touched the row.
  const afterAttempt = after(sessionId, 0, 5000);
  assert.equal(afterAttempt.length, events.length, "a rejected UPDATE/DELETE must not change the row count");
  assert.deepEqual(afterAttempt[0]!.payload, before.payload, "a rejected UPDATE must not change the payload");
  return `${events.length} rows unchanged after rejected UPDATE and DELETE`;
}

/** The adapter's dev login chain, performed the way a real client does it. */
function request(port: number, method: string, p: string, body?: unknown, token?: string): Promise<{ status: number; json: any; headers: Record<string, string | string[] | undefined> }> {
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

async function loginChain(port: number): Promise<string> {
  const login = await request(port, "GET", "/login?nonce=eventlog&type=signIn");
  assert.equal(login.status, 302, "login redirect expected");
  const loginToken = new URLSearchParams(String(login.headers.location ?? "").split("?")[1] ?? "").get("token");
  assert.ok(loginToken, "login redirect missing token");
  const gen = await request(port, "POST", "/user.v1.UserAuthService/GenerateTempAuthCode", {}, loginToken);
  assert.equal(gen.status, 200, "GenerateTempAuthCode expected 200");
  const exch = await request(port, "POST", "/user.v1.UserAuthPublicService/ExchangeTokenByCode", { token: gen.json.token });
  assert.equal(exch.status, 200, "ExchangeTokenByCode expected 200");
  return String(exch.json.token);
}

async function checkCSocketReplay(): Promise<string> {
  const { startProtocolAdapter } = await import("../protocol/adapter.js");
  const adapter = await startProtocolAdapter({
    cfg: { workspace: dataDir } as unknown as Config,
    runTask: async (opts: RunTaskOptions) => ({ taskId: opts.taskId ?? "", text: "" }),
    getTask: (): Task | undefined => undefined,
    port: 0,
  });
  try {
    const token = await loginChain(adapter.port);
    const sessionId = "ses_eventlog_replay";

    // Six chat frames. `ensureSession` writes one `status` row first, so the
    // frames carry durable log sequences 2..7.
    adapter.store.ensureSession(sessionId, "task_" + sessionId, "Event log");
    const frames: ServerEnvelope[] = [];
    for (let i = 1; i <= 6; i++) {
      const frame: ServerEnvelope = {
        id: `evt_${sessionId}_${i}`,
        type: "event",
        sessionId,
        timestamp: 1_700_000_000_000,
        event: {
          id: `evt_${sessionId}_${i}`,
          type: "chat",
          timestamp: 1_700_000_000_000,
          sender: "assistant",
          messageType: "text",
          content: `frame ${i}`,
          attachments: [],
        },
      };
      adapter.store.appendEvent(sessionId, frame);
      frames.push(frame);
    }
    assert.deepEqual(frames.map((f) => f.seq), [2, 3, 4, 5, 6, 7]);

    const socket: IoSocket = io(`http://127.0.0.1:${adapter.port}`, {
      transports: ["websocket"],
      auth: { token },
      query: { locale: "en", tz: "UTC", clientType: "desktop", clientVersion: "0.0.0" },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    });

    const replayAfter = (lastSeq: number): Promise<{ seq?: number; ids: string[] }> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout waiting for replay frame")), 5000);
        const onMessage = (msg: ServerEnvelope) => {
          if (msg.type !== "event" || msg.event.type !== "eventsNotifyEventsAfter") return;
          clearTimeout(timer);
          socket.off("message", onMessage);
          const events = (msg.event as unknown as { events?: Array<{ id?: string }> }).events ?? [];
          resolve({ seq: msg.seq, ids: events.map((e) => String(e.id ?? "")) });
        };
        socket.on("message", onMessage);
        const join = {
          type: "join_session",
          id: "join-" + Math.random().toString(36).slice(2),
          timestamp: Date.now(),
          sessionId,
          version: 2,
          lastSeq,
        } as ClientMessage;
        socket.emit("message", join);
      });

    // The client holds the third frame (seq 4): it must receive only 5, 6, 7.
    const replay = await replayAfter(frames[2]!.seq!);
    assert.deepEqual(replay.ids, [frames[3]!.id, frames[4]!.id, frames[5]!.id], "lastSeq must replay exactly the missing frames");
    assert.equal(replay.seq, frames[5]!.seq, "the replay frame must report the highest seq it delivered");

    // A client that recorded that seq gets nothing back, so a rejoin never
    // delivers an event twice.
    const again = await replayAfter(replay.seq!);
    assert.deepEqual(again.ids, [], "a rejoin past the cursor must replay nothing");
    socket.disconnect();
    return `lastSeq=${frames[2]!.seq} replayed frames 4,5,6 (seq 5,6,7) and a rejoin at ${replay.seq} replayed nothing`;
  } finally {
    await adapter.close();
  }
}

async function checkDCheckpointResume(): Promise<string> {
  const { runAgent } = await import("../agent/loop.js");
  const { ToolRegistry } = await import("../tools/registry.js");
  const { loadConfig } = await import("../config.js");
  const { writeCheckpoint, readLatestCheckpoint, recordToolCall, recordToolResult, hasUnfinishedToolCall } = await import("../agent/checkpointLog.js");
  const { requiresReplayConfirmation } = await import("../server/recovery.js");

  const cfg = loadConfig();
  cfg.workspace = dataDir;
  cfg.model = "fixture";
  cfg.fallbackModel = "fixture";
  // Keep the run offline and deterministic: no coding router, no compression,
  // no vision, no edit audit.
  cfg.coding = { enabled: false, chain: [], logEdits: false };
  cfg.compression = { ...cfg.compression, enabled: false };
  cfg.vision = { ...cfg.vision, enabled: false };

  const session = "ses_eventlog_checkpoint";
  const usage = { promptTokens: 11, completionTokens: 7, durationMs: 13 };
  let writes = 0;
  let saved: WorkerCheckpoint | undefined;
  let boundary: WorkerCheckpoint | undefined;
  let phase: "first" | "resume" = "first";

  // The tool call is a real effect: it must not run twice across a resume.
  const tools = new ToolRegistry();
  tools.register({
    name: "file_write",
    description: "fixture effect",
    parameters: { type: "object", properties: {} },
    run: async () => {
      assert.equal(saved, undefined, "invalidate the stale safe boundary before a new effect");
      writes++;
      return { ok: true, content: `effect ${writes}` };
    },
  });

  const resultFor = (): ChatResult =>
    phase === "resume"
      ? { model: "fixture", content: "Observed saved effect", toolCalls: [], usage }
      : { model: "fixture", content: "", toolCalls: [{ function: { name: "file_write", arguments: {} } }], usage };
  const client = {
    chat: async (_o: ChatOptions) => resultFor(),
  } as unknown as OllamaClient;

  const options = {
    cfg,
    tools,
    ollama: client,
    systemOverride: "fixture system",
    prompt: "Append once",
    suppressFinal: true,
    emit: () => {},
    maxSteps: 3,
    eventLogSession: session,
    saveWorker: (value: WorkerCheckpoint | undefined) => {
      saved = value;
      if (value) {
        boundary = JSON.parse(JSON.stringify(value)) as WorkerCheckpoint;
        // Simulate the interruption: the durable boundary exists, the process dies.
        throw new Error("simulated crash after durable boundary");
      }
    },
  };

  // First run: one real effect, then the interruption.
  await assert.rejects(runAgent(options), /simulated crash/);
  assert.equal(writes, 1, "the interrupted run must have produced its effect exactly once");

  // The checkpoint event is durable and readable back, unchanged.
  const cp: ExecutionCheckpoint = {
    version: 1,
    plan: { goal: "append once", trivial: false, steps: [{ id: "s1", title: "append", instruction: "append once", successCriteria: "one append" }], source: "fallback" } as Plan,
    nextStep: 1,
    completed: [],
    lastText: "",
    trace: [],
    round: 1,
    usage,
    totalSteps: 1,
    model: "fixture",
    inFlight: false,
    complete: false,
    finalRepairUsed: false,
  };
  const cpSeq = writeCheckpoint(session, cp, session);
  const read = readLatestCheckpoint(session);
  assert.ok(read, "the checkpoint event must be readable back");
  assert.equal(read.seq, cpSeq, "the read checkpoint must be the one just written");
  assert.deepEqual(read.cp, cp, "the read checkpoint must round-trip unchanged");

  // A tool that started without a terminal event is in flight, so resume needs
  // explicit confirmation instead of silently re-running it.
  recordToolCall(session, "call_open", "file_write", session);
  assert.equal(hasUnfinishedToolCall(session), true, "a started call without a terminal event is in flight");
  const run = {
    prompt: "Append once",
    effectivePrompt: "Append once",
    history: [],
    workspace: dataDir,
    orchestrated: true,
    started: true,
    checkpoint: { ...cp, logSessionId: session },
  };
  assert.equal(requiresReplayConfirmation(run), true, "an in-flight tool call must require replay confirmation");
  recordToolResult(session, "call_open", "file_write", "succeeded", "ok", session);
  assert.equal(hasUnfinishedToolCall(session), false, "a terminal event closes the call");
  assert.equal(requiresReplayConfirmation(run), false, "a closed call resumes without confirmation");

  // Resume from the durable boundary: the completed tool call must not re-run.
  phase = "resume";
  const result = await runAgent({ ...options, resumeWorker: boundary });
  assert.equal(writes, 1, "resume must not re-run the completed tool call");
  assert.equal(result.steps, 2, "the resumed run continues past the interrupted step");
  assert.ok(
    result.messages.some((m) => m.role === "tool" && m.content === "effect 1"),
    "the resumed run must retain the earlier tool result",
  );
  return `checkpoint event round-tripped at seq ${cpSeq}; resume kept effect 1 (writes=${writes}) and continued at step 2`;
}

const checks: Array<{ name: string; label: string; run: () => Promise<string> }> = [
  { name: "a", label: "immutability", run: checkAImmutability },
  { name: "b", label: "kill -9 durability", run: checkBKillDurability },
  { name: "c", label: "lastSeq replay", run: checkCSocketReplay },
  { name: "d", label: "checkpoint resume", run: checkDCheckpointResume },
];

// (b) runs first: it is the only check that must read the log before this
// process has opened its own connection, so the writer and the reader are
// provably different processes.
const order = ["b", "a", "c", "d"];
const details: string[] = [];
for (const key of order) {
  const check = checks.find((c) => c.name === key)!;
  const detail = await check.run();
  details.push(`(${check.name}) ${check.label}: ${detail}`);
  console.log(`PASS (${check.name}) ${check.label} — ${detail}`);
}

console.log(`PASS event log e2e check: ${details.join("; ")}`);
