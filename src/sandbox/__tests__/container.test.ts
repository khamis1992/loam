import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Config } from "../../config.js";
import {
  containerLimits,
  containerModeEnabled,
  containerNameFor,
  dockerAvailable,
  ensureContainer,
  pruneContainers,
  removeContainer,
  spawnInContainer,
  toContainerPath,
  __setDockerForTests,
} from "../container.js";

/** Minimal Config stub — only the sandbox branch is read by the unit under test. */
function cfgWith(container?: NonNullable<Config["sandbox"]>["container"]): Config {
  return {
    sandbox: { container: container ?? { enabled: false, image: "node:22-alpine", network: "none", cpus: 2, memoryMb: 2048 } },
  } as unknown as Config;
}

const LIMITS = { image: "node:22-alpine", network: "none" as const, cpus: 2, memoryMb: 2048 };

/** Records docker argv and answers from a script; never touches a real daemon. */
function fakeDocker(script: (args: string[]) => { stdout?: string; error?: Error } | undefined) {
  const calls: string[][] = [];
  const spawnCalls: string[][] = [];
  const runner = async (args: string[], _opts?: { timeout?: number }): Promise<{ stdout: string; stderr: string }> => {
    calls.push(args);
    const reply = script(args);
    if (reply?.error) throw reply.error;
    return { stdout: reply?.stdout ?? "", stderr: "" };
  };
  const spawner = (args: string[]): ChildProcessWithoutNullStreams => {
    spawnCalls.push(args);
    const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), pid: 4242, kill: () => true });
    return child;
  };
  return { calls, spawnCalls, runner, spawner };
}

/** Run fn with env overrides applied, restoring the previous values afterwards. */
async function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("containerModeEnabled: off by default, config on, env beats config", async () => {
  await withEnv({ LOAM_SANDBOX_CONTAINER: undefined }, async () => {
    assert.equal(containerModeEnabled(cfgWith()), false);
    assert.equal(containerModeEnabled(cfgWith({ enabled: true, image: "", network: "none", cpus: 1, memoryMb: 1 })), true);
    process.env.LOAM_SANDBOX_CONTAINER = "1";
    assert.equal(containerModeEnabled(cfgWith()), true);
    process.env.LOAM_SANDBOX_CONTAINER = "false";
    assert.equal(containerModeEnabled(cfgWith({ enabled: true, image: "", network: "none", cpus: 1, memoryMb: 1 })), false);
  });
});

test("containerLimits: defaults, config and env overrides", async () => {
  await withEnv(
    { LOAM_SANDBOX_IMAGE: undefined, LOAM_SANDBOX_NETWORK: undefined, LOAM_SANDBOX_CPUS: undefined, LOAM_SANDBOX_MEMORY_MB: undefined },
    async () => {
      assert.deepEqual(containerLimits(cfgWith()), LIMITS);
      assert.deepEqual(
        containerLimits(cfgWith({ enabled: true, image: "ubuntu:24.04", network: "bridge", cpus: 4, memoryMb: 8192 })),
        { image: "ubuntu:24.04", network: "bridge", cpus: 4, memoryMb: 8192 },
      );
      process.env.LOAM_SANDBOX_IMAGE = "alpine:3.20";
      process.env.LOAM_SANDBOX_NETWORK = "bridge";
      process.env.LOAM_SANDBOX_CPUS = "3";
      process.env.LOAM_SANDBOX_MEMORY_MB = "512";
      assert.deepEqual(containerLimits(cfgWith()), { image: "alpine:3.20", network: "bridge", cpus: 3, memoryMb: 512 });
      // garbage numbers fall back to config/defaults rather than NaN
      process.env.LOAM_SANDBOX_CPUS = "abc";
      process.env.LOAM_SANDBOX_MEMORY_MB = "-5";
      const limits = containerLimits(cfgWith());
      assert.equal(limits.cpus, 2);
      assert.equal(limits.memoryMb, 2048);
    },
  );
});

