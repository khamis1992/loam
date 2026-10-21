import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-u21-repro-"));
const workspace = path.join(tmp, "workspace"); fs.mkdirSync(workspace);
const probe = http.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
const port = (probe.address() as import("node:net").AddressInfo).port;
await new Promise<void>(resolve => probe.close(() => resolve()));
const base = `http://127.0.0.1:${port}`, config = path.join(tmp, "config.json");
fs.writeFileSync(config, JSON.stringify({ model: "test-model", fallbackModel: "test-model", ollamaUrl: "http://127.0.0.1:1", workspace, computerUse: { enabled: false, screenshotDir: path.join(tmp, "screenshots") }, memory: { enabled: false }, screen: { enabled: false }, selfImprove: { enabled: false }, mcpServers: {} }));
let child: ChildProcess | undefined, logs = "";
const waitFor = async (predicate: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(`Timed out\nLOGS>>>${logs}`);
};
const start = async (): Promise<void> => {
  logs = "";
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: root, windowsHide: true, env: { ...process.env, AS_PROTOCOL_PORT: String(port + 1), LOAM_AUTH_DISABLED: "true", MANUS_LOCAL_CONFIG: config, MANUS_LOCAL_DATA_DIR: path.join(tmp, "data"), MANUS_LOCAL_PORT: String(port), MANUS_LOCAL_EVALS_DIR: path.join(tmp, "evals"), MANUS_LOCAL_SKILLS_DIR: path.join(tmp, "skills") }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", chunk => { logs += chunk; }); child.stderr?.on("data", chunk => { logs += chunk; });
  await waitFor(async () => { if (child?.exitCode != null) throw new Error(logs); return fetch(base + "/api/tasks").then(r => r.ok).catch(() => false); });
};
const post = (url: string, body: unknown) => fetch(base + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const status = async (url: string) => (await fetch(base + url)).status;
try {
  await start();
  const draft = async (mode: string): Promise<{ id: string; workspace: string }> => ((await (await post("/api/tasks/draft", { mode })).json()) as { task: { id: string; workspace: string } }).task;
  const media = await draft("media");
  const build = await draft("build");
  fs.writeFileSync(path.join(media.workspace, "hero.png"), "png");
  fs.writeFileSync(path.join(media.workspace, "report.pdf"), "pdf");
  fs.mkdirSync(path.join(build.workspace, "assets"));
  fs.writeFileSync(path.join(build.workspace, "assets", "clip.mp4"), "mp4");

  console.log("== UI-shaped calls ==");
  const tasksRes = await fetch(base + "/api/tasks?limit=50");
  const tasks = (await tasksRes.json()) as { tasks: Array<{ id: string }> };
  console.log("tasks list status:", tasksRes.status, "ids:", tasks.tasks.map(t => t.id).join(","));
  for (const t of tasks.tasks) {
    console.log(`files taskId=${t.id}:`, await status(`/api/files?taskId=${t.id}&path=&max=200`));
  }
  console.log("media with path:", await status(`/api/media?taskId=${media.id}&path=${encodeURIComponent("hero.png")}`));
  console.log("media missing path:", await status(`/api/media?taskId=${media.id}`));
  console.log("creative with taskId:", await status(`/api/creative?taskId=${media.id}`));
  console.log("creative no taskId:", await status(`/api/creative`));
  console.log("files no taskId:", await status(`/api/files`));
  // UI page flow: per-task files then media per entry
  const entries = ((await (await fetch(`${base}/api/files?taskId=${media.id}&path=&max=200`)).json()) as { entries: Array<{ path: string }> }).entries;
  for (const e of entries) console.log(`media entry ${e.path}:`, await status(`/api/media?taskId=${media.id}&path=${encodeURIComponent(e.path)}`));
} finally {
  if (child && child.exitCode === null) { const ended = once(child, "exit"); child.kill("SIGKILL"); await ended; }
  fs.rmSync(tmp, { recursive: true, force: true });
}

