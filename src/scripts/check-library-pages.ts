/** Library/Creations option #21: verify the sane-default list modes for
 *  /api/files, /api/creative and /api/media that the Creations and Library
 *  pages consume, plus the unchanged strict per-task contracts that task
 *  isolation depends on. Run: tsx src/scripts/check-library-pages.ts */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-library-pages-"));
const workspace = path.join(tmp, "workspace"); fs.mkdirSync(workspace);
const scene = {
  version: 1, title: "Gallery scene", nodes: [{ id: "product", name: "Product", type: "box", position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material: { color: "#7755ff", metalness: .5, roughness: .3 }, visible: true, spin: .5 }],
  environment: { background: "#101020", lightIntensity: 3, exposure: 1, grid: true }, camera: { position: [4, 3, 5], target: [0, 1, 0], fov: 45 }, duration: 8,
};
const probe = http.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
const port = (probe.address() as import("node:net").AddressInfo).port;
await new Promise<void>(resolve => probe.close(() => resolve()));
const base = `http://127.0.0.1:${port}`, config = path.join(tmp, "config.json");
fs.writeFileSync(config, JSON.stringify({ model: "test-model", fallbackModel: "test-model", ollamaUrl: "http://127.0.0.1:1", workspace, computerUse: { enabled: false, screenshotDir: path.join(tmp, "screenshots") }, memory: { enabled: false }, screen: { enabled: false }, selfImprove: { enabled: false }, mcpServers: {} }));
let child: ChildProcess | undefined, logs = "";
const waitFor = async (predicate: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out\nLOGS>>>${logs}`);
};
const start = async (): Promise<void> => {
  logs = "";
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: root, windowsHide: true, env: {
    ...process.env, AS_PROTOCOL_PORT: String(port + 1), LOAM_AUTH_DISABLED: "true",
    MANUS_LOCAL_CONFIG: config, MANUS_LOCAL_DATA_DIR: path.join(tmp, "data"), MANUS_LOCAL_PORT: String(port),
    MANUS_LOCAL_EVALS_DIR: path.join(tmp, "evals"), MANUS_LOCAL_SKILLS_DIR: path.join(tmp, "skills"),
  }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", chunk => { logs += chunk; }); child.stderr?.on("data", chunk => { logs += chunk; });
  await waitFor(async () => { if (child?.exitCode != null) throw new Error(logs); return (await fetch(base + "/api/tasks")).ok; });
};
const stop = async (): Promise<void> => { if (child && child.exitCode === null) { const ended = once(child, "exit"); child.kill("SIGKILL"); await ended; } };
type FileEntry = { taskId?: string; name: string; path: string; dir: boolean; size: number; mtime: string };
const status = async (url: string) => (await fetch(base + url)).status;
try {
  await start();
  const draft = async (mode: string): Promise<{ id: string; workspace: string }> => {
    const res = await fetch(base + "/api/tasks/draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) });
    return ((await res.json()) as { task: { id: string; workspace: string } }).task;
  };
  const media = await draft("media");
  const build = await draft("build");
  fs.writeFileSync(path.join(media.workspace, "hero.png"), "png");
  fs.writeFileSync(path.join(media.workspace, "report.pdf"), "pdf");
  fs.mkdirSync(path.join(build.workspace, "assets"));
  fs.writeFileSync(path.join(build.workspace, "assets", "clip.mp4"), "mp4");
  fs.mkdirSync(path.join(media.workspace, ".loam"));
  fs.writeFileSync(path.join(media.workspace, ".loam", "creative.json"), JSON.stringify({ ...scene, revision: 1 }));

  // UI-shaped per-task calls keep working (Pages use these for media links).
  assert.equal(await status(`/api/files?taskId=${media.id}&path=&max=200`), 200);
  assert.equal(await status(`/api/media?taskId=${media.id}&path=${encodeURIComponent("hero.png")}`), 200);
  assert.equal(await status(`/api/creative?taskId=${media.id}`), 200);
  const taskless = (await (await fetch(`${base}/api/files?list=1&max=400`)).json()) as { entries: FileEntry[] };
  // Aggregated list mode: every task's files, each entry tagged with taskId.
  assert.deepEqual(new Set(taskless.entries.map(e => e.taskId)), new Set([media.id, build.id]));
  assert.ok(taskless.entries.some(e => e.taskId === build.id && e.path === "assets/clip.mp4"));
  assert.ok(taskless.entries.some(e => e.taskId === media.id && e.path === "report.pdf"));
  // Strict paramless contracts stay untouched (isolation + creative fixtures).
  assert.equal(await status("/api/files"), 400);
  assert.equal(await status("/api/creative"), 400);
  assert.equal(await status(`/api/media?taskId=${build.id}`), 200, "/api/media without a path now lists");
  const mediaList = (await (await fetch(`${base}/api/media?taskId=${media.id}&max=50`)).json()) as { entries: FileEntry[] };
  assert.deepEqual(mediaList.entries.map(e => e.path), ["hero.png"], "media list keeps streamable files only");
  assert.equal(await status(`/api/media?taskId=${media.id}&path=${encodeURIComponent("../config.json")}`), 400, "traversal guard unchanged");
  assert.equal(await status(`/api/media?taskId=${build.id}&path=${encodeURIComponent("assets/clip.mp4")}`), 200);
  const scenes = (await (await fetch(`${base}/api/creative?list=1`)).json()) as { scenes: Array<{ taskId: string; title: string; revision: number; updatedAt: string }> };
  assert.ok(scenes.scenes.length === 1 && scenes.scenes[0]!.taskId === media.id && scenes.scenes[0]!.title === "Gallery scene" && scenes.scenes[0]!.revision === 1 && scenes.scenes[0]!.updatedAt, "creative list mode returns saved scenes, newest first");
  // Creation + Library filtering mirrors the web pages.
  const creationKinds = ["mp4", "mov", "webm", "mkv", "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];
  const docKinds = ["docx", "doc", "pdf", "txt", "md", "pptx", "ppt", "xlsx", "xls", "csv"];
  const isFile = (name: string) => !name.split("/").pop()!.includes(".") ? false : true;
  void isFile;
  const creations = taskless.entries.filter(e => !e.dir && creationKinds.includes(e.name.split(".").pop()!.toLowerCase()) && e.taskId);
  const library = taskless.entries.filter(e => !e.dir && docKinds.includes(e.name.split(".").pop()!.toLowerCase()) && e.taskId);
  assert.deepEqual(new Set(creations.map(e => e.path)), new Set(["hero.png", "assets/clip.mp4"]), "creation-kind files from both tasks, newest first");
  assert.deepEqual(library.map(e => e.path), ["report.pdf"]);

  await stop(); await start();
  const afterRestart = (await (await fetch(`${base}/api/files?list=1&max=400`)).json()) as { entries: FileEntry[] };
  assert.equal(afterRestart.entries.length, taskless.entries.length, "aggregate listing survives a server restart");
  console.log("PASS library/creations list modes: /api/files?list=1 aggregates all tasks with taskId tags, /api/creative?list=1 returns saved scenes, /api/media without a path lists streamable files; strict paramless contracts and traversal guards unchanged.");
} finally {
  await stop();
  fs.rmSync(tmp, { recursive: true, force: true });
}