test("toContainerPath: workspace maps to /workspace, outside maps to the root", () => {
  assert.equal(toContainerPath("C:\\ws\\t1", "C:\\ws\\t1"), "/workspace");
  assert.equal(toContainerPath("C:\\ws\\t1\\sub\\dir", "C:\\ws\\t1"), "/workspace/sub/dir");
  assert.equal(toContainerPath("C:\\other\\x", "C:\\ws\\t1"), "/workspace");
  assert.equal(toContainerPath("C:/ws/t1/x", "C:/ws/t1/"), "/workspace/x");
});

test("containerNameFor: sanitized, prefixed and length-capped", () => {
  const name = containerNameFor('task/../$evil*id/with-a-very-long-suffix-' + "x".repeat(80));
  assert.match(name, /^loam-task-[A-Za-z0-9_.-]+$/);
  assert.ok(name.length <= "loam-task-".length + 60);
  assert.equal(containerNameFor("t1"), "loam-task-t1");
});

test("ensureContainer: reuses a running container without invoking docker run", async () => {
  const docker = fakeDocker((args) => (args[0] === "inspect" ? { stdout: "true\n" } : undefined));
  __setDockerForTests(docker.runner);
  try {
    const name = await ensureContainer("t-reuse", "C:\\ws\\t-reuse", LIMITS);
    assert.equal(name, containerNameFor("t-reuse"));
    assert.deepEqual(docker.calls, [["inspect", "-f", "{{.State.Running}}", name]]);
  } finally {
    __setDockerForTests(null);
  }
});

test("ensureContainer: starts a stopped container instead of recreating it", async () => {
  const docker = fakeDocker((args) => (args[0] === "inspect" ? { stdout: "false\n" } : undefined));
  __setDockerForTests(docker.runner);
  try {
    const name = await ensureContainer("t-start", "C:\\ws\\t-start", LIMITS);
    assert.equal(name, containerNameFor("t-start"));
    const start = docker.calls.find((c) => c[0] === "start");
    assert.ok(start, "docker start invoked");
    assert.deepEqual(start, ["start", name]);
    assert.equal(docker.calls.filter((c) => c[0] === "run").length, 0);
  } finally {
    __setDockerForTests(null);
  }
});

test("ensureContainer: creates a hardened container when absent", async () => {
  const docker = fakeDocker(() => undefined);
  __setDockerForTests(docker.runner);
  try {
    const name = await ensureContainer("t-create", "C:\\ws\\t-create", LIMITS);
    const run = docker.calls.find((c) => c[0] === "run");
    assert.ok(run, "docker run invoked");
    // kernel-level hardening the container promise is built on
    for (const flag of [
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--network", "none",
      "--pids-limit", "256",
      "--memory", "2048m",
      "--cpus", "2",
      "--user", "1000:1000",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
      "--label", "loam.task=t-create",
    ]) {
      assert.ok(run.includes(flag), `run argv contains ${flag}`);
    }
    // the workspace is the only bind mount
    assert.ok(run.includes("C:\\ws\\t-create:/workspace"));
    assert.ok(run.includes("node:22-alpine"));
    assert.equal(run[run.length - 1], "tail -f /dev/null");
    const probe = docker.calls[0];
    assert.ok(probe, "inspect ran first");
    assert.equal(probe[0], "inspect");
    assert.equal(name, containerNameFor("t-create"));
  } finally {
    __setDockerForTests(null);
  }
});

test("ensureContainer: concurrent calls share one create", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const calls: string[][] = [];
  const runner = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
    calls.push(args);
    if (args[0] === "inspect") {
      await gate;
      throw new Error("no such container");
    }
    return { stdout: "", stderr: "" };
  };
  __setDockerForTests(runner);
  try {
    const a = ensureContainer("t-dedup", "C:\\ws\\t-dedup", LIMITS);
    const b = ensureContainer("t-dedup", "C:\\ws\\t-dedup", LIMITS);
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    const [nameA, nameB] = await Promise.all([a, b]);
    assert.equal(nameA, nameB);
    assert.equal(calls.filter((c) => c[0] === "inspect").length, 1);
    assert.equal(calls.filter((c) => c[0] === "run").length, 1);
  } finally {
    __setDockerForTests(null);
  }
});

