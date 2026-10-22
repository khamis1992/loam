/** A1 protocol adapter integration tests.
 *
 *  Verifies §9.2 (send task + stream events) and §9.3 (reconnect/replay)
 *  against the protocol adapter with a fake Loam runTask. */

import http from "node:http";
import { io, type Socket as IoSocket } from "socket.io-client";
import { startProtocolAdapter, type ProtocolAdapter } from "../adapter.js";
import type { RunTaskOptions } from "../../server/http.js";
import type { Task } from "../../server/db.js";
import type { AgentEvent, Emit } from "../../agent/events.js";
import type { ClientMessage, ServerEnvelope, ServerMessage } from "../types.js";

let adapterPort = 0;

function cfg(): any {
  return {
    model: "test-model",
    fallbackModel: "",
    ollamaUrl: "http://127.0.0.1:11434",
    server: { host: "127.0.0.1", port: 3939 },
    agent: { maxSteps: 40, temperature: 0.2, requestTimeoutMs: 600000 },
    workspace: process.cwd(),
    policy: { networkEnabled: false, allowOutsideWorkspaceRead: false, denyCommandPatterns: [], allowCommandPatterns: [], maxCommandSeconds: 180 },
    browser: { channel: "msedge", headless: true, viewport: { width: 1280, height: 800 } },
    computerUse: { enabled: false, screenshotDir: process.cwd() },
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function request(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: unknown; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: adapterPort,
        path,
        method,
        headers: {
          ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
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

function postJson(path: string, body: unknown, token?: string): Promise<{ status: number; json: unknown }> {
  return request("POST", path, body, token).then((r) => ({ status: r.status, json: r.json }));
}

function getJson(path: string, token?: string): Promise<{ status: number; json: unknown }> {
  return request("GET", path, undefined, token).then((r) => ({ status: r.status, json: r.json }));
}

class FakeDb {
  private tasks = new Map<string, Task>();
  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }
  seed(id: string, prompt: string): void {
    this.tasks.set(id, {
      id,
      title: prompt.slice(0, 80),
      prompt,
      status: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
      steps: [],
    });
  }
}

let adapter: ProtocolAdapter | undefined;
let token: string | undefined;

async function setup(): Promise<{ runTask: (opts: RunTaskOptions) => Promise<{ taskId: string; text: string }>; fakeDb: FakeDb }> {
  const fakeDb = new FakeDb();
  const eventsLog: AgentEvent[] = [];

  const runTask = async (opts: RunTaskOptions): Promise<{ taskId: string; text: string }> => {
    fakeDb.seed(opts.taskId!, opts.prompt);
    const emit = opts.emit as Emit;
    emit({ type: "task-status", status: "running" });
    emit({ type: "plan", goal: opts.prompt, trivial: false, steps: [{ id: "step-1", title: "Working", instruction: "", successCriteria: "" }], source: "model" });
    emit({ type: "plan_step", id: "step-1", index: 0, total: 1, title: "Working", phase: "start" });
    emit({ type: "tool_call", name: "shell_run", args: { command: "echo hello" } });
    emit({ type: "tool_result", name: "shell_run", ok: true, summary: "hello\n" });
    emit({ type: "assistant_token", text: "Done" });
    emit({ type: "assistant_message", text: "Done. You asked: " + opts.prompt });
    emit({ type: "done", text: "Done. You asked: " + opts.prompt, steps: 1, model: "test-model" });
    emit({ type: "task-status", status: "stopped" });
    return { taskId: opts.taskId!, text: "Done. You asked: " + opts.prompt };
  };

  adapter = await startProtocolAdapter({ cfg: cfg(), runTask, getTask: (id) => fakeDb.getTask(id), port: 0 });
  adapterPort = adapter.port;
  return { runTask, fakeDb };
}

async function teardown(): Promise<void> {
  if (adapter) {
    await adapter.close();
    adapter = undefined;
  }
}

function connectSocket(authToken: string): IoSocket {
  return io(`http://127.0.0.1:${adapter!.port}`, {
    transports: ["websocket"],
    auth: { token: authToken },
    query: { locale: "en", tz: "UTC", clientType: "desktop", clientVersion: "0.0.1" },
  });
}

function waitForEvent(socket: IoSocket, predicate: (m: ServerEnvelope) => boolean, timeoutMs = 5000): Promise<ServerEnvelope> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for event")), timeoutMs);
    const onMessage = (m: ServerMessage) => {
      if (m.type === "event" && predicate(m)) {
        clearTimeout(t);
        socket.off("message", onMessage);
        resolve(m);
      }
    };
    socket.on("message", onMessage);
  });
}

async function collectEvents(socket: IoSocket, ms: number): Promise<ServerEnvelope[]> {
  const events: ServerEnvelope[] = [];
  const onMessage = (m: ServerMessage) => {
    if (m.type === "event") events.push(m);
  };
  socket.on("message", onMessage);
  await sleep(ms);
  socket.off("message", onMessage);
  return events;
}

