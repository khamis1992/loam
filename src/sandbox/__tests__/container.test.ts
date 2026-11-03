import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  CONTAINER_LABEL,
  CONTAINER_PREFIX,
  DEFAULT_IMAGE,
  __setDockerForTests,
  containerLimits,
  containerModeEnabled,
  containerNameFor,
  ensureContainer,
  pruneContainers,
  removeContainer,
  spawnInContainer,
  spawnInteractiveInContainer,
  toContainerPath,
} from "../container.js";
import type { Config } from "../../config.js";

/** The env keys containerLimits/containerModeEnabled read; saved per test. */
const ENV_KEYS = ["LOAM_SANDBOX_CONTAINER", "LOAM_SANDBOX_IMAGE", "LOAM_SANDBOX_NETWORK", "LOAM_SANDBOX_CPUS", "LOAM_SANDBOX_MEMORY_MB"] as const;

function clearSandboxEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

function fakeChild(): ChildProcessWithoutNullStreams {
  const cp = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
  cp.stdout = new Readable({ read() { /* push driven by tests if needed */ } });
  cp.stderr = new Readable({ read() { /* push driven by tests if needed */ } });
  cp.stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  return cp;
}

interface Call {
  file: string;
  args: string[];
}

/**
 * Install a scripted docker mock. `exec` maps an argv (without the leading
 * "docker") to `{ stdout }`; returning undefined rejects the call — tests that
 * reach an unexpected docker invocation fail loudly on its message.
 */
function installMock(exec: (args: string[]) => { stdout: string } | undefined): { calls: Call[]; spawns: Call[] } {
  const calls: Call[] = [];
  const spawns: Call[] = [];
  __setDockerForTests({
    execFile: (file, args) => {
      calls.push({ file, args });
      const res = exec(args);
      if (!res) return Promise.reject(new Error(`unexpected docker call: ${args.join(" ")}`));
      return Promise.resolve(res);
    },
    spawn: (file, args) => {
      calls.push({ file, args });
      spawns.push({ file, args });
      return fakeChild();
    },
  });
  return { calls, spawns };
}

function cfgWith(container: Config["sandbox"]): Config {
  return { sandbox: container } as Config;
}

const DEFAULT_LIMITS = { image: DEFAULT_IMAGE, network: "none" as const, cpus: 2, memoryMb: 2048 };

test("containerLimits: defaults from config, env overrides, clamped", (t) => {
  t.after(() => { clearSandboxEnv(); __setDockerForTests(); });
  clearSandboxEnv();

  // Config only.
  assert.deepEqual(containerLimits(cfgWith({ container: { enabled: false, image: "node:20-alpine", network: "none", cpus: 1.5, memoryMb: 1024 } })),
    { image: "node:20-alpine", network: "none", cpus: 1.5, memoryMb: 1024 });

  // No config block at all -> shipped defaults.
  assert.deepEqual(containerLimits({} as Config), DEFAULT_LIMITS);

  // Env overrides each field.
  process.env.LOAM_SANDBOX_IMAGE = "alpine:3.20";
  process.env.LOAM_SANDBOX_NETWORK = "bridge";
  process.env.LOAM_SANDBOX_CPUS = "4";
  process.env.LOAM_SANDBOX_MEMORY_MB = "4096";
  assert.deepEqual(containerLimits({} as Config), { image: "alpine:3.20", network: "bridge", cpus: 4, memoryMb: 4096 });

  // Env wins over config; env "none" also wins (explicit).
  assert.deepEqual(containerLimits(cfgWith({ container: { enabled: true, image: "x", network: "bridge", cpus: 1, memoryMb: 512 } })),
    { image: "alpine:3.20", network: "bridge", cpus: 4, memoryMb: 4096 });
  process.env.LOAM_SANDBOX_NETWORK = "none";
  assert.equal(containerLimits(cfgWith({ container: { enabled: true, image: "x", network: "bridge", cpus: 1, memoryMb: 512 } })).network, "none");

  // Clamps: absurd values are bounded, not passed through.
  process.env.LOAM_SANDBOX_CPUS = "99";
  process.env.LOAM_SANDBOX_MEMORY_MB = "10";
  const clamped = containerLimits({} as Config);
  assert.equal(clamped.cpus, 8);
  assert.equal(clamped.memoryMb, 256);
  // Garbage numbers fall back to the config/default value, never NaN.
  process.env.LOAM_SANDBOX_CPUS = "not-a-number";
  assert.equal(containerLimits({} as Config).cpus, 2);
});