test("spawnInContainer: execs with mapped cwd and explicit env pairs", async () => {
  const docker = fakeDocker((args) => (args[0] === "inspect" ? { stdout: "true\n" } : undefined));
  __setDockerForTests(docker.runner, docker.spawner);
  try {
    const child = await spawnInContainer({
      taskId: "t-exec",
      workspace: "C:\\ws\\t-exec",
      command: "echo hi",
      cwd: "C:\\ws\\t-exec\\sub",
      env: { K: "V" },
      limits: LIMITS,
    });
    assert.equal(child.pid, 4242);
    const argv = docker.spawnCalls[0];
    assert.ok(argv, "docker exec spawned");
    assert.deepEqual(argv.slice(0, 3), ["exec", "-i", "--workdir"]);
    assert.ok(argv.includes("/workspace/sub"));
    const envAt = argv.indexOf("--env");
    assert.deepEqual(argv.slice(envAt, envAt + 2), ["--env", "K=V"]);
    assert.equal(argv[argv.length - 4], containerNameFor("t-exec"));
    assert.equal(argv[argv.length - 3], "sh");
    assert.equal(argv[argv.length - 2], "-lc");
    assert.equal(argv[argv.length - 1], "echo hi");
  } finally {
    __setDockerForTests(null);
  }
});

test("removeContainer: issues rm -f -v and never throws", async () => {
  const dead = fakeDocker(() => ({ error: new Error("docker exploded") }));
  __setDockerForTests(dead.runner);
  try {
    await removeContainer("t-rm"); // resolves despite the daemon error
  } finally {
    __setDockerForTests(null);
  }
  const ok = fakeDocker(() => undefined);
  __setDockerForTests(ok.runner);
  try {
    await removeContainer("t-rm");
    assert.deepEqual(ok.calls, [["rm", "-f", "-v", containerNameFor("t-rm")]]);
  } finally {
    __setDockerForTests(null);
  }
});

test("pruneContainers: sweeps labelled leftovers only when docker answers", async () => {
  const empty = fakeDocker((args) => (args[0] === "ps" ? { stdout: "" } : undefined));
  __setDockerForTests(empty.runner);
  try {
    await pruneContainers();
    assert.equal(empty.calls.filter((c) => c[0] === "rm").length, 0);
    const full = fakeDocker((args) => (args[0] === "ps" ? { stdout: "abc123\n def456\n" } : undefined));
    __setDockerForTests(full.runner);
    await pruneContainers();
    const sweep = full.calls.find((c) => c[0] === "rm");
    assert.ok(sweep, "docker rm invoked");
    assert.deepEqual(sweep, ["rm", "-f", "-v", "abc123", "def456"]);
    const offline = fakeDocker(() => ({ error: new Error("no daemon") }));
    __setDockerForTests(offline.runner);
    await pruneContainers();
    assert.equal(offline.calls.length, 1); // only the version probe, no ps
    const probeCall = offline.calls[0];
    assert.ok(probeCall, "probe recorded");
    assert.equal(probeCall[0], "version");
  } finally {
    __setDockerForTests(null);
  }
});

test("dockerAvailable: probes the daemon once per process", async () => {
  const docker = fakeDocker(() => ({ stdout: "24.0.7\n" }));
  __setDockerForTests(docker.runner);
  try {
    assert.equal(await dockerAvailable(), true);
    assert.equal(await dockerAvailable(), true);
    assert.equal(docker.calls.length, 1);
    const probe = docker.calls[0];
    assert.ok(probe, "probe recorded");
    assert.equal(probe[0], "version");
  } finally {
    __setDockerForTests(null);
  }
});
