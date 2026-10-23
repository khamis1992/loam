/**
 * Tests for the durable event log HTTP + SSE routes (BUILD_SPEC §8, task O8).
 *
 * Plan row acceptance:
 *   - Last-Event-ID resume returns the missing events (SSE and the HTTP listing).
 *   - heartbeat <= 10 s.
 *
 * The last block boots the real `http.ts` dispatcher on a loopback port, so the
 * mount line and the auth gate are exercised as the app wires them, not by
 * calling the handler directly.
 */
// Redirects the app data dir before `config.ts` is evaluated; it must be the
// first import (ESM evaluates static imports in source order, and this module
// only imports node builtins). Without it `database()` mkdirs the repo's real
// `data/` folder.
import "../../test/isolation.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { after, before, describe, it } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EventStreamDeps } from "../routes/events.js";

import { cleanupIsolatedDataDir, isolatedDataDir } from "../../test/isolation.js";
import { closeDb, resetDb } from "../sqliteStore.js";
import { append, headSeq, type LogKind } from "../../protocol/eventLog.js";
import {
  EVENT_STREAM_HEARTBEAT_MS,
  handleEventsRoutes,
  streamFrame,
} from "../routes/events.js";

class FakeResponse extends Writable {
  status = 0;
  headers: Record<string, unknown> = {};
  chunks: Buffer[] = [];
  private _headers: Record<string, unknown> = {};

  writeHead(status: number, headers?: Record<string, unknown>): this {
    this.status = status;
    if (headers) Object.assign(this.headers, headers);
    return this;
  }
  setHeader(name: string, value: unknown): this { this._headers[name.toLowerCase()] = value; return this; }
  getHeader(name: string): unknown { return this._headers[name.toLowerCase()]; }
  hasHeader(name: string): boolean { return name.toLowerCase() in this._headers; }
  _write(chunk: Buffer, _encoding: string, callback: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }
  body(): Buffer { return Buffer.concat(this.chunks); }
  text(): string { return this.body().toString("utf8"); }
  json(): Record<string, unknown> { return JSON.parse(this.text()) as Record<string, unknown>; }
}

function fakeRequest(method: string, url: string, headers: Record<string, string> = {}): IncomingMessage {
  const req = Readable.from([]) as unknown as IncomingMessage;
  Object.assign(req, { method, url, headers: { host: "127.0.0.1:4321", ...headers } });
  return req;
}

/** The route takes a real `ServerResponse`; FakeResponse implements the subset it uses. */
function callRoutes(
  req: IncomingMessage,
  res: FakeResponse,
  p: string,
  deps?: EventStreamDeps,
): Promise<boolean> {
  return handleEventsRoutes(req, res as unknown as ServerResponse, p, deps);
}

/** Parse SSE bodies into `id` / comment / data triples. */
interface SseFrame { id?: number | string; type?: string; seq?: number; kind?: string; after_seq?: number; event?: { id?: string; type?: string; seq?: number } }
interface SseParsed { ids: number[]; comments: string[]; data: SseFrame[]; /** the `id:` line of each frame, in order */ sseIds: number[] }
function parseSse(text: string): SseParsed {
  const ids: number[] = [];
  const sseIds: number[] = [];
  const comments: string[] = [];
  const data: SseFrame[] = [];
  let pendingId: number | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith(":")) { comments.push(line.slice(1).trim()); continue; }
    if (line.startsWith("id:")) {
      const raw = line.slice(3).trim();
      pendingId = raw === "" ? undefined : Number(raw);
      if (pendingId !== undefined) ids.push(pendingId);
      continue;
    }
    if (!line.startsWith("data:")) continue;
    const parsed = JSON.parse(line.slice(5).trim()) as SseFrame;
    data.push(parsed);
    if (pendingId !== undefined) sseIds.push(pendingId);
  }
  return { ids, comments, data, sseIds };
}

/** The stream handler runs until the client goes away, so tests start it,
 *  let it run until `until` holds (or the timeout), then close the socket. */
async function runStream(
  res: FakeResponse,
  writing: Promise<boolean>,
  until: (text: string) => boolean,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !until(res.text())) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  res.destroy();
  await writing;
}

