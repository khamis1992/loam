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

const task = {
  id: "task_old_history",
  title: "Older hello task",
  prompt: "write hello world in python",
  status: "done",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  messages: [
    { role: "user", content: "write hello world in python", at: new Date().toISOString() },
    { role: "assistant", content: "Created hello.py with print(Hello)", at: new Date().toISOString() },
  ],
  steps: [
    { at: new Date().toISOString(), type: "plan", data: { type: "plan", goal: "write hello world in python", trivial: true, steps: [{ id: "s1", title: "Write file", instruction: "", successCriteria: "" }], source: "model" } },
    { at: new Date().toISOString(), type: "tool_call", data: { type: "tool_call", name: "file_write", args: { path: "hello.py", content: "print(Hello)" } } },
    { at: new Date().toISOString(), type: "tool_result", data: { type: "tool_result", name: "file_write", ok: true, summary: "wrote hello.py", ms: 1 } },
  ],
};

async function main() {
  const adapter = await startProtocolAdapter({ cfg, runTask: async () => ({ taskId: "", text: "" }), getTask: (id) => id === task.id ? task : undefined, port: 0 });
  const mod = await import("../src/protocol/socket.js");
  console.log("exports", Object.keys(mod));
  const events = mod.buildHistoryFromTask?.(task, "sess_x");
  console.log(events?.map((e) => e.type));
  await adapter.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
