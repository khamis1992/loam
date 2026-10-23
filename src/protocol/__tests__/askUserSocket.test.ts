/**
 * Protocol socket-bridge tests for Neo N9 (`ask_user`).
 *
 * The web ask-user card answers through the socket (`resolve_ask_user`), not the
 * HTTP route, so the live path is: a run emits `ask_user_required` → the protocol
 * maps it to an `askUserRequested` card event → the client answers → the socket
 * handler writes the decision into the pending store → the waiting `ask_user`
 * tool resumes. These tests drive a real `startProtocolAdapter` over socket.io,
 * mirroring `__tests__/run.ts`, and assert that bridge end to end.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";
import { io, type Socket as IoSocket } from "socket.io-client";

import { startProtocolAdapter, type ProtocolAdapter } from "../adapter.js";
import { handleAskUserRoutes } from "../../server/routes/askUser.js";
import { createAskUser, getAskUser, waitForAskUser } from "../../tools/askUserStore.js";
import type { RunTaskOptions } from "../../server/http.js";

const WORKSPACE = process.cwd();

/** A protocol event as delivered on the socket `message` envelope. */
interface AnyEvent {
  type: string;
  requestId?: string;
  source?: string;
  reasonCode?: string;
  result?: string;
  reviewer?: string;
  sender?: string;
  content?: string;
  deliveryKind?: string;
  [key: string]: unknown;
}

/** Extra fields a route handler needs from an `http.ServerResponse`. */
interface FakeRes {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
}

function cfg(): any {
  return {
    model: "test-model",
    fallbackModel: "",
    ollamaUrl: "http://127.0.0.1:11434",
    server: { host: "127.0.0.1", port: 3939 },
    agent: { maxSteps: 40, temperature: 0.2, requestTimeoutMs: 600000 },
    workspace: WORKSPACE,
    policy: { networkEnabled: false, allowOutsideWorkspaceRead: false, denyCommandPatterns: [], allowCommandPatterns: [], maxCommandSeconds: 180 },
    browser: { channel: "msedge", headless: true, viewport: { width: 1280, height: 800 } },
    computerUse: { enabled: false, screenshotDir: WORKSPACE },
    memory: { enabled: false, model: "", file: "", autoStore: false, recallTop: 3, minScore: 0.45, maxEntries: 0, dedupeThreshold: 0.97 },
    screen: { enabled: false, fps: 1, quality: 60, maxWidth: 1280 },
    vision: { enabled: false, maxImagesPerStep: 2 },
    selfImprove: { enabled: false, reviewEvery: 1, model: "", maxSteps: 10, writeApproval: false },
    evaluation: { enabled: false, intervalMinutes: 360, suite: "core", critique: false, keepRuns: 30, transcripts: true },
    selfPlay: { maxCases: 5 },
    orchestrator: { enabled: false, plannerModel: "", verifierModel: "", maxPlanSteps: 8, maxStepsPerWorker: 24, maxRevisionsPerStep: 1, maxReplans: 1, verifyFinal: true },
    mcpServers: {},
  };
}

const PROMPT = "refactor and optimize the codebase";

/** A run that raises one ask-user request and waits for the user's decision. */
const runTask = async (opts: RunTaskOptions): Promise<{ taskId: string; text: string }> => {
  const taskId = opts.taskId!;
  const emit = opts.emit;
  const request = createAskUser({
    taskId,
    title: "Before I start, I need one clarification",
    reason: "The request is short and open-ended, so the goal and the target are not pinned down.",
    questions: [{ id: "q1", prompt: "Which file or area should I focus on?", allowFile: true }],
    source: "auto",
    reasonCode: "vague",
  });
  emit({
    type: "ask_user_required",
    askUserId: request.id,
    taskId,
    tool: "ask_user",
    title: request.title,
    reason: request.reason,
    questions: request.questions,
    source: "auto",
    reasonCode: "vague",
  });
  const status = await waitForAskUser(request.id, undefined);
  const answer = getAskUser(request.id)?.answer;
  emit({
    type: "assistant_message",
    text: status === "answered" ? `answered: ${answer?.answers["q1"] ?? ""}` : `not answered (${status})`,
  });
  emit({ type: "done", text: "done", steps: 1, model: "test-model" });
  return { taskId, text: "done" };
};

