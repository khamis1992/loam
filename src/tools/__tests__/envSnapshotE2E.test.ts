/**
 * End-to-end acceptance for the D3 environment blueprint: no fake spawn hook
 * anywhere. Real shell commands run the setup steps, and the setup step appends
 * to a counter file OUTSIDE the project checkout, so the test can prove from the
 * filesystem that the step ran exactly once across two task boots.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, before, after } from "node:test";
import type { Config } from "../../config.js";

const SECRET_NAME = "API_KEY";
const SECRET_VALUE = "sk-live-e2e-acceptance-secret-VALUE-7";
const SCOPE = "agent_env_e2e";

let tmpDir = "";
let env: typeof import("../envSnapshot.js");
let cfg: Config;

function writeProject(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "e2e-demo", version: "1.0.0", dependencies: { lodash: "^4.17.21" } }, null, 1),
    "utf8",
  );
  fs.writeFileSync(path.join(dir, "index.js"), "console.log('e2e-demo');\n", "utf8");
  fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({ name: "e2e-demo", lockfileVersion: 3 }), "utf8");
}

describe("env blueprint end to end (real shell)", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-env-e2e-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    const { setSecret } = await import("../../server/secretsVault.js");
    assert.equal(setSecret(SCOPE, SECRET_NAME, SECRET_VALUE), true, "vault fixture must be stored");
    env = await import("../envSnapshot.js");
    const { loadConfig } = await import("../../config.js");
    cfg = loadConfig();
  });

  after(() => {
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("runs the setup steps once, then boots a second task worktree from the snapshot", async () => {
    const dir = path.join(tmpDir, "e2e-proj");
    writeProject(dir);

    // The counter lives outside the project checkout, so nothing about the clone
    // or the hash can reset it: only an actual re-run of the step would bump it.
    const counter = path.join(tmpDir, "e2e-counter.txt");
    const countSteps = () => (fs.existsSync(counter) ? fs.readFileSync(counter, "utf8").split("\n").filter(Boolean).length : 0);
    const step = `node -e "require('fs').appendFileSync(process.argv[1], 'ran\\n')" "${counter.replaceAll("\\", "/")}"`;

    // 1. Generate the blueprint from the manifest (the AC's fixture-repo case).
    const tools = env.createEnvSnapshotTools();
    const generate = tools.find((t) => t.name === "env_blueprint_generate")!;
    const generated = await generate.run({}, { cfg, workspace: dir, agentId: SCOPE, emit: () => {} });
    assert.equal(generated.ok, true);
    assert.match(generated.content, /npm ci/, "a lockfile must infer a pinned install step");
    const written = env.readBlueprint(dir);
    assert.ok(written.setup?.includes("npm ci"), "the written blueprint must carry the inferred install step");
    assert.ok(written.cache?.includes("node_modules"), "the written blueprint must carry the inferred cache path");

    // 2. A blueprint whose one setup step is a real, observable shell command.
    const blueprint = env.normalizeBlueprint({ ...written, setup: [step], cache: ["node_modules"], secrets: [SECRET_NAME] });
    env.writeBlueprint(dir, blueprint);
    const hash = env.blueprintHash(dir, blueprint);

    const first = await env.buildEnvSnapshot("e2e", dir, blueprint, cfg, { scope: SCOPE });
    assert.equal(first.ok, true, `first build must succeed: ${first.status.error ?? ""}`);
    assert.equal(first.status.stepsRun, 1, "the first build runs the setup step");
    assert.equal(countSteps(), 1, "the real shell step ran exactly once");
    assert.equal(fs.existsSync(path.join(first.snapshotDir, "project", "index.js")), true, "the snapshot holds the project checkout");

    // 3. Boot a task worktree: the snapshot is cloned, no step runs again.
    const taskA = path.join(tmpDir, "task-a");
    fs.mkdirSync(taskA, { recursive: true });
    const bootA = env.bootTaskFromSnapshot({ taskWorkspace: taskA, projectId: "e2e", projectFolder: dir });
    assert.equal(bootA.ok, true, `task boot must reuse the snapshot: ${bootA.reason}`);
    assert.equal(bootA.hash, hash);
    assert.equal(countSteps(), 1, "booting a task must NOT re-run the setup steps");
    assert.equal(fs.existsSync(path.join(taskA, "index.js")), true, "the task worktree has the project files");

    // 4. A second, independent task boot reuses the same snapshot again.
    const taskB = path.join(tmpDir, "task-b");
    fs.mkdirSync(taskB, { recursive: true });
    assert.equal(env.bootTaskFromSnapshot({ taskWorkspace: taskB, projectId: "e2e", projectFolder: dir }).ok, true);
    assert.equal(countSteps(), 1, "a second task boot must still not re-run the steps");

    // 5. A lockfile change invalidates the snapshot and re-runs the steps.
    fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({ name: "e2e-demo", lockfileVersion: 3, changed: true }), "utf8");
    const changedBlueprint = env.readBlueprint(dir);
    assert.notEqual(env.blueprintHash(dir, changedBlueprint), hash, "a lockfile change must change the hash");
    const second = await env.buildEnvSnapshot("e2e", dir, changedBlueprint, cfg, { scope: SCOPE });
    assert.equal(second.ok, true);
    assert.equal(second.status.stepsRun, 1, "a changed hash re-runs the setup steps");
    assert.equal(countSteps(), 2, "the step really ran a second time");

    // 6. No secret value ever reaches a log, a status file or a tool reply.
    const statusText = fs.readFileSync(env.envStatusPath("e2e"), "utf8");
    assert.ok(!statusText.includes(SECRET_VALUE), "status.json must never carry the secret value");
    assert.ok(!String(second.status.log).includes(SECRET_VALUE), "the build log must never carry the secret value");
    const statusTool = tools.find((t) => t.name === "env_build_status")!;
    const reported = await statusTool.run({}, { cfg, workspace: dir, agentId: SCOPE, emit: () => {} });
    assert.equal(reported.ok, true);
    assert.ok(!reported.content.includes(SECRET_VALUE), "the tool reply must never carry the secret value");
    assert.match(reported.content, /status: built/);
  });
});
