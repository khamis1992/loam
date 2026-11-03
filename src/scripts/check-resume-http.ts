import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-resume-http-"));
const workspace = path.join(tmp, "workspace");
const dataDir = path.join(tmp, "data");
fs.mkdirSync(workspace);
let blockSecond = true;
let secondWaiting = false;
let firstTools = 0;
let secondTools = 0;
const model = http.createServer(async (req, res) => {
  if (req.url === "/api/tags") { res.end(JSON.stringify({ models: [{ name: "test-model" }] })); return; }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const messages = body.messages as Array<{ role: string; content: string }>;
  const system = messages[0]?.content ?? "";
  const prompt = messages.findLast((m) => m.role === "user")?.content ?? "";
  let content = "";
  let tool_calls: unknown[] = [];
  if (system.includes("planner role")) {
    content = JSON.stringify({ goal: "durable resume", trivial: false, steps: [
      { id: "one", title: "first", instruction: "WRITE_FIRST", success_criteria: "first file exists" },
      { id: "two", title: "second", instruction: "WRITE_SECOND", success_criteria: "second file exists" },
    ] });
  } else if (system.includes("COMPLETED task as a whole")) {
    if (!messages.some((m) => m.role === "tool")) tool_calls = ["first.txt", "second.txt"].map((p) => ({ function: { name: "file_read", arguments: { path: p } } }));
    else content = JSON.stringify({ verdict: "pass", reason: "both files inspected" });
  } else if (system.includes("ONE executed plan step")) {
    content = JSON.stringify({ verdict: "pass", reason: "file evidence" });
  } else if (messages.at(-1)?.role === "tool") {
    content = "File saved and checked.";
  } else {
    const second = prompt.includes("WRITE_SECOND");
    const first = prompt.includes("WRITE_FIRST");
    if (second && blockSecond) { secondWaiting = true; return; }
    if (second) secondTools++;
    else if (first) firstTools++;
    else content = "No reusable skill found.";
    if (second || first) tool_calls = [{ function: { name: "file_write", arguments: { path: second ? "second.txt" : "first.txt", content: "one effect\n", append: true } } }];
  }
  res.setHeader("content-type", "application/x-ndjson");
  res.end(JSON.stringify({ model: "test-model", message: { role: "assistant", content, tool_calls }, done: true }) + "\n");
});
model.listen(0, "127.0.0.1");
await once(model, "listening");
const modelPort = (model.address() as import("node:net").AddressInfo).port;
const probe = http.createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = (probe.address() as import("node:net").AddressInfo).port;
await new Promise<void>((resolve) => probe.close(() => resolve()));
const protoProbe = http.createServer();
protoProbe.listen(0, "127.0.0.1");
await once(protoProbe, "listening");
const protoPort = (protoProbe.address() as import("node:net").AddressInfo).port;
await new Promise<void>((resolve) => protoProbe.close(() => resolve()));
const base = `http://127.0.0.1:${port}`;
const config = path.join(tmp, "config.json");
fs.writeFileSync(config, JSON.stringify({
  model: "test-model", fallbackModel: "test-model", ollamaUrl: `http://127.0.0.1:${modelPort}`,
  workspace, computerUse: { enabled: false, screenshotDir: path.join(tmp, "screenshots") }, memory: { enabled: false }, screen: { enabled: false }, selfImprove: { enabled: false }, mcpServers: {}, coding: { enabled: false }, failover: { providers: [] },
}));
let child: ChildProcess | undefined;
let logs = "";
const waitFor = async (predicate: () => Promise<boolean> | boolean): Promise<void> => {
  const until = Date.now() + 25_000;
  while (Date.now() < until) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error(`Timed out\n${logs.slice(-4000)}`);
};
const start = async (): Promise<void> => {
  logs = "";
  const args = process.argv.includes("--bundle") ? ["dist/server.cjs"] : ["--import", "tsx", "src/index.ts"];
  child = spawn(process.execPath, args, { cwd: root, windowsHide: true, env: {
    ...process.env, MANUS_LOCAL_CONFIG: config, MANUS_LOCAL_DATA_DIR: dataDir, MANUS_LOCAL_PORT: String(port), AS_PROTOCOL_PORT: String(protoPort), LOAM_AUTH_DISABLED: "true",
    MANUS_LOCAL_EVALS_DIR: path.join(tmp, "evals"), MANUS_LOCAL_SKILLS_DIR: path.join(tmp, "skills"),
  }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk) => { logs += chunk; });
  child.stderr?.on("data", (chunk) => { logs += chunk; });
  await waitFor(async () => {
    if (child?.exitCode != null) throw new Error(logs);
    return fetch(`${base}/api/tasks`).then((r) => r.ok).catch(() => false);
  });
};
const stop = async (): Promise<void> => {
  if (child && child.exitCode === null) { const ended = once(child, "exit"); child.kill("SIGKILL"); await ended; }
};
type TaskSummary = { id: string; status: string; workspace: string };
const tasks = async (): Promise<TaskSummary[]> => ((await (await fetch(`${base}/api/tasks`)).json()) as { tasks: TaskSummary[] }).tasks;
const task = async (id: string): Promise<TaskSummary> => ((await (await fetch(`${base}/api/tasks/${id}`)).json()) as { task: TaskSummary }).task;
const post = async (url: string, body: unknown = {}) => fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const waitDone = async (id: string) => waitFor(async () => (await tasks()).find((t) => t.id === id)?.status === "done");
try {
  await start();
  const running = post("/api/chat", { prompt: "durable fork and interrupt" }).then((r) => r.text()).catch(() => "disconnected");
  await waitFor(() => secondWaiting);
  const first = (await tasks())[0]!;
  await stop();
  await running;
  blockSecond = false;
  await start();

  assert.equal((await task(first.id)).status, "interrupted");
  const checkpointResponse = await fetch(`${base}/api/runs/${first.id}/checkpoints`);
  assert.equal(checkpointResponse.status, 200);
  const checkpointData = await checkpointResponse.json() as { checkpoints: Array<{ checkpointId: string; taskId: string; logSeq: number }> };
  const cp = checkpointData.checkpoints[0];
  assert.ok(cp, "checkpoint available through HTTP");
  const forkResponse = await post(`/api/runs/${first.id}/fork`, { checkpointId: cp.checkpointId, note: "HTTP fork" });
  assert.equal(forkResponse.status, 200, `${await forkResponse.clone().text()}\n${logs.slice(-3000)}`);
  const { forkTaskId } = await forkResponse.json() as { forkTaskId: string };
  assert.notEqual(forkTaskId, first.id);
  await waitDone(forkTaskId);

  process.env.MANUS_LOCAL_DATA_DIR = dataDir;
  process.env.LOAM_DATA_DIR = dataDir;
  const { createInterrupt } = await import("../orchestration/durable/interrupts.js");
  const interrupt = createInterrupt({ taskId: first.id, kind: "custom", payload: { question: "continue?" }, responseSchema: { type: "object" }, ttlMs: 60_000, maxPendingPerTask: 1, checkpointId: cp.checkpointId });
  const resolved = await post(`/api/interrupts/${interrupt.interruptId}/resolve`, { response: { answer: "yes" } });
  assert.equal(resolved.status, 200, await resolved.clone().text());
  assert.equal((await resolved.json() as { resumed: boolean }).resumed, true);
  await waitDone(first.id);

  assert.equal(firstTools, 1, "completed first step replayed");
  assert.equal(secondTools, 2, "fork and original should each run the interrupted step once");
  const originalWorkspace = (await task(first.id)).workspace;
  const forkWorkspace = (await task(forkTaskId)).workspace;
  assert.notEqual(originalWorkspace, forkWorkspace);
  for (const dir of [originalWorkspace, forkWorkspace]) {
    assert.equal(fs.readFileSync(path.join(dir, "first.txt"), "utf8"), "one effect\n");
    assert.equal(fs.readFileSync(path.join(dir, "second.txt"), "utf8"), "one effect\n");
  }
  console.log(`PASS HTTP checkpoint fork + interrupt resume + isolated effects (${tmp})`);
} finally {
  await stop();
  model.closeAllConnections();
  await new Promise<void>((resolve) => model.close(() => resolve()));
}
