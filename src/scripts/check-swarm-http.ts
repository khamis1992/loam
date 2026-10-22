/** HTTP integration using a deterministic Ollama protocol fixture, not a live-model quality evaluation. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-swarm-http-"));
const workspace = path.join(tmp, "workspace");
fs.mkdirSync(workspace);
let requests = 0;
let writes = 0;
let tests = 0;
let fixtureMode: "normal" | "error" | "slow" = "normal";
const model = http.createServer(async (req, res) => {
  if (req.url === "/api/tags") { res.end(JSON.stringify({ models: [{ name: "protocol-fixture" }] })); return; }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw) as { messages: Array<{ role: string; content: string; tool_name?: string }>; tools?: Array<{ function: { name: string } }> };
  requests++;
  if (fixtureMode === "error") { res.writeHead(503); res.end("Deliberate protocol fixture outage"); return; }
  if (fixtureMode === "slow") { res.on("close", () => {}); return; }
  const system = body.messages[0]?.content ?? "";
  const tools = new Set(body.tools?.map((tool) => tool.function.name));
  const completed = body.messages.filter((message) => message.role === "tool");
  let toolCalls: unknown[] = [];
  let content = "Protocol fixture phase finished. The evidence is in the persisted tool results; no live-model capability is asserted.";
  const discovery = /Stage: discovery\./.test(system);
  if (discovery) { res.setHeader("content-type", "application/x-ndjson"); res.end(JSON.stringify({ model: "protocol-fixture", message: { role: "assistant", content: "المستخدمون: طالب ومدرس. قصة استخدام US-1 (AC-1: تظهر في القائمة). US-2 (AC-2: تتغير الحالة). US-3 (AC-3: تختفي). خريطة الإصدار: الإصدار الأول أساسي وما بعده المشاركة.", tool_calls: [] }, done: true }) + "\n"); return; }
  const ux = /Stage: ux\./.test(system);
  if (ux) { res.setHeader("content-type", "application/x-ndjson"); res.end(JSON.stringify({ model: "protocol-fixture", message: { role: "assistant", content: "بنية المعلومات: شاشة واحدة. نظام عربي RTL. حالات الواجهة: فراغ وتحميل وفشل. لوحة المفاتيح: Enter وإتاحة aria.", tool_calls: [] }, done: true }) + "\n"); return; }
  const qa = /Stage: qa\./.test(system);
  const testgen = /Stage: testgen\./.test(system);
  if (testgen && tools.has("file_write") && !completed.some((message) => message.tool_name === "file_write")) {
    writes++;
    toolCalls = [{ function: { name: "file_write", arguments: { path: "acceptance.test.cjs", content: "const assert = require('node:assert/strict');\nconst test = require('node:test');\ntest('independent acceptance: the delivered add function', () => { const add = require('./fixture.cjs'); assert.equal(add(19, 23), 42); });\n" } } }];
  } else if (!testgen && tools.has("file_write") && completed.length === 0 && !qa) {
    writes++;
    toolCalls = [{ function: { name: "file_write", arguments: { path: "fixture.test.cjs", content: "const assert = require('node:assert/strict');\nconst test = require('node:test');\nconst fs = require('node:fs');\ntest('generated artifact contains the requested working function', () => { const add = require('./fixture.cjs'); assert.equal(add(19, 23), 42); });\n" } } }];
  } else if (!testgen && tools.has("file_write") && completed.length === 1 && !qa) {
    writes++;
    toolCalls = [{ function: { name: "file_write", arguments: { path: "fixture.cjs", content: "module.exports = (a, b) => a + b;\n" } } }];
  } else if (tools.has("shell_run") && !completed.some((message) => message.tool_name === "shell_run")) {
    tests++;
    toolCalls = [{ function: { name: "shell_run", arguments: { command: "node --test fixture.test.cjs", timeoutSeconds: 10 } } }];
  }
  res.setHeader("content-type", "application/x-ndjson");
  res.end(JSON.stringify({ model: "protocol-fixture", message: { role: "assistant", content: toolCalls.length ? "" : content, tool_calls: toolCalls }, done: true, prompt_eval_count: 11, eval_count: 7 }) + "\n");
});
model.listen(0, "127.0.0.1"); await once(model, "listening");
const modelPort = (model.address() as import("node:net").AddressInfo).port;
const probe = http.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
const port = (probe.address() as import("node:net").AddressInfo).port;
await new Promise<void>((resolve) => probe.close(() => resolve()));
const base = `http://127.0.0.1:${port}`;
const config = path.join(tmp, "config.json");
fs.writeFileSync(config, JSON.stringify({ model: "protocol-fixture", fallbackModel: "protocol-fixture", ollamaUrl: `http://127.0.0.1:${modelPort}`, workspace,
  computerUse: { enabled: false, screenshotDir: path.join(tmp, "screenshots") }, memory: { enabled: false }, screen: { enabled: false }, selfImprove: { enabled: false }, mcpServers: {},
}));
let child: ChildProcess | undefined;
let logs = "";
async function waitFor(predicate: () => Promise<boolean> | boolean, label: string): Promise<void> {
  const until = Date.now() + 35_000;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error(`Timed out: ${label}\n${logs.slice(-5000)}`);
}
async function start(): Promise<void> {
  logs = "";
  const serverArgs = process.argv.includes("--bundle") ? ["dist/server.cjs"] : ["--import", "tsx", "src/index.ts"];
  child = spawn(process.execPath, serverArgs, { cwd: process.cwd(), windowsHide: true, env: {
    ...process.env, MANUS_LOCAL_CONFIG: config, MANUS_LOCAL_DATA_DIR: path.join(tmp, "data"), MANUS_LOCAL_PORT: String(port),
    MANUS_LOCAL_EVALS_DIR: path.join(tmp, "evals"), MANUS_LOCAL_SKILLS_DIR: path.join(tmp, "skills"),
  }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk) => { logs += chunk; }); child.stderr?.on("data", (chunk) => { logs += chunk; });
  await waitFor(async () => {
    if (child?.exitCode != null) throw new Error(logs);
    return fetch(base + "/api/swarm/runs").then((response) => response.ok).catch(() => false);
  }, "server readiness");
}
async function stop(): Promise<void> {
  if (child && child.exitCode === null) { const ended = once(child, "exit"); child.kill("SIGKILL"); await ended; }
}
const post = (url: string, body: unknown, extra: Record<string, string> = {}) => fetch(base + url, { method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
type Run = { id: string; taskId: string; status: string; nodes?: Array<{ id: string; status: string }>; error?: string };
async function getRun(id: string): Promise<Run> { return ((await (await fetch(base + "/api/swarm/runs/" + id)).json()) as { run: Run }).run; }
async function create(): Promise<Run> {
  const response = await post("/api/swarm/runs", { brief: "Build a working addition module and verify it with Node tests", model: "protocol-fixture", concurrency: 2, maxSteps: 8 });
  assert.ok(response.ok, await response.clone().text());
  return ((await response.json()) as { run: Run }).run;
}
try {
  await start();
  assert.equal((await post("/api/swarm/runs", { brief: "" })).status, 400);
  assert.equal((await post("/api/swarm/runs", { brief: "x" }, { origin: "https://untrusted.example" })).status, 403);
  assert.equal((await fetch(base + "/api/swarm/runs/swarm_00000000-0000-0000-0000-000000000000")).status, 404);
  const created = await create();
  await waitFor(async () => ["done", "completed", "failed", "error"].includes((await getRun(created.id)).status), "run terminal state");
  const completed = await getRun(created.id);
  assert.ok(["done", "completed"].includes(completed.status), JSON.stringify(completed));
  assert.ok(requests >= 6 && writes >= 2 && tests >= 1, "real model protocol/tool loop must execute");
  const artifacts = await (await fetch(base + `/api/swarm/runs/${created.id}/artifacts`)).json() as { artifacts: Array<{ path: string; size: number }> };
  assert.ok(artifacts.artifacts.some((artifact) => artifact.path.endsWith("fixture.cjs") && artifact.size > 0), "generated module must be downloadable");
  const downloaded = await fetch(base + "/api/media?" + new URLSearchParams({ taskId: created.taskId, path: "fixture.cjs" }));
  assert.equal(downloaded.status, 200); assert.match(await downloaded.text(), /a \+ b/);
  const listed = await (await fetch(base + "/api/swarm/runs")).json() as { runs: Run[] };
  assert.ok(listed.runs.some((run) => run.id === created.id));
  await stop(); await start();
  assert.equal((await getRun(created.id)).status, completed.status, "run survives server restart");
  fixtureMode = "slow";
  const beforeInterrupt = requests;
  const interrupted = await create();
  await waitFor(() => requests > beforeInterrupt, "interruptible model request");
  await stop(); fixtureMode = "normal"; await start();
  assert.equal((await getRun(interrupted.id)).status, "interrupted", "crash marks the run interrupted");
  assert.equal((await post(`/api/swarm/runs/${created.id}/resume`, {})).status, 409, "only interrupted runs can be resumed");
  assert.ok((await post(`/api/swarm/runs/${interrupted.id}/resume`, {})).ok);
  await waitFor(async () => (await getRun(interrupted.id)).status === "completed", "resumed run completes from checkpoints");
  fixtureMode = "error";
  const failed = await create();
  await waitFor(async () => ["failed", "error"].includes((await getRun(failed.id)).status), "provider failure");
  assert.ok(!["done", "completed"].includes((await getRun(failed.id)).status), "provider failure cannot become success");
  fixtureMode = "normal";
  assert.ok((await post(`/api/swarm/runs/${failed.id}/retry`, {})).ok);
  await waitFor(async () => (await getRun(failed.id)).status === "completed", "retry after provider recovery");
  assert.equal((await post(`/api/swarm/runs/${failed.id}/retry`, {})).status, 409);
  fixtureMode = "slow";
  const before = requests;
  const cancelled = await create();
  await waitFor(() => requests > before, "active cancellable model request");
  assert.ok((await post(`/api/swarm/runs/${cancelled.id}/cancel`, {})).ok);
  await waitFor(async () => (await getRun(cancelled.id)).status === "cancelled", "cancellation persisted");
  assert.equal((await post(`/api/swarm/runs/${cancelled.id}/retry`, {})).status, 409);
  const taskStart = requests;
  const taskCancelled = await create();
  await waitFor(() => requests > taskStart, "task cancellation model request");
  assert.ok((await post(`/api/tasks/${taskCancelled.taskId}/cancel`, {})).ok);
  await waitFor(async () => (await getRun(taskCancelled.id)).status === "cancelled", "standard task API cancels swarm");
  if (process.argv.includes("--browser")) {
    fixtureMode = "normal";
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true, channel: process.env.LOAM_TEST_BROWSER_CHANNEL || "chrome" });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(base + "/#/studios/swarm");
      const surface = page.frameLocator("#embedFrame");
      await surface.locator("#history .history-item").filter({ hasText: "Build a working addition" }).first().waitFor();
      await page.locator("#embedFrame").evaluate((frame, runId) => { (frame as unknown as { src: string }).src = "/swarm.html?run=" + runId; }, cancelled.id);
      await surface.locator("#run-status").filter({ hasText: "ملغى" }).waitFor();
      assert.equal(await surface.locator("#retry").isVisible(), false, "cancelled run cannot be retried");
      await page.locator("#embedFrame").evaluate((frame, runId) => { (frame as unknown as { src: string }).src = "/swarm.html?run=" + runId; }, completed.id);
      await surface.locator("#run-status").filter({ hasText: "مكتمل" }).waitFor();
      assert.equal(await surface.locator("#retry").isVisible(), false, "completed run cannot be retried");
      assert.equal(await surface.locator("#resume").isVisible(), false, "completed run cannot be resumed");
      await surface.locator("#brief").fill("Build a working addition module and test the generated code");
      await surface.locator("#model").selectOption("protocol-fixture");
      await surface.locator("#start").click();
      await surface.locator("#artifacts a").first().waitFor({ timeout: 35000 });
      assert.equal(await surface.locator("#board .agent-card").count(), 13);
      await surface.locator("#stage-progress").waitFor({ timeout: 35000 });
      await surface.locator("#memory").filter({ hasText: "ذاكرة المشروع" }).waitFor({ timeout: 35000 });
      await surface.locator("#deploy").filter({ hasText: "تجهيز النشر" }).waitFor({ timeout: 35000 });
      assert.match(await surface.locator("#deploy").innerText(), /مكتبة/, "protocol fixture delivers a library package");
      assert.equal(await surface.locator("#preview").isVisible(), false, "library package is not previewable");
      await surface.locator("#verification .verify-command").filter({ hasText: "node --test" }).waitFor();
      const artifactHref = await surface.locator("#artifacts a").first().getAttribute("href");
      assert.ok(artifactHref);
      assert.ok((await page.request.get(new URL(artifactHref, base).href)).ok());
      await page.reload();
      await surface.locator("#history .history-item").first().waitFor();
      assert.ok(await surface.locator("#history .history-item").count() >= 3);
      fs.mkdirSync(path.join(process.cwd(), "output", "verification"), { recursive: true });
      await page.screenshot({ path: path.join(process.cwd(), "output", "verification", "swarm-workspace.png"), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      const embedded = page.frames().find((frame) => frame.url().includes("swarm.html"));
      assert.ok(embedded, "integrated workspace iframe must remain mounted");
      assert.equal(await embedded.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true, "mobile workspace has no horizontal overflow");
      assert.deepEqual(errors, []);
      console.log("PASS browser protocol fixture: submit form, thirteen roles (product discovery, UX design, repository analysis, independent tests, deploy packaging … and verified merge), verification evidence, deploy panel, artifact download and persisted history after refresh");
    } finally { await browser.close(); }
  }
  console.log("PASS swarm HTTP protocol fixture: real file writes and Node test execution, artifacts/download, validation/origin, failure/retry/cancellation, list and restart persistence. This is not a live-model quality test.");
} finally {
  await stop(); model.closeAllConnections(); await new Promise<void>((resolve) => model.close(() => resolve()));
}