test("containerModeEnabled: env is a tri-state over the config switch", (t) => {
  t.after(() => { clearSandboxEnv(); __setDockerForTests(); });
  clearSandboxEnv();

  assert.equal(containerModeEnabled({} as Config), false);
  assert.equal(containerModeEnabled(cfgWith({ container: { enabled: true, image: "i", network: "none", cpus: 1, memoryMb: 256 } })), true);

  process.env.LOAM_SANDBOX_CONTAINER = "1";
  assert.equal(containerModeEnabled({} as Config), true);
  process.env.LOAM_SANDBOX_CONTAINER = "0";
  assert.equal(containerModeEnabled(cfgWith({ container: { enabled: true, image: "i", network: "none", cpus: 1, memoryMb: 256 } })), false);
  // Case-insensitive and whitespace-tolerant.
  process.env.LOAM_SANDBOX_CONTAINER = " TRUE ";
  assert.equal(containerModeEnabled({} as Config), true);
});

test("containerNameFor: sanitizes and caps length", () => {
  assert.equal(containerNameFor("abc123"), `${CONTAINER_PREFIX}abc123`);
  assert.equal(containerNameFor("task/with|bad+chars"), `${CONTAINER_PREFIX}task_with_bad_chars`);
  const long = "x".repeat(200);
  assert.ok(containerNameFor(long).length <= CONTAINER_PREFIX.length + 60);
});

test("toContainerPath: workspace-relative mapping, windows separators, outside maps to root", () => {
  assert.equal(toContainerPath("C:\\ws\\sub\\dir", "C:\\ws"), "/workspace/sub/dir");
  assert.equal(toContainerPath("C:/ws", "C:\\ws"), "/workspace");
  assert.equal(toContainerPath("/home/u/ws/", "/home/u/ws"), "/workspace");
  assert.equal(toContainerPath("/home/u/ws/nested/file.txt", "/home/u/ws"), "/workspace/nested/file.txt");
  // A path outside the workspace must never map outside the mount.
  assert.equal(toContainerPath("/etc/passwd", "/home/u/ws"), "/workspace");
});

test("ensureContainer: creates with the full hardening argv and reuses", async (t) => {
  t.after(() => { clearSandboxEnv(); __setDockerForTests(); });
  clearSandboxEnv();
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "loam-ct-")));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));

  let created = false;
  const { calls } = installMock((args) => {
    if (args[0] === "version") return { stdout: "24.0.0\n" };
    if (args[0] === "image" && args[1] === "inspect") return { stdout: "[]\n" }; // image present
    if (args[0] === "inspect") return created ? { stdout: "true\n" } : undefined; // absent until created
    if (args[0] === "run") {
      created = true;
      return { stdout: "cid\n" };
    }
    return undefined;
  });

  const name = await ensureContainer("t1", ws, DEFAULT_LIMITS);
  assert.equal(name, `${CONTAINER_PREFIX}t1`);

  const run = calls.find((c) => c.args[0] === "run");
  assert.ok(run, "docker run must be issued");
  const a = run.args;
  // Flag/value pairs the threat model depends on, asserted as pairs.
  const pairs: Array<[string, string]> = [
    ["--name", name],
    ["--label", `${CONTAINER_LABEL}=t1`],
    ["--network", "none"],
    ["--cap-drop", "ALL"],
    ["--security-opt", "no-new-privileges"],
    ["--pids-limit", "256"],
    ["--memory", "2048m"],
    ["--cpus", "2"],
    ["--user", "1000:1000"],
    ["--workdir", "/workspace"],
    ["--tmpfs", "/tmp:rw,noexec,nosuid,size=256m"],
    ["-v", `${ws}:/workspace`],
    ["--entrypoint", "sh"],
  ];
  for (const [flag, value] of pairs) {
    const i = a.indexOf(flag);
    assert.ok(i >= 0, `missing flag ${flag}`);
    assert.equal(a[i + 1], value, `${flag} must be ${value}`);
  }
  assert.equal(a[0], "run");
  assert.equal(a[1], "-d");
  assert.equal(a[a.length - 3], DEFAULT_IMAGE); // image then entrypoint args
  assert.equal(a[a.length - 1], "tail -f /dev/null");

  // A second ensure on the same running container issues no new create.
  const before = calls.length;
  assert.equal(await ensureContainer("t1", ws, DEFAULT_LIMITS), name);
  assert.equal(calls.length - before, 1); // just the inspect
  const last = calls.at(-1)!;
  assert.deepEqual(last.args.slice(0, 3), ["inspect", "-f", "{{.State.Running}}"]);
});