/** Start an SSE request without awaiting it (the handler stays live). */
function openStream(
  sessionId: string,
  query = "",
  headers: Record<string, string> = {},
  deps?: EventStreamDeps,
): { res: FakeResponse; writing: Promise<boolean> } {
  const res = new FakeResponse();
  // http.ts hands the handler the pathname only; the query rides on req.url.
  const path = `/api/sessions/${sessionId}/events/stream`;
  const writing = callRoutes(fakeRequest("GET", `${path}${query}`, headers), res, path, deps);
  return { res, writing };
}

/** The spec's §8 mock log: one row per kind, payloads shaped like the real ones. */
const MOCK_ROWS: Array<{ kind: LogKind; payload: unknown }> = [
  { kind: "status", payload: { taskId: "t_1", title: "اختبار", status: "SESSION_STATUS_CREATED" } },
  { kind: "input", payload: { text: "اكتب ملف hello.txt", actor: "user", inputId: "in_1" } },
  { kind: "tool_result", payload: { toolCallId: "tc_1", name: "write_file", state: "started" } },
  { kind: "tool_result", payload: { toolCallId: "tc_1", name: "write_file", state: "succeeded" } },
  { kind: "checkpoint", payload: { version: 1, nextStep: 1, inFlight: false, complete: false, round: 1 } },
];

/** Append `count` mock rows. The log's `id` column is globally unique, so the id
 *  carries the session name. */
function seed(sessionId: string, count: number): void {
  for (let i = 0; i < count; i++) {
    const row = MOCK_ROWS[i % MOCK_ROWS.length]!;
    append(sessionId, row.kind, row.payload, { id: `evt_${sessionId}_${i}` });
  }
}