function request(method: string, port: number, path: string, body?: unknown, token?: string): Promise<{ status: number; json: unknown; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string | number> = {};
    if (data) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(data);
    }
    if (token) headers.authorization = `Bearer ${token}`;
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : {}, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function postJson(port: number, path: string, body: unknown, token?: string): Promise<{ status: number; json: unknown }> {
  return request("POST", port, path, body, token).then((r) => ({ status: r.status, json: r.json }));
}

/** Mint a session token through the adapter's own login chain. */
async function loginChain(port: number): Promise<string> {
  const login = await request("GET", port, "/login?nonce=test-nonce&type=signIn");
  assert.equal(login.status, 302, `login redirect failed: ${login.status}`);
  const location = login.headers.location as string | undefined;
  assert.ok(location, "login redirect missing Location");
  const loginToken = new URLSearchParams(location.split("?")[1]).get("token");
  assert.ok(loginToken, "login redirect missing token");

  const gen = await postJson(port, "/user.v1.UserAuthService/GenerateTempAuthCode", {}, loginToken);
  assert.equal(gen.status, 200, `GenerateTempAuthCode failed: ${gen.status}`);
  const exch = await postJson(port, "/user.v1.UserAuthPublicService/ExchangeTokenByCode", { token: (gen.json as { token: string }).token });
  assert.equal(exch.status, 200, `ExchangeTokenByCode failed: ${exch.status}`);
  return (exch.json as { token: string }).token;
}

function connect(port: number, token: string): IoSocket {
  return io(`http://127.0.0.1:${port}`, {
    transports: ["websocket"],
    auth: { token },
    query: { locale: "en", tz: "UTC", clientType: "desktop", clientVersion: "0.0.1" },
  });
}

function waitForEvent(socket: IoSocket, predicate: (event: AnyEvent) => boolean, timeoutMs = 5000): Promise<AnyEvent> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for event")), timeoutMs);
    const onMessage = (m: any) => {
      if (m.type === "event" && predicate(m.event as AnyEvent)) {
        clearTimeout(t);
        socket.off("message", onMessage);
        resolve(m.event);
      }
    };
    socket.on("message", onMessage);
  });
}

/** Start the run by sending the user message that triggers it. */
function startRun(socket: IoSocket, sessionId: string): void {
  socket.emit("message", {
    type: "user_message",
    id: "msg-" + Date.now(),
    timestamp: Date.now(),
    sessionId,
    messageStatus: "pending",
    messageType: "text",
    taskMode: "standard",
    content: "",
    contents: [{ type: "text", value: PROMPT }],
    attachments: [],
    extData: { capabilities: { enabledAddons: [], connectorAccounts: [], enabledConnectors: [] } },
  });
}

/** Open a socket, join a session and wait for the replay ack. */
async function openSession(port: number, label: string): Promise<{ socket: IoSocket; sessionId: string; token: string }> {
  const token = await loginChain(port);
  const socket = connect(port, token);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  const sessionId = `sess_${label}_${Date.now()}`;
  socket.emit("message", { type: "join_session", id: "join-" + label, timestamp: Date.now(), sessionId, version: 2 });
  await waitForEvent(socket, (m) => m.type === "eventsNotifyEventsAfter");
  return { socket, sessionId, token };
}