async function loginChain(): Promise<string> {
  // 1. Simulate renderer opening the browser login page to obtain a one-time loginToken.
  const login = await request("GET", "/login?nonce=test-nonce&type=signIn");
  if (login.status !== 302) throw new Error(`login redirect failed: ${login.status}`);
  const location = login.headers.location as string | undefined;
  if (!location) throw new Error("login redirect missing Location");
  const loginToken = new URLSearchParams(location.split("?")[1]).get("token");
  if (!loginToken) throw new Error("login redirect missing token");

  // 2. Exchange loginToken for temp code, then for session token.
  const gen = await postJson("/user.v1.UserAuthService/GenerateTempAuthCode", {}, loginToken);
  if (gen.status !== 200) throw new Error(`GenerateTempAuthCode failed: ${gen.status}`);
  const temp = (gen.json as { token: string }).token;
  const exch = await postJson("/user.v1.UserAuthPublicService/ExchangeTokenByCode", { token: temp });
  if (exch.status !== 200) throw new Error(`ExchangeTokenByCode failed: ${exch.status}`);
  const sessionToken = (exch.json as { token: string }).token;
  const info = await request("POST", "/user.v1.UserService/UserInfo", {}, sessionToken);
  if (info.status !== 200) throw new Error(`UserInfo failed: ${info.status}`);
  if ((info.json as { displayname: string }).displayname !== "Demo User") throw new Error("unexpected user");
  return sessionToken;
}

async function main(): Promise<void> {
  const { fakeDb } = await setup();

  try {
    // 1. Health
    const health = await getJson("/api/health");
    if (health.status !== 200) throw new Error(`health failed: ${health.status}`);

    // 2. Auth chain
    token = await loginChain();

    // 3. RPC without token is rejected
    const noAuth = await postJson("/user.v1.UserService/UserInfo", {});
    if (noAuth.status !== 401) throw new Error(`expected 401, got ${noAuth.status}`);

    // 4. Socket connect + join + user_message flow
    const socket = connectSocket(token);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    });

    const sessionId = "sess_" + Date.now();
    socket.emit("message", { type: "join_session", id: "join-1", timestamp: Date.now(), sessionId, version: 2 } as ClientMessage);
    const replay = await waitForEvent(socket, (m) => m.event.type === "eventsNotifyEventsAfter");
    if ((replay.event as any).events.length !== 0) throw new Error("expected empty replay for new session");

    const prompt = "Say hello in one sentence";
    socket.emit("message", {
      type: "user_message",
      id: "msg-1",
      timestamp: Date.now(),
      sessionId,
      messageStatus: "pending",
      messageType: "text",
      taskMode: "standard",
      content: "",
      contents: [{ type: "text", value: prompt }],
      attachments: [],
      extData: { capabilities: { enabledAddons: [], connectorAccounts: [], enabledConnectors: [] } },
    } as ClientMessage);

    const events = await collectEvents(socket, 500);
    const types = events.map((e) => e.event.type);

    // Required event types for §9.2 flow.
    const required: string[] = ["chat", "statusUpdate", "planUpdate", "newPlanStep", "toolUsed", "chatDelta", "cascadeTaskClock"];
    for (const t of required) {
      if (!(types as string[]).includes(t)) throw new Error(`missing event type ${t} in ${types.join(", ")}`);
    }

    // ToolUsed should have status argumentsFinished and success.
    const toolArgs = events.find((e) => e.event.type === "toolUsed" && (e.event as any).status === "argumentsFinished");
    if (!toolArgs) throw new Error("missing toolUsed argumentsFinished");
    const toolSuccess = events.find((e) => e.event.type === "toolUsed" && (e.event as any).status === "success");
    if (!toolSuccess) throw new Error("missing toolUsed success");
    if ((toolSuccess.event as any).tool !== "terminal") throw new Error("expected shell_run mapped to terminal");

    // chatDelta should be provisional.
    const delta = events.find((e) => e.event.type === "chatDelta");
    if (!delta) throw new Error("missing chatDelta");
    if ((delta.event as any).finished) throw new Error("expected unfinished chatDelta");

    // 5. Replay on second socket (§9.3)
    const replayFromId = events.find((e) => e.event.type === "chat" && (e.event as any).sender === "user")?.id;
    if (!replayFromId) throw new Error("expected user chat event for replay anchor");
    const socket2 = connectSocket(token);
    await new Promise<void>((resolve, reject) => {
      socket2.once("connect", resolve);
      socket2.once("connect_error", reject);
    });
    socket2.emit("message", { type: "join_session", id: "join-2", timestamp: Date.now(), sessionId, lastMessageId: replayFromId, version: 2 } as ClientMessage);
    const replay2 = await waitForEvent(socket2, (m) => m.event.type === "eventsNotifyEventsAfter");
    if ((replay2.event as any).events.length === 0) throw new Error("expected replay events after lastMessageId");

    socket.disconnect();
    socket2.disconnect();

    console.log("PASS protocol adapter integration tests");
  } finally {
    await teardown();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