test("ensureContainer: restarts a stopped container instead of recreating", async (t) => {
  t.after(() => { clearSandboxEnv(); __setDockerForTests(); });
  clearSandboxEnv();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "loam-ct-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const name0 = `${CONTAINER_PREFIX}t2`;

  const { calls } = installMock((args) => {
    if (args[0] === "inspect") return { stdout: "false\n" }; // exists, stopped
    if (args[0] === "start") return { stdout: `${name0}\n` };
    return undefined;
  });
  assert.equal(await ensureContainer("t2", ws, DEFAULT_LIMITS), name0);
  assert.ok(calls.some((c) => c.args[0] === "start"), "docker start must be issued");
  assert.ok(!calls.some((c) => c.args[0] === "run"), "no recreate for a stopped container");
});

test("ensureContainer: refuses a missing host workspace before any docker call", async (t) => {
  t.after(() => { clearSandboxEnv(); __setDockerForTests(); });
  clearSandboxEnv();
  const { calls } = installMock(() => undefined);
  await assert.rejects(
    ensureContainer("t3", path.join(os.tmpdir(), "loam-does-not-exist-xyz"), DEFAULT_LIMITS),
    /workspace does not exist/,
  );
  assert.equal(calls.length, 0, "no docker call may run: Docker would create an empty bind-mount source");
});

test("ensureContainer: concurrent calls create exactly one container", async (t) => {
  t.after(() => { clearSandboxEnv(); __setDockerForTests(); });
  clearSandboxEnv();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "loam-ct-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));

  const { calls } = installMock((args) => {
    if (args[0] === "image" && args[1] === "inspect") return { stdout: "[]\n" };
    if (args[0] === "inspect") return undefined;
    if (args[0] === "run") return { stdout: "cid\n" };
    return undefined;
  });
  const [a, b] = await Promise.all([
    ensureContainer("t4", ws, DEFAULT_LIMITS),
    ensureContainer("t4", ws, DEFAULT_LIMITS),
  ]);
  assert.equal(a, b);
  assert.equal(calls.filter((c) => c.args[0] === "run").length, 1);
});

test("ensureContainer: pulls the image when absent, once", async (t) => {
  t.after(() => { clearSandboxEnv(); __setDockerForTests(); });
  clearSandboxEnv();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "loam-ct-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));

  const { calls } = installMock((args) => {
    if (args[0] === "image" && args[1] === "inspect") return undefined; // absent
    if (args[0] === "pull") return { stdout: "pulled\n" };
    if (args[0] === "inspect") return undefined;
    if (args[0] === "run") return { stdout: "cid\n" };
    return undefined;
  });
  await ensureContainer("t5", ws, { ...DEFAULT_LIMITS, image: "private/img:1" });
  const pulls = calls.filter((c) => c.args[0] === "pull");
  assert.equal(pulls.length, 1);
  assert.equal(pulls[0]!.args[1], "private/img:1");
  // The pull precedes the run.
  assert.ok(calls.findIndex((c) => c.args[0] === "pull") < calls.findIndex((c) => c.args[0] === "run"));
  // A later task with the same image skips the pull entirely (set caching).
  calls.length = 0;
  await ensureContainer("t5b", ws, { ...DEFAULT_LIMITS, image: "private/img:1" });
  assert.ok(!calls.some((c) => c.args[0] === "pull"));
});

