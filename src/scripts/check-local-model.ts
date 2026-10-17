/** Opt-in smoke: real local inference with completely temporary app data. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

const model = process.env.LOAM_SMOKE_MODEL || "qwen2.5:14b";
if (/cloud/i.test(model)) throw new Error("This smoke test only permits local models");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-real-model-"));
const workspace = path.join(temp, "workspace"); fs.mkdirSync(workspace);
const probe = http.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
const port = (probe.address() as import("node:net").AddressInfo).port;
await new Promise<void>((resolve) => probe.close(() => resolve()));
const config = path.join(temp, "config.json");
fs.writeFileSync(config, JSON.stringify({ model, fallbackModel: model, ollamaUrl: "http://127.0.0.1:11434", workspace,
  agent: { maxSteps: 2, requestTimeoutMs: 75_000 }, orchestrator: { enabled: false },
  policy: { networkEnabled: false, allowOutsideWorkspaceRead: false }, memory: { enabled: false },
  screen: { enabled: false }, computerUse: { enabled: false }, selfImprove: { enabled: false }, mcpServers: {},
}));
const args = process.argv.includes("--bundle") ? ["dist/server.cjs"] : ["--import", "tsx", "src/index.ts"];
const child = spawn(process.execPath, args, { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: {
  ...process.env, LOAM_CONFIG: config, LOAM_DATA_DIR: path.join(temp, "data"), LOAM_PORT: String(port),
  LOAM_EVALS_DIR: path.join(temp, "evals"), LOAM_SKILLS_DIR: path.join(temp, "skills"),
} });
let logs = ""; child.stdout.on("data", (chunk) => { logs += chunk; }); child.stderr.on("data", (chunk) => { logs += chunk; });
const base = `http://127.0.0.1:${port}`;
const started = Date.now();
try {
  let ready = false;
  while (Date.now() - started < 15_000) {
    if (child.exitCode !== null) throw new Error(logs);
    ready = await fetch(base + "/api/tasks").then((r) => r.ok).catch(() => false);
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, "temporary app server must start");
  const response = await fetch(base + "/api/chat", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "ask", model, prompt: "Reply with only the result of 2 + 2. Do not use any tools." }), signal: AbortSignal.timeout(90_000),
  });
  assert.equal(response.status, 200);
  const stream = await response.text();
  const list = await (await fetch(base + "/api/tasks")).json() as { tasks: Array<{ id: string; status: string }> };
  const id = list.tasks[0]!.id;
  const details = await (await fetch(base + "/api/tasks/" + id)).json() as { task: { status: string; mode: string; messages: Array<{role:string;content:string}> } };
  assert.equal(details.task.status, "done", stream.slice(-2000));
  assert.equal(details.task.mode, "ask");
  const answer = details.task.messages.findLast((message) => message.role === "assistant")?.content ?? "";
  assert.match(answer, /4|٤/);
  assert.ok(stream.includes('"type":"done"'));
  console.log(JSON.stringify({ verdict: "PASS", model, source: args[0], status: details.task.status, answer, elapsedMs: Date.now() - started, isolated: true }));
} catch (err) {
  console.error("Real local inference smoke failed or exceeded deadline:", err instanceof Error ? err.message : String(err));
  console.error(logs.slice(-2000));
  process.exitCode = 1;
} finally {
  if (child.exitCode === null) { const stopped = once(child, "exit"); child.kill("SIGKILL"); await stopped; }
  fs.rmSync(temp, { recursive: true, force: true });
}