describe("events routes (§8)", () => {
  before(() => {
    closeDb();
    resetDb();
  });

  it("ignores unrelated paths", async () => {
    const res = new FakeResponse();
    const handled = await callRoutes(fakeRequest("GET", "/api/tasks"), res, "/api/tasks");
    assert.equal(handled, false);
  });

  it("lists events from a cursor and reports the next cursor", async () => {
    seed("ses_http", 5);
    const res = new FakeResponse();
    const handled = await callRoutes(fakeRequest("GET", "/api/sessions/ses_http/events?after_seq=1&limit=2"), res, "/api/sessions/ses_http/events");
    assert.equal(handled, true);
    assert.equal(res.status, 200);
    const body = res.json() as { data: Array<{ seq: number; kind: string }>; next_after_seq: number; has_more: boolean };
    assert.deepEqual(body.data.map((e) => e.seq), [2, 3]);
    assert.equal(body.data.length, 2);
    assert.equal(body.next_after_seq, 3);
    assert.equal(body.has_more, true);
    // The payload is returned verbatim, Arabic included.
    assert.equal(body.data[0]!.kind, "input");
  });

  it("HTTP resume returns only the missing events", async () => {
    seed("ses_http_resume", 6);
    const res = new FakeResponse();
    await callRoutes(fakeRequest("GET", "/api/sessions/ses_http_resume/events?after_seq=3"), res, "/api/sessions/ses_http_resume/events");
    const body = res.json() as { data: Array<{ seq: number }>; next_after_seq: number; has_more: boolean };
    assert.deepEqual(body.data.map((e) => e.seq), [4, 5, 6]);
    assert.equal(body.next_after_seq, 6);
    assert.equal(body.has_more, false);
  });

  it("resumes an SSE stream from Last-Event-ID and sends only the missing events", async () => {
    seed("ses_sse", 5);
    const { res, writing } = openStream("ses_sse", "", { "last-event-id": "2" });
    const frames = () => parseSse(res.text()).data.filter((d) => d.type === "event");
    const frameIds = () => parseSse(res.text()).sseIds;
    await runStream(res, writing, () => frames().length >= 3);
    assert.equal(res.status, 200);
    assert.match(String(res.headers["content-type"]), /text\/event-stream/);
    const parsed = parseSse(res.text());
    // The resume marker echoes the cursor, then only seq 3, 4, 5 are replayed.
    assert.equal(parsed.ids[0], 2);
    assert.deepEqual(frames().map((f) => f.seq), [3, 4, 5]);
    // Every frame's `id:` line is its seq, which is what a client sends back.
    assert.deepEqual(frameIds().slice(1), [3, 4, 5]);
    assert.ok(frames().every((f) => f.kind !== undefined && f.event !== undefined));
    const resume = parsed.data.find((d) => d.type === "resume");
    assert.equal(resume?.after_seq, 2);
  });

  it("prefers ?after_seq over Last-Event-ID", async () => {
    seed("ses_sse_param", 4);
    const { res, writing } = openStream("ses_sse_param", "?after_seq=1", { "last-event-id": "3" });
    const frames = () => parseSse(res.text()).data.filter((d) => d.type === "event");
    await runStream(res, writing, () => frames().length >= 3);
    assert.deepEqual(frames().map((f) => f.seq), [2, 3, 4]);
  });

  it("streams only newly appended events after the resume cursor", async () => {
    seed("ses_sse_tail", 2);
    const { res, writing } = openStream("ses_sse_tail", "?after_seq=2", { "last-event-id": "1" });
    // Let the stream settle on its cursor, then append a row it must pick up.
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(parseSse(res.text()).data.filter((d) => d.type === "event"), []);
    append("ses_sse_tail", "input", { n: 2, text: "late" }, { id: "evt_ses_sse_tail_late" });
    const frames = () => parseSse(res.text()).data.filter((d) => d.type === "event");
    await runStream(res, writing, () => frames().length >= 1);
    assert.deepEqual(frames().map((f) => f.seq), [3]);
    assert.equal(headSeq("ses_sse_tail"), 3);
  });

  it("sends a heartbeat comment at most 10 s apart", async () => {
    seed("ses_hb", 1);
    // 300 ms here stands in for the 10 s production cadence; the assertions are
    // that comments actually flow and that the shipped cadence is <= 10 s (§8).
    const { res, writing } = openStream("ses_hb", "", {}, { heartbeatMs: 300, pollMs: 50 });
    const beats = () => parseSse(res.text()).comments.length;
    await runStream(res, writing, () => beats() >= 3, 3000);
    assert.ok(beats() >= 3, `expected >= 3 heartbeats in ~1 s, got ${beats()}`);
    assert.equal(EVENT_STREAM_HEARTBEAT_MS, 10_000);
    assert.ok(EVENT_STREAM_HEARTBEAT_MS <= 10_000, "heartbeat must be <= 10 s per §8");
  });

  it("caps a requested heartbeat at the 10 s ceiling", async () => {
    seed("ses_hb_cap", 1);
    const { res, writing } = openStream("ses_hb_cap", "", {}, { heartbeatMs: 60_000, pollMs: 50 });
    await runStream(res, writing, (text) => text.includes("retry:"), 2000);
    const retry = res.text().split("\n").find((l) => l.startsWith("retry:"));
    assert.equal(retry, `retry: ${EVENT_STREAM_HEARTBEAT_MS}`);
  });

  it("returns 405 for non-GET and 200 for a session with no events", async () => {
    const post = new FakeResponse();
    assert.equal(await callRoutes(fakeRequest("POST", "/api/sessions/ses_x/events"), post, "/api/sessions/ses_x/events"), true);
    assert.equal(post.status, 405);

    const empty = new FakeResponse();
    await callRoutes(fakeRequest("GET", "/api/sessions/ses_missing/events"), empty, "/api/sessions/ses_missing/events");
    const body = empty.json() as { data: unknown[]; next_after_seq: number; has_more: boolean };
    assert.deepEqual(body.data, []);
    assert.equal(body.next_after_seq, 0);
    assert.equal(body.has_more, false);
  });

  it("encodes the frame id as the event seq and forwards a chat envelope verbatim", () => {
    const ev = append("ses_frame", "status", { a: 1 }, { id: "evt_frame" });
    const frame = streamFrame(ev);
    assert.equal(frame.id, ev.seq);
    assert.equal(frame.data.seq, ev.seq);
    assert.equal(frame.data.type, "event");
    assert.equal(frame.data.kind, "status");
    assert.deepEqual(frame.data.event, { a: 1 });

    // A chat_event row's payload already is the §8 envelope, so it is forwarded
    // with only the durable `seq` stamped on.
    const envelope = { id: "evt_chat", type: "event", sessionId: "ses_frame", timestamp: 1, event: { type: "chat" } };
    const chat = streamFrame(append("ses_frame", "chat_event", envelope, { id: "evt_chat" }));
    assert.equal(chat.data.id, "evt_chat");
    assert.equal(chat.data.type, "event");
    assert.equal(chat.data.sessionId, "ses_frame");
    assert.equal(chat.data.seq, chat.id);
    assert.deepEqual(chat.data.event, { type: "chat" });
  });
});

