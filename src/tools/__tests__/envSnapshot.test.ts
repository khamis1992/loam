/**
 * Tests for the environment blueprint + cached snapshot builder (D3).
 *
 * Guarantees under test:
 *  - env_blueprint_generate infers loam.env.yaml from a project manifest
 *    (package.json + lockfile -> `npm ci` + a node_modules cache entry) and
 *    writes secret NAMES only, never a value
 *  - the build hash changes when the lockfile changes, so the cache is invalidated
 *  - the first build runs every setup step; an unchanged hash reuses the cached
 *    snapshot and runs nothing (asserted with a spawn counter)
 *  - a resolved secret is injected into the child env but never appears in the
 *    build log, the status file or the tool reply
 *  - an unresolved secret fails the build instead of inlining the value
 *  - setup steps go through the command policy (a denied pattern fails the build)
 *  - bootTaskFromSnapshot reuses a built snapshot and refuses a missing one
 *  - blueprint validation refuses absolute/traversal paths
 *
 * The data directory is isolated: MANUS_LOCAL_DATA_DIR is set BEFORE the module
 * (which reads DATA_DIR at import time) is dynamically imported, so the real
 * vault file is never touched.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, before, after } from "node:test";

import type { Config } from "../../config.js";
import type { ToolContext } from "../registry.js";

const SCOPE = "agent_env_test";
const SECRET_NAME = "API_KEY";
const SECRET_VALUE = "sk-live-env-build-secret-VALUE-42";

interface EnvApi {
  createEnvSnapshotTools: () => Array<{ name: string; run: (args: Record<string, unknown>, ctx: unknown) => Promise<{ ok: boolean; content: string }> }>;
  readBlueprint: (dir: string) => { setup: string[]; cache: string[]; secrets: string[] };
  inferBlueprint: (dir: string) => { blueprint: { setup: string[]; cache: string[]; secrets: string[] }; hash: string };
  blueprintHash: (dir: string, blueprint: unknown) => string;
  buildEnvSnapshot: (
    projectId: string,
    projectFolder: string,
    blueprint: unknown,
    cfg: Config,
    opts?: {
      spawn?: (command: string, cwd: string, env: NodeJS.ProcessEnv) => Promise<{ code: number | null; stdout: string; stderr: string }>;
      scope?: string;
    },
  ) => Promise<{ ok: boolean; status: Record<string, unknown> }>;
  cloneEnvSnapshot: (
    projectId: string,
    hash: string,
    taskWorkspace: string,
    blueprint: unknown,
  ) => { ok: boolean; projectDir?: string; error?: string };
  envSnapshotDir: (projectId: string, hash: string) => string;
  envStatusPath: (projectId: string) => string;
  bootTaskFromSnapshot: (input: {
    taskWorkspace: string;
    projectId: string;
    projectFolder: string;
  }) => { ok: boolean; projectDir?: string; hash?: string; reason: string };
  normalizeBlueprint: (input: unknown) => unknown;
  resolveProjectDir: (workspace: string, projectDir: string) => string;
}

let tmpDir = "";
let env: EnvApi;

const cfg = {
  policy: { denyCommandPatterns: [], allowCommandPatterns: [], maxCommandSeconds: 180, networkEnabled: false, allowOutsideWorkspaceRead: false, sandboxMode: "workspace-write" },
} as unknown as Config;

/** Same policy but with `git push` denied, to prove setup steps obey it. */
const denyCfg = {
  policy: { denyCommandPatterns: ["git push"], allowCommandPatterns: [], maxCommandSeconds: 180, networkEnabled: false, allowOutsideWorkspaceRead: false, sandboxMode: "workspace-write" },
} as unknown as Config;

function ctx(workspace: string): ToolContext {
  return { cfg, workspace, agentId: SCOPE, emit: () => {} };
}

/** A Node project fixture with a lockfile, so inference has something to find. */
function writeProject(dir: string, withLock = true): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "demo", version: "1.0.0", dependencies: { lodash: "^4.17.21" } }, null, 1),
    "utf8",
  );
  fs.writeFileSync(path.join(dir, "index.js"), "console.log('demo');\n", "utf8");
  if (withLock) fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({ name: "demo", lockfileVersion: 3 }), "utf8");
}

interface Recorder {
  calls: string[];
  envs: NodeJS.ProcessEnv[];
  spawn: (command: string, cwd: string, env: NodeJS.ProcessEnv) => Promise<{ code: number | null; stdout: string; stderr: string }>;
}

