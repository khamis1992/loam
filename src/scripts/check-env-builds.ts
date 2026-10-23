/**
 * Live HTTP check for the D3 environment-snapshot surface: boots the real Loam
 * server on an ephemeral port and drives GET /api/env-builds over the network,
 * so the route mounting in http.ts is verified end to end rather than in
 * isolation.
 *
 * Run: npx tsx src/scripts/check-env-builds.ts [--bundle]
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-env-builds-"));
const workspace = path.join(tmp, "workspace");
fs.mkdirSync(workspace);
const dataDir = path.join(tmp, "data");
// This script and the server it spawns must agree on the data dir, or the build
// would be recorded somewhere the server never looks.
process.env.MANUS_LOCAL_DATA_DIR = dataDir;
const SECRET_VALUE = "sk-live-env-builds-check-secret-123";
// Every run of the setup step appends here, OUTSIDE the project checkout, so
// nothing about the clone or the hash can reset the count: only an actual re-run
// of the step would bump it.
const counter = path.join(tmp, "step-counter.txt");
const countSteps = (): number =>
  fs.existsSync(counter) ? fs.readFileSync(counter, "utf8").split("\n").filter(Boolean).length : 0;

/** Two free ports, so the run never collides with another worktree's app. */
async function freePort(): Promise<number> {
  const probe = http.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as import("node:net").AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

const port = await freePort();
const protoPort = await freePort();
const config = path.join(tmp, "config.json");
fs.writeFileSync(config, JSON.stringify({
  workspace, memory: { enabled: false }, screen: { enabled: false }, selfImprove: { enabled: false },
  computerUse: { enabled: false, screenshotDir: path.join(tmp, "screenshots") }, mcpServers: {},
}));

let child: ChildProcess | undefined;
let logs = "";
const base = `http://127.0.0.1:${port}`;
const start = async (): Promise<void> => {
  logs = "";
  const args = process.argv.includes("--bundle") ? ["dist/server.cjs"] : ["--import", "tsx", "src/index.ts"];
  child = spawn(process.execPath, args, {
    cwd: process.cwd(), windowsHide: true,
    env: {
      ...process.env, MANUS_LOCAL_CONFIG: config, MANUS_LOCAL_DATA_DIR: dataDir, MANUS_LOCAL_PORT: String(port),
      AS_PROTOCOL_PORT: String(protoPort), LOAM_AUTH_DISABLED: "true",
      MANUS_LOCAL_SKILLS_DIR: path.join(tmp, "skills"), MANUS_LOCAL_EVALS_DIR: path.join(tmp, "evals"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { logs += chunk; });
  child.stderr?.on("data", (chunk) => { logs += chunk; });
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    if (child.exitCode != null) throw new Error(logs);
    if (await fetch(`${base}/api/tasks`).then((r) => r.ok).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not become ready\n${logs.slice(-3000)}`);
};
const stop = async (): Promise<void> => {
  if (child && child.exitCode === null) {
    const ended = once(child, "exit");
    child.kill("SIGKILL");
    await ended;
  }
};

try {
  // The blueprint lives in the folder the project points at.
  const projectFolder = path.join(tmp, "project");
  fs.mkdirSync(projectFolder, { recursive: true });
  fs.writeFileSync(path.join(projectFolder, "package.json"), JSON.stringify({ name: "live-demo", version: "1.0.0" }), "utf8");
  fs.writeFileSync(path.join(projectFolder, "index.js"), "console.log('live');\n", "utf8");
  fs.writeFileSync(path.join(projectFolder, "package-lock.json"), JSON.stringify({ name: "live-demo", lockfileVersion: 3 }), "utf8");

  const env = await import("../tools/envSnapshot.js");
  const { loadConfig } = await import("../config.js");
  const { setSecret } = await import("../server/secretsVault.js");
  assert.equal(setSecret("agent_live_check", "API_KEY", SECRET_VALUE), true);
  // One real setup step that proves it ran (counter outside the checkout) and
  // that the vault value reached the child process without being logged: it
  // prints `key=<value>`, which the redactor must turn into [vault:API_KEY].
  const step =
    `node -e "require('fs').appendFileSync(process.argv[2],'ran\\n');`
    + `console.log('key='+process.argv[1])" "%LOAM_VAULT_API_KEY%" "${counter.replaceAll("\\", "/")}"`;
  const blueprint = env.normalizeBlueprint({ setup: [step], secrets: ["API_KEY"] });
  env.writeBlueprint(projectFolder, blueprint);

  // Build a snapshot in the SAME data dir the server uses, exactly as the agent
  // tool would, with real shell commands (no injected fake spawn).
  const built = await env.buildEnvSnapshot("live-project", projectFolder, blueprint, loadConfig(), { scope: "agent_live_check" });
  assert.equal(built.ok, true, `build must succeed: ${built.status.error ?? ""}`);
  assert.equal(countSteps(), 1, "the real shell setup step must have run exactly once");
  assert.ok(built.snapshotDir.startsWith(dataDir), "the build must land in the data dir the server will read");

  // Only now start the server, so it reads the build this script just recorded.
  await start();

  // 1. The list endpoint sees the build.
  const listRes = await fetch(`${base}/api/env-builds`);
  assert.equal(listRes.status, 200, "GET /api/env-builds must be routed by the live server");
  const list = await listRes.json() as { builds: Array<{ projectId: string; status: string; current: boolean; snapshotDir: string }> };
  const listed = list.builds.find((b) => b.projectId === "live-project");
  assert.ok(listed, "the built project must be listed");
  assert.equal(listed.status, "built");
  assert.equal(listed.current, true, "an unchanged blueprint is current");
  assert.ok(fs.existsSync(listed.snapshotDir), "the reported snapshot path must exist");
  assert.ok(!JSON.stringify(list).includes(SECRET_VALUE), "the list must not leak the secret value");

  // 2. The per-project endpoint carries the redacted status text.
  const oneRes = await fetch(`${base}/api/env-builds/live-project`);
  assert.equal(oneRes.status, 200);
  const one = await oneRes.json() as { build: { stepsRun: number }; text: string; stale: boolean };
  assert.equal(one.build.stepsRun, 1);
  assert.match(one.text, /status: built/);
  assert.ok(!JSON.stringify(one).includes(SECRET_VALUE), "the status payload must not leak the secret value");

  // 3. The log endpoint returns the redacted log as text.
  const logRes = await fetch(`${base}/api/env-builds/live-project/log`);
  assert.equal(logRes.status, 200);
  const logText = await logRes.text();
  assert.ok(!logText.includes(SECRET_VALUE), "the log endpoint must never return the secret value");
  assert.match(logText, /\[vault:API_KEY\]/, "the log must show the vault placeholder instead");

  // 4. Unknown ids 404, traversal ids 400, other methods fall through.
  assert.equal((await fetch(`${base}/api/env-builds/never-built`)).status, 404);
  assert.equal((await fetch(`${base}/api/env-builds/%2e%2e%2fetc`)).status, 400);
  assert.equal((await fetch(`${base}/api/env-builds`, { method: "POST" })).status, 404, "POST is not a build trigger");

  // 5. A lockfile change flips the snapshot to stale.
  fs.writeFileSync(path.join(projectFolder, "package-lock.json"), JSON.stringify({ name: "live-demo", lockfileVersion: 3, changed: true }), "utf8");
  const stale = await (await fetch(`${base}/api/env-builds/live-project`)).json() as { stale: boolean; reason: string };
  assert.equal(stale.stale, true, "a lockfile change must report the snapshot as stale");
  assert.match(stale.reason, /stale/);

  // 6. A project bound to the folder resolves the same build id the tool used,
  //    so a boot can find it (the task boot itself is covered by the real-shell
  //    E2E test, which drives bootTaskFromSnapshot directly).
  fs.writeFileSync(path.join(projectFolder, "package-lock.json"), JSON.stringify({ name: "live-demo", lockfileVersion: 3 }), "utf8");
  const projectRes = await fetch(`${base}/api/projects`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "live project" }),
  });
  assert.equal(projectRes.status, 200);
  const project = (await projectRes.json() as { project: { id: string } }).project;
  const folderRes = await fetch(`${base}/api/projects/${project.id}/folder`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: projectFolder }),
  });
  assert.equal(folderRes.status, 200);
  const bound = await (await fetch(`${base}/api/env-builds/${project.id}`)).json() as { stale: boolean };
  assert.equal(bound.stale, false, "a project bound to the built folder must resolve the same build");

  console.log(`PASS live env-build routes: list, per-project status, redacted log, staleness, 404/400/method handling, project binding (${tmp})`);
} finally {
  await stop();
}