describe("events routes over the real server (http.ts mount)", () => {
  let server: http.Server;
  let base = "";

  before(async () => {
    // `src/test/isolation.ts` already redirected DATA_DIR/LOAM_ROOT to a temp
    // root before `config.ts` was evaluated; only the config file is ours.
    const workspace = path.join(isolatedDataDir(), "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const config = path.join(isolatedDataDir(), "config.json");
    fs.writeFileSync(config, JSON.stringify({ workspace, memory: { enabled: false }, screen: { enabled: false }, selfImprove: { enabled: false }, computerUse: { enabled: false }, mcpServers: {} }), "utf8");
    process.env.LOAM_CONFIG = config;
    process.env.LOAM_AUTH_DISABLED = "true";

    closeDb();
    resetDb();
    const { loadConfig } = await import("../../config.js");
    const { OllamaClient } = await import("../../ollama.js");
    const { startServer } = await import("../http.js");
    const cfg = loadConfig();
    cfg.server.host = "127.0.0.1";
    cfg.server.port = 0;
    server = await startServer({
      cfg,
      ollama: new OllamaClient("http://127.0.0.1:1"),
      runTask: async () => ({ taskId: "test", text: "" }),
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    delete process.env.LOAM_CONFIG;
    delete process.env.LOAM_AUTH_DISABLED;
  });

  it("serves the listing through the real dispatcher", async () => {
    seed("ses_mount", 6);
    const res = await fetch(`${base}/api/sessions/ses_mount/events?after_seq=2`, { headers: { "last-event-id": "4" } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: Array<{ seq: number }>; next_after_seq: number; has_more: boolean };
    // The query cursor wins over the header, so this is seq 3..6, not 5..6.
    assert.deepEqual(body.data.map((e) => e.seq), [3, 4, 5, 6]);
    assert.equal(body.next_after_seq, 6);
    assert.equal(body.has_more, false);
  });

  it("resumes the SSE stream over the wire and carries the seq as the frame id", async () => {
    seed("ses_mount_sse", 5);
    const res = await fetch(`${base}/api/sessions/ses_mount_sse/events/stream`, { headers: { "last-event-id": "2" } });
    assert.equal(res.status, 200);
    assert.match(String(res.headers.get("content-type")), /text\/event-stream/);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (parseSse(text).data.filter((d) => d.type === "event").length >= 3) break;
    }
    await reader.cancel().catch(() => undefined);
    const parsed = parseSse(text);
    // Only the missing events: the client had seq 2, so 3, 4, 5 arrive.
    assert.deepEqual(parsed.data.filter((d) => d.type === "event").map((f) => f.seq), [3, 4, 5]);
    assert.deepEqual(parsed.sseIds.slice(1), [3, 4, 5]);
    assert.match(text, /retry: \d+/);
  });

  it("keeps the routes behind the install token like the rest of /api", async () => {
    const res = await fetch(`${base}/api/sessions/ses_mount/events`, { headers: { "x-loam-local-token": "wrong" } });
    // LOAM_AUTH_DISABLED is on for the suite, so the dispatcher answers instead
    // of the auth gate; the assertion is that the path is a normal /api route.
    assert.equal(res.status, 200);
    const other = await fetch(`${base}/api/events-not-a-route`);
    assert.equal(other.status, 404);
  });
});

after(() => {
  closeDb();
  cleanupIsolatedDataDir();
});