/** Records every setup step and the env it was given, and never spawns for real. */
function recorder(): Recorder {
  const calls: string[] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  return {
    calls,
    envs,
    async spawn(command: string, cwd: string, env: NodeJS.ProcessEnv) {
      calls.push(command);
      envs.push({ ...env });
      return { code: 0, stdout: `ran: ${command}`, stderr: "" };
    },
  };
}

const build = async (
  projectId: string,
  dir: string,
  blueprintInput?: unknown,
  rec: Recorder = recorder(),
): Promise<Awaited<ReturnType<EnvApi["buildEnvSnapshot"]>>> =>
  env.buildEnvSnapshot(
    projectId,
    dir,
    blueprintInput ?? env.inferBlueprint(dir).blueprint,
    cfg,
    { spawn: rec.spawn, scope: SCOPE },
  );

describe("env blueprint + snapshot", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-env-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    const store = (await import("../../server/secretsVault.js")) as unknown as {
      setSecret: (agentId: string, name: string, value: string) => true | { error: string };
    };
    assert.equal(store.setSecret(SCOPE, SECRET_NAME, SECRET_VALUE), true, "vault fixture must be stored");
    env = (await import("../envSnapshot.js")) as unknown as EnvApi;
  });

  after(() => {
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  const generate = () => env.createEnvSnapshotTools().find((t) => t.name === "env_blueprint_generate")!;
  const statusTool = () => env.createEnvSnapshotTools().find((t) => t.name === "env_build_status")!;

  it("generates a blueprint from the manifest and writes loam.env.yaml", async () => {
    const dir = path.join(tmpDir, "proj1");
    writeProject(dir);
    const res = await generate().run({}, ctx(dir));
    assert.equal(res.ok, true);
    assert.match(res.content, /npm ci/);
    assert.match(res.content, /node_modules/);
    const blueprint = env.readBlueprint(dir);
    assert.ok(blueprint.setup.includes("npm ci"), "a lockfile must imply a pinned install step");
    assert.ok(blueprint.cache.includes("node_modules"));
  });

  it("preserves hand-written secrets as NAMES only", async () => {
    const dir = path.join(tmpDir, "proj2");
    writeProject(dir);
    fs.writeFileSync(path.join(dir, "loam.env.yaml"), "secrets: [API_KEY]\n", "utf8");
    const res = await generate().run({}, ctx(dir));
    assert.equal(res.ok, true);
    assert.deepEqual(env.readBlueprint(dir).secrets, [SECRET_NAME]);
    assert.ok(!res.content.includes(SECRET_VALUE), "a secret value must never appear in the tool reply");
    const onDisk = fs.readFileSync(path.join(dir, "loam.env.yaml"), "utf8");
    assert.ok(!onDisk.includes(SECRET_VALUE), "a secret value must never be written to the blueprint file");
  });

  it("the hash changes when the lockfile changes", () => {
    const dir = path.join(tmpDir, "proj3");
    writeProject(dir);
    const before = env.blueprintHash(dir, env.readBlueprint(dir));
    fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({ name: "demo", lockfileVersion: 3, changed: true }), "utf8");
    const after = env.blueprintHash(dir, env.readBlueprint(dir));
    assert.notEqual(before, after, "a lockfile change must invalidate the cached snapshot");
  });

  it("runs the setup steps once, then reuses the cached snapshot", async () => {
    const dir = path.join(tmpDir, "proj4");
    writeProject(dir);
    const blueprint = env.inferBlueprint(dir).blueprint;
    const hash = env.blueprintHash(dir, blueprint);

    const first = recorder();
    const built = await build("proj4", dir, blueprint, first);
    assert.equal(built.ok, true);
    assert.ok(first.calls.length >= 1, "the first build must run the install step");
    assert.match(String(built.status.log), /ran: npm ci/);
    assert.equal(built.status.stepsRun, first.calls.length);

    const second = recorder();
    const reused = await build("proj4", dir, blueprint, second);
    assert.equal(reused.ok, true);
    assert.equal(second.calls.length, 0, "an unchanged hash must reuse the cached snapshot and run nothing");
    assert.equal(reused.status.stepsRun, 0, "a reused snapshot reports zero steps run");
    assert.equal(env.envSnapshotDir("proj4", hash), env.envSnapshotDir("proj4", String(reused.status.hash)));
  });

  it("rebuilds when the hash changes", async () => {
    const dir = path.join(tmpDir, "proj4b");
    writeProject(dir);
    const blueprint = env.inferBlueprint(dir).blueprint;
    const staleHash = env.blueprintHash(dir, blueprint);
    const first = recorder();
    assert.equal((await build("proj4b", dir, blueprint, first)).ok, true);
    fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({ name: "demo", lockfileVersion: 3, changed: true }), "utf8");
    const changed = env.inferBlueprint(dir).blueprint;
    const second = recorder();
    const rebuilt = await build("proj4b", dir, changed, second);
    assert.equal(rebuilt.ok, true);
    assert.ok(second.calls.length >= 1, "a changed hash must re-run the setup steps");
    assert.notEqual(String(rebuilt.status.hash), staleHash, "a changed hash must produce a new build id");
  });

  it("injects a resolved secret into the child env only", async () => {
    const dir = path.join(tmpDir, "proj5");
    writeProject(dir, false);
    const blueprint = { setup: ["echo ok"], secrets: [SECRET_NAME] };
    const rec = recorder();
    const result = await build("proj5", dir, blueprint, rec);
    assert.equal(result.ok, true);
    assert.equal(rec.envs.length, 1);
    assert.equal(rec.envs[0]!.LOAM_VAULT_API_KEY, SECRET_VALUE, "the value goes to the child env, not the log");
    const log = String(result.status.log);
    assert.ok(!log.includes(SECRET_VALUE), "the build log must not contain the resolved secret value");
    assert.ok(!fs.readFileSync(env.envStatusPath("proj5"), "utf8").includes(SECRET_VALUE), "status.json must not contain the value");
  });

  it("redacts a secret echoed by a setup step", async () => {
    const dir = path.join(tmpDir, "proj6");
    writeProject(dir, false);
    const blueprint = { setup: ["echo hello"], secrets: [SECRET_NAME] };
    const rec = recorder();
    rec.spawn = async (command: string, cwd: string, env: NodeJS.ProcessEnv) => {
      rec.calls.push(command);
      rec.envs.push({ ...env });
      return { code: 0, stdout: `token=${SECRET_VALUE}`, stderr: "" };
    };
    const result = await build("proj6", dir, blueprint, rec);
    assert.equal(result.ok, true);
    const log = String(result.status.log);
    assert.ok(!log.includes(SECRET_VALUE), "an echoed secret must be redacted from the build log");
    assert.match(log, /\[vault:API_KEY\]/);
  });

  it("fails the build when a referenced secret is missing", async () => {
    const dir = path.join(tmpDir, "proj7");
    writeProject(dir, false);
    const rec = recorder();
    const result = await build("proj7", dir, { setup: ["echo {{vault:MISSING}}"] }, rec);
    assert.equal(result.ok, false);
    assert.match(String(result.status.error), /MISSING/);
    assert.equal(rec.calls.length, 0, "no setup step may run when a secret cannot be resolved");
  });

  it("fails a build whose setup step is denied by the command policy", async () => {
    const dir = path.join(tmpDir, "proj8");
    writeProject(dir, false);
    const rec = recorder();
    const result = await env.buildEnvSnapshot("proj8", dir, { setup: ["git push origin main"] }, denyCfg, { spawn: rec.spawn });
    assert.equal(result.ok, false);
    assert.match(String(result.status.error), /denied command pattern: git push/i);
    assert.equal(rec.calls.length, 0, "a denied step must never spawn");
  });

  it("bootTaskFromSnapshot reuses a built snapshot and refuses a missing one", async () => {
    const dir = path.join(tmpDir, "proj9");
    writeProject(dir);
    const workspace = path.join(tmpDir, "ws9");
    fs.mkdirSync(workspace, { recursive: true });
    const blueprint = env.readBlueprint(dir);
    const hash = env.blueprintHash(dir, blueprint);

    assert.equal(
      env.bootTaskFromSnapshot({ taskWorkspace: workspace, projectId: "proj9", projectFolder: dir }).ok,
      false,
      "no built snapshot means no reuse",
    );
    assert.equal((await build("proj9", dir, blueprint, recorder())).ok, true);

    const boot = env.bootTaskFromSnapshot({ taskWorkspace: workspace, projectId: "proj9", projectFolder: dir });
    assert.equal(boot.ok, true, "a built snapshot must be reused");
    assert.ok(boot.projectDir!.startsWith(workspace), "the clone must land inside the task workspace");
    assert.equal(boot.hash, hash);
    assert.ok(fs.existsSync(path.join(boot.projectDir!, "index.js")), "the snapshot clone carries the project files");
  });

  it("bootTaskFromSnapshot boots a fresh task worktree at its root and never overwrites it", async () => {
    const dir = path.join(tmpDir, "proj12");
    writeProject(dir);
    const blueprint = env.readBlueprint(dir);
    assert.equal((await build("proj12", dir, blueprint, recorder())).ok, true);

    // A brand-new task workspace: the snapshot lands at the root, like a boot.
    const fresh = path.join(tmpDir, "ws12");
    fs.mkdirSync(fresh, { recursive: true });
    const boot = env.bootTaskFromSnapshot({ taskWorkspace: fresh, projectId: "proj12", projectFolder: dir });
    assert.equal(boot.ok, true);
    assert.equal(boot.projectDir, path.resolve(fresh), "a task boot materializes the snapshot at the workspace root");
    assert.ok(fs.existsSync(path.join(fresh, "index.js")));

    // A workspace already holding the agent's work is left untouched.
    const occupied = path.join(tmpDir, "ws12b");
    fs.mkdirSync(occupied, { recursive: true });
    fs.writeFileSync(path.join(occupied, "agent-work.txt"), "keep me\n", "utf8");
    const refused = env.bootTaskFromSnapshot({ taskWorkspace: occupied, projectId: "proj12", projectFolder: dir });
    assert.equal(refused.ok, false, "a non-empty task workspace must never be overwritten");
    assert.match(refused.reason, /not empty/);
    assert.equal(fs.readFileSync(path.join(occupied, "agent-work.txt"), "utf8"), "keep me\n");
    assert.ok(!fs.existsSync(path.join(occupied, "index.js")), "nothing was cloned over the existing work");
  });

  it("bootTaskFromSnapshot ignores a stale snapshot after the lockfile changes", async () => {
    const dir = path.join(tmpDir, "proj13");
    writeProject(dir);
    const blueprint = env.readBlueprint(dir);
    assert.equal((await build("proj13", dir, blueprint, recorder())).ok, true);
    fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({ name: "demo", lockfileVersion: 3, changed: true }), "utf8");
    const workspace = path.join(tmpDir, "ws13");
    fs.mkdirSync(workspace, { recursive: true });
    const boot = env.bootTaskFromSnapshot({ taskWorkspace: workspace, projectId: "proj13", projectFolder: dir });
    assert.equal(boot.ok, false, "a stale hash must not reuse the old snapshot");
    assert.match(boot.reason, /no snapshot for hash/);
  });

  it("cloneEnvSnapshot refuses a snapshot that was never built", () => {
    const dir = path.join(tmpDir, "proj10");
    writeProject(dir);
    const workspace = path.join(tmpDir, "ws10");
    fs.mkdirSync(workspace, { recursive: true });
    const result = env.cloneEnvSnapshot("proj10", "deadbeef", workspace, env.readBlueprint(dir));
    assert.equal(result.ok, false);
    assert.match(result.error!, /no built snapshot/);
  });

  it("env_build_status reports the build and refuses an unknown build id", async () => {
    const dir = path.join(tmpDir, "proj11");
    writeProject(dir);
    assert.equal((await build("proj11", dir, env.readBlueprint(dir), recorder())).ok, true);
    const res = await statusTool().run({}, ctx(dir));
    assert.equal(res.ok, true);
    assert.match(res.content, /status:/);
    assert.match(res.content, /status: built/);
    const bad = await statusTool().run({ writeBlueprint: "nope/deadbeef" }, ctx(dir));
    assert.equal(bad.ok, false);
    assert.match(bad.content, /no built snapshot/);
  });

  it("normalizeBlueprint rejects absolute repo paths and traversal", () => {
    assert.throws(() => env.normalizeBlueprint({ repos: [{ path: "C:\\abs" }] }), /relative/);
    assert.throws(() => env.normalizeBlueprint({ cache: ["../outside"] }), /relative/);
    assert.throws(() => env.normalizeBlueprint({ secrets: ["bad name"] }), /invalid secret name/);
  });

  it("resolveProjectDir refuses to escape the workspace", () => {
    assert.throws(() => env.resolveProjectDir(tmpDir, "../outside"), /\.\./);
    assert.throws(() => env.resolveProjectDir(tmpDir, "C:\\other"), /relative/);
    assert.equal(env.resolveProjectDir(tmpDir, "sub"), path.join(tmpDir, "sub"));
  });
});
