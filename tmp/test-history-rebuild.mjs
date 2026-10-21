import http from "node:http";
import { io } from "socket.io-client";
import { startProtocolAdapter } from "../src/protocol/adapter.js";

const cfg = {
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

async function httpJson(port, method, path, body, token) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: "manual" });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function login(port) {
  const loginRes = await fetch(`http://127.0.0.1:${port}/login?nonce=tg`, { redirect: "manual" });
  const location = loginRes.headers.get("location") || "";
  const loginToken = new URLSearchParams(location.split("?")[1]).get("token");
  if (!loginToken) throw new Error("login redirect missing token: " + location);
  const gen = await httpJson(port, "POST", "/user.v1.UserAuthService/GenerateTempAuthCode", {}, loginToken);
  const exch = await httpJson(port, "POST", "/user.v1.UserAuthPublicService/ExchangeTokenByCode", { token: gen.json.token });
  return exch.json.token;
}

const fakeDb = new Map();
// Pre-seed an older task that already has messages/steps but no protocol session events.
const taskId = "task_old_history";
const now = new Date().toISOString();
fakeDb.set(taskId, {
  id: taskId,
  title: "Older hello task",
  prompt: "write hello world in python",
  status: "done",
  createdAt: now,
  updatedAt: now,
  messages: [
    { role: "user", content: "write hello world in python", at: now },
    { role: "assistant", content: "Created hello.py with print('Hello, World!')", at: now },
  ],
  steps: [
    { at: now, type: "plan", data: { type: "plan", goal: "write hello world in python", trivial: true, steps: [{ id: "s1", title: "Write file", instruction: "", successCriteria: "" }], source: "model" } },
    { at: now, type: "plan_step", data: { type: "plan_step", id: "s1", index: 1, total: 1, title: "Write file", phase: "start" } },
    { at: now, type: "tool_call", data: { type: "tool_call", name: "file_write", args: { path: "hello.py", content: "print('Hello, World!')" } } },
    { at: now, type: "tool_result", data: { type: "tool_result", name: "file_write", ok: true, summary: "wrote hello.py", ms: 1 } },
    { at: now, type: "assistant_message", data: { type: "assistant_message", text: "Created hello.py with print('Hello, World!')" } },
    { at: now, type: "done", data: { type: "done", text: "Created hello.py", steps: 1, model: "test" } },
  ],
});

async function main() {
  const adapter = await startProtocolAdapter({ cfg, runTask: async () => ({ taskId: "", text: "" }), getTask: (id) => fakeDb.get(id), port: 0 });
  const port = adapter.port;
  const token = await login(port);

  // Use a short session id that has never been persisted; the adapter should look
  // up the task by task id and synthesize history.
  const sessionId = "sess_rebuild_history";
  const socket = io(`http://127.0.0.1:${port}`, { transports: ["websocket"], auth: { token }, query: { locale: "en" } });
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
  socket.emit("message", { type: "join_session", id: "j1", timestamp: Date.now(), sessionId, version: 2 });

  const events = await new Promise((resolve) => {
    const collected = [];
    const handler = (frame) => {
      const ev = frame.event || {};
      console.log('received event type', ev.type);
      if (ev.type === "eventsNotifyEventsAfter") {
        collected.push(...(ev.events || []));
      }
    };
    socket.on("message", handler);
    setTimeout(() => { socket.off("message", handler); resolve(collected); }, 800);
  });
  socket.disconnect();
  await adapter.close();

  const types = events.map((e) => e.type);
  console.log("rebuilt event types:", types);
  const hasUser = events.some((e) => e.type === "chat" && e.sender === "user");
  const hasAssistant = events.some((e) => e.type === "chat" && e.sender === "assistant" && e.deliveryKind === "result");
  const hasTool = events.some((e) => e.type === "toolUsed");
  const hasStatus = events.some((e) => e.type === "statusUpdate");
  const hasClock = events.some((e) => e.type === "cascadeTaskClock");
  console.log({ hasUser, hasAssistant, hasTool, hasStatus, hasClock });
  if (!hasUser || !hasAssistant || !hasTool || !hasStatus || !hasClock) {
    console.error("FAIL: missing expected event types");
    process.exit(1);
  }
  console.log("PASS older task history rebuilt from DB");
}

main().catch((e) => { console.error(e); process.exit(1); });
