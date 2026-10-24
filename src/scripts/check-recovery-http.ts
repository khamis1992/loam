import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "manus-http-recovery-"));
const workspace = path.join(tmp, "workspace"); fs.mkdirSync(workspace);
let blockSecond = true;
let secondWaiting = false;
let firstTools = 0;
let secondTools = 0;
let rejectFinal = false;
const afterEffect = process.argv.includes("--after-effect");
const model = http.createServer(async (req, res) => {
  if (req.url === "/api/tags") { res.end(JSON.stringify({ models: [{ name: "test-model" }] })); return; }
  let raw = ""; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const messages = body.messages as Array<{ role: string; content: string }>;
  const system = messages[0]?.content ?? "";
  const prompt = messages.findLast((m) => m.role === "user")?.content ?? "";
  let content = "";
  let tool_calls: unknown[] = [];
  if (system.includes("planner role")) {
    content = JSON.stringify({ goal: "two durable effects", trivial: false, steps: [
      { id: "one", title: "first", instruction: "WRITE_FIRST", success_criteria: "first file exists" },
      { id: "two", title: "second", instruction: "WRITE_SECOND", success_criteria: "second file exists" },
    ] });
  } else if (system.includes("COMPLETED task as a whole")) {
    if (rejectFinal) content = JSON.stringify({ verdict: "revise", reason: "deliberately unverified result", fixes: ["Provide actual evidence"] });
    else if (!messages.some(m => m.role === "tool")) tool_calls = ["first.txt", "second.txt"].map(p => ({ function: { name: "file_read", arguments: { path: p } } }));
    else content = JSON.stringify({ verdict: "pass", reason: "read both actual files" });
  } else if (system.includes("ONE executed plan step")) {
    content = JSON.stringify({ verdict: "pass", reason: "file evidence" });
  } else if (messages.at(-1)?.role === "tool") {
    if (afterEffect && blockSecond && prompt.includes("WRITE_SECOND")) { secondWaiting = true; return; }
    content = "File saved and checked.";
  } else {
    const second = prompt.includes("WRITE_SECOND");
    if (second && blockSecond && !afterEffect) { secondWaiting = true; return; }
    if (second) secondTools++; else firstTools++;
    tool_calls = [{ function: { name: "file_write", arguments: { path: second ? "second.txt" : "first.txt", content: "one effect\n", append: true } } }];
  }
  res.setHeader("content-type", "application/x-ndjson");
  res.end(JSON.stringify({ model: "test-model", message: { role: "assistant", content, tool_calls }, done: true }) + "\n");
});
model.listen(0, "127.0.0.1"); await once(model, "listening");
const modelPort = (model.address() as import("node:net").AddressInfo).port;
const probe = http.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
const port = (probe.address() as import("node:net").AddressInfo).port;
await new Promise<void>((resolve) => probe.close(() => resolve()));
const protoProbe = http.createServer(); protoProbe.listen(0, "127.0.0.1"); await once(protoProbe, "listening");
const protoPort = (protoProbe.address() as import("node:net").AddressInfo).port;
await new Promise<void>((resolve) => protoProbe.close(() => resolve()));
const base = `http://127.0.0.1:${port}`;
const config = path.join(tmp, "config.json");
fs.writeFileSync(config, JSON.stringify({ model: "test-model", fallbackModel: "test-model", ollamaUrl: `http://127.0.0.1:${modelPort}`,
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
  const serverArgs = process.argv.includes("--bundle") ? ["dist/server.cjs"] : ["--import", "tsx", "src/index.ts"];
  child = spawn(process.execPath, serverArgs, { cwd: root, windowsHide: true, env: {
    ...process.env, MANUS_LOCAL_CONFIG: config, MANUS_LOCAL_DATA_DIR: path.join(tmp, "data"), MANUS_LOCAL_PORT: String(port), AS_PROTOCOL_PORT: String(protoPort), LOAM_AUTH_DISABLED: "true",
    MANUS_LOCAL_EVALS_DIR: path.join(tmp, "evals"), MANUS_LOCAL_SKILLS_DIR: path.join(tmp, "skills"),
  }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk) => { logs += chunk; }); child.stderr?.on("data", (chunk) => { logs += chunk; });
  await waitFor(async () => {
    if (child?.exitCode != null) throw new Error(logs);
    return fetch(`${base}/api/tasks`).then((r) => r.ok).catch(() => false);
  });
};
const stop = async (): Promise<void> => {
  if (child && child.exitCode === null) { const ended = once(child, "exit"); child.kill("SIGKILL"); await ended; }
};
type TaskSummary = { id: string; status: string };
type TaskResponse = { task: TaskSummary & { messages: Array<{ role: string }> }; recovery: { completedSteps: number; requiresConfirmation: boolean } | null };
const tasks = async (): Promise<TaskSummary[]> => ((await (await fetch(`${base}/api/tasks`)).json()) as { tasks: TaskSummary[] }).tasks;
const post = (url: string, body: unknown = {}) => fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
try {
  await start();
  const running = post("/api/chat", { prompt: "recovery fixture" }).then((r) => r.text()).catch(() => "disconnected");
  await waitFor(() => secondWaiting);
  const first = (await tasks())[0]!;
  assert.equal(first.status, "running");
  const queued = post("/api/chat", { prompt: "queued fixture" }).then((r) => r.text()).catch(() => "disconnected");
  await waitFor(async () => (await tasks()).some((t) => t.status === "queued"));
  const waiting = (await tasks()).find((t) => t.status === "queued")!;
  await post(`/api/tasks/${waiting.id}/cancel`);
  await waitFor(async () => (await tasks()).find((t) => t.id === waiting.id)?.status === "cancelled");
  assert.equal((await tasks()).find((t) => t.id === first.id)?.status, "running");
  await stop(); await Promise.all([running, queued]);
  blockSecond = false;
  await start();
  const recovered = await (await fetch(`${base}/api/tasks/${first.id}`)).json() as TaskResponse;
  assert.equal(recovered.task.status, "interrupted");
  assert.equal(recovered.recovery?.completedSteps, 1);
  assert.equal(recovered.recovery?.requiresConfirmation, true);
  const secondFile = path.join(workspace, ".loam-tasks", first.id, "second.txt");
  if (afterEffect) assert.equal(fs.readFileSync(secondFile, "utf8"), "one effect\n", "effect survived the crash before its step checkpoint");
  assert.equal((await post(`/api/tasks/${first.id}/resume`)).status, 409);
  assert.equal((await post(`/api/tasks/${first.id}/resume`, { retryInterruptedStep: false })).status, 409);
  assert.equal((await post(`/api/tasks/${first.id}/resume`, { retryInterruptedStep: "true" })).status, 409);
  assert.equal(secondTools, afterEffect ? 1 : 0, "denied resume cannot replay an uncertain effect");
  assert.equal((await tasks()).find(t => t.id === first.id)?.status, "interrupted");
  assert.equal((await post(`/api/tasks/${first.id}/resume`, { retryInterruptedStep: true })).status, 202);
  await waitFor(async () => (await tasks()).find((t) => t.id === first.id)?.status === "done");
  assert.equal(firstTools, 1, "completed step was not replayed");
  assert.equal(secondTools, 1, "resume retains the completed tool batch within an interrupted step");
  assert.equal(fs.readFileSync(secondFile, "utf8"), "one effect\n", "saved tool results must not be replayed");
  assert.equal(fs.readFileSync(path.join(workspace, ".loam-tasks", first.id, "first.txt"), "utf8"), "one effect\n");
  const finished = await (await fetch(`${base}/api/tasks/${first.id}`)).json() as TaskResponse;
  assert.equal(finished.task.messages.filter((m: { role: string }) => m.role === "user").length, 1);
  assert.equal(finished.recovery, null);
  rejectFinal = true;
  await (await post("/api/chat", { prompt: "unverified fixture" })).text();
  const rejected = (await tasks()).find(t => t.id !== first.id && t.id !== waiting.id)!;
  assert.equal(rejected.status, "error", "failed verification must not persist done");
  const rejectedDetails = await (await fetch(`${base}/api/tasks/${rejected.id}`)).json() as TaskResponse;
  assert.equal(rejectedDetails.task.messages.filter(m => m.role === "assistant").length, 0, "unverified completion never persisted as an assistant answer");
  console.log(`PASS HTTP queue, cancellation isolation, process kill/restart, explicit replay confirmation and resume without repeating checkpointed effects; afterEffect=${afterEffect} (${tmp})`);
} finally {
  await stop(); model.closeAllConnections(); await new Promise<void>((resolve) => model.close(() => resolve()));
}