test("spawnInContainer: exec argv carries workdir mapping, env pairs and the command", async (t) => {
  t.after(() => { clearSandboxEnv(); __setDockerForTests(); });
  clearSandboxEnv();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "loam-ct-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));

  const { spawns } = installMock((args) => {
    if (args[0] === "image" && args[1] === "inspect") return { stdout: "[]\n" };
    if (args[0] === "inspect") return { stdout: "true\n" }; // container running
    return undefined;
  });
  const child = await spawnInContainer({
    taskId: "t6", workspace: ws, command: "echo hi", cwd: path.join(ws, "sub"),
    env: { MY_VAR: "v1" }, limits: DEFAULT_LIMITS,
  });
  assert.ok(child.stdin && child.stdout, "returns a pipe-backed child");
  assert.equal(spawns.length, 1);
  const a = spawns[0]!.args;
  assert.deepEqual(a.slice(0, 4), ["exec", "-i", "--workdir", "/workspace/sub"]);
  const envIdx = a.indexOf("--env");
  assert.deepEqual(a.slice(envIdx, envIdx + 2), ["--env", "MY_VAR=v1"]);
  assert.equal(a[a.length - 1], "echo hi");
  assert.equal(a[a.length - 2], "-lc");
  assert.equal(a[a.length - 3], "sh");
  assert.equal(a[a.length - 4], `${CONTAINER_PREFIX}t6`);
});

test("spawnInteractiveInContainer: pipe-driven login shell in the container", async (t) => {
  t.after(() => { clearSandboxEnv(); __setDockerForTests(); });
  clearSandboxEnv();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "loam-ct-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));

  const { spawns } = installMock((args) => {
    if (args[0] === "inspect") return { stdout: "true\n" };
    return undefined;
  });
  await spawnInteractiveInContainer({ taskId: "t7", workspace: ws, cwd: ws, limits: DEFAULT_LIMITS });
  assert.equal(spawns.length, 1);
  const a = spawns[0]!.args;
  assert.equal(a[0], "exec");
  assert.equal(a[1], "-i");
  assert.deepEqual(a.slice(a.indexOf("--workdir"), a.indexOf("--workdir") + 2), ["--workdir", "/workspace"]);
  assert.deepEqual(a.slice(-3), [`${CONTAINER_PREFIX}t7`, "sh", "-l"]);
});

test("removeContainer: force-removes with volumes and never throws", async (t) => {
  t.after(() => { clearSandboxEnv(); __setDockerForTests(); });
  clearSandboxEnv();
  const { calls } = installMock(() => ({ stdout: "" }));
  await removeContainer("t8");
  assert.deepEqual(calls[0]!.args, ["rm", "-f", "-v", `${CONTAINER_PREFIX}t8`]);

  // A failing rm (docker gone) must resolve, not reject.
  __setDockerForTests({
    execFile: () => Promise.reject(new Error("docker unreachable")),
  });
  await removeContainer("t8");
});

test("pruneContainers: sweeps labelled containers; no-op without a daemon or when none", async (t) => {
  t.after(() => { clearSandboxEnv(); __setDockerForTests(); });
  clearSandboxEnv();

  // Daemon up, two stale containers.
  {
    const { calls } = installMock((args) => {
      if (args[0] === "version") return { stdout: "24.0.0\n" };
      if (args[0] === "ps") return { stdout: "id1\nid2\n" };
      if (args[0] === "rm") return { stdout: "" };
      return undefined;
    });
    await pruneContainers();
    const ps = calls.find((c) => c.args[0] === "ps")!;
    assert.deepEqual(ps.args, ["ps", "-aq", "--filter", `label=${CONTAINER_LABEL}`]);
    const rm = calls.find((c) => c.args[0] === "rm")!;
    assert.deepEqual(rm.args, ["rm", "-f", "-v", "id1", "id2"]);
  }
  // Daemon up, nothing stale: ps only, no rm.
  {
    const { calls } = installMock((args) => {
      if (args[0] === "version") return { stdout: "24.0.0\n" };
      if (args[0] === "ps") return { stdout: "" };
      return undefined;
    });
    await pruneContainers();
    assert.ok(calls.some((c) => c.args[0] === "ps"));
    assert.ok(!calls.some((c) => c.args[0] === "rm"));
  }
  // Daemon down: not a single docker call beyond the probe.
  {
    const { calls } = installMock(() => undefined);
    await pruneContainers();
    assert.deepEqual(calls.map((c) => c.args[0]), ["version"]);
  }
});