describe("ask-user socket bridge (N9)", () => {
  let adapter: ProtocolAdapter | undefined;
  let port = 0;

  before(async () => {
    adapter = await startProtocolAdapter({ cfg: cfg(), runTask, getTask: () => undefined, port: 0 });
    port = adapter.port;
  });

  after(async () => {
    await adapter?.close();
  });

  it("delivers an ask-user card event and resumes the waiting run on the socket answer", async () => {
    const { socket, sessionId } = await openSession(port, "ask");
    try {
      startRun(socket, sessionId);

      // The run raises the ask-user request; the card event must reach the client.
      const card = await waitForEvent(socket, (m) => m.type === "askUserRequested");
      const requestId = card.requestId as string;
      assert.ok(requestId, "the card event must carry a request id");
      assert.equal(card.source, "auto");
      assert.equal(card.reasonCode, "vague");

      // The run resumes in the same tick as the socket decision, so the resumed
      // assistant message fires immediately; capture it before answering.
      const resolvedPromise = waitForEvent(socket, (m) => m.type === "askUserResolved");
      const assistantPromise = waitForEvent(socket, (m) => m.type === "chat" && m.sender === "assistant" && m.deliveryKind === "result");

      // The client answers through the socket, exactly as the web card does.
      socket.emit("message", {
        type: "resolve_ask_user",
        id: "resolve-" + Date.now(),
        timestamp: Date.now(),
        sessionId,
        requestId,
        decision: "answer",
        answer: {
          text: "Only the parser module.",
          answers: { q1: "src/parser.ts" },
          files: [{ path: `uploads/${requestId}/spec.pdf`, name: "spec.pdf", bytes: 12, contentType: "application/pdf" }],
        },
      });

      const resolved = await resolvedPromise;
      assert.equal(resolved.result, "answered");
      assert.equal(resolved.reviewer, "user");

      const stored = getAskUser(requestId);
      assert.equal(stored?.status, "answered");
      assert.equal(stored?.answer?.answers["q1"], "src/parser.ts");
      assert.deepEqual(
        stored?.answer?.files.map((f) => f.name),
        ["spec.pdf"],
      );

      // The run resumed and the answer reached the assistant text.
      const message = await assistantPromise;
      assert.match(message.content ?? "", /src\/parser\.ts/);
    } finally {
      socket.disconnect();
    }
  });

  it("dismisses the card through the socket and lets the run continue", async () => {
    const { socket, sessionId } = await openSession(port, "dismiss");
    try {
      startRun(socket, sessionId);
      const card = await waitForEvent(socket, (m) => m.type === "askUserRequested");
      const requestId = card.requestId as string;

      // Capture the resumed message before dismissing: the run continues in
      // the same tick as the socket decision.
      const resolvedPromise = waitForEvent(socket, (m) => m.type === "askUserResolved");
      const assistantPromise = waitForEvent(socket, (m) => m.type === "chat" && m.sender === "assistant" && m.deliveryKind === "result");

      socket.emit("message", {
        type: "resolve_ask_user",
        id: "resolve-" + Date.now(),
        timestamp: Date.now(),
        sessionId,
        requestId,
        decision: "dismiss",
      });

      const resolved = await resolvedPromise;
      assert.equal(resolved.result, "dismissed");
      assert.equal(getAskUser(requestId)?.status, "dismissed");

      const message = await assistantPromise;
      assert.match(message.content ?? "", /not answered/);
    } finally {
      socket.disconnect();
    }
  });

  it("answers through the HTTP route and still resumes the socket-waiting run", async () => {
    const { socket, sessionId } = await openSession(port, "route");
    try {
      startRun(socket, sessionId);
      const card = await waitForEvent(socket, (m) => m.type === "askUserRequested");
      const requestId = card.requestId as string;

      // The HTTP route is the other writer into the same pending store. The
      // adapter only proxies /api/* to the Loam server, so drive the route
      // handler in-process against fake req/res objects.
      const body = JSON.stringify({ text: "via the route", answers: { q1: "src/server" }, files: [] });
      const req = Object.assign(new Readable(), {
        method: "POST",
        url: `/api/ask-user/${requestId}/answer`,
        headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
      }) as unknown as http.IncomingMessage;
      const res: http.ServerResponse & FakeRes = {
        headersSent: false,
        statusCode: 0,
        headers: {} as Record<string, unknown>,
        body: "",
        writeHead(status: number, headers: Record<string, unknown>) {
          res.statusCode = status;
          Object.assign(res.headers, headers);
          return res as unknown as http.ServerResponse;
        },
        end(chunk?: string) {
          res.body = chunk ?? "";
          return res as unknown as http.ServerResponse;
        },
      } as unknown as http.ServerResponse & FakeRes;
      req.push(body);
      req.push(null);

      // The run resumes inside the route call, so capture the assistant message
      // before invoking the handler.
      const assistantPromise = waitForEvent(socket, (m) => m.type === "chat" && m.sender === "assistant" && m.deliveryKind === "result");

      const handled = await handleAskUserRoutes(req, res, `/api/ask-user/${requestId}/answer`);
      assert.equal(handled, true);
      assert.equal(res.statusCode, 200);
      const parsed = JSON.parse(res.body) as { request: { status: string } };
      assert.equal(parsed.request.status, "answered");

      const message = await assistantPromise;
      assert.match(message.content ?? "", /src\/server/);
    } finally {
      socket.disconnect();
    }
  });
});
