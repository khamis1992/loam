/**
 * Tests for bench/launchers.ts (J1 before/after launcher benchmark).
 *
 * Guarantees under test:
 *  - per-process and shared launchers both spawn and collect real children
 *  - spawnSharedServer argv ends with the pin flag and marks the bench session
 *  - spawnPerProcess argv is the BEFORE shape and marks the bench session
 *  - the bench environment strips the coding-router env keys
 *  - collectOutput resolves for a fast child and for a child that already exited
 *  - the CLI parses flags, prints help, and fails on unknown flags
 *  - runLauncherBench produces a valid report for the shared launcher
 *  - runLauncherBench fails (exit 1) when sessions do not fix the task
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  BENCH_PROMPT,
  J1_HELP_TEXT,
  MARGINAL_SESSION_TARGET_MB,
  PROJECT_ROOT,
  SESSION_SETTLE_MS,
  SHARED_SERVER_ENTRY,
  collectOutput,
  parseJ1Args,
  runJ1Bench,
  runLauncherBench,
  spawnPerProcess,
  spawnSharedServer,
  usableSocketPath,
  type SpawnFn,
  type SpawnOptions,
} from "../launchers.js";
import { benchEnvFromProcessEnv } from "../perProcess.js";
import { FakeModelServer } from "../fakeModel.js";
import { isFixed, makeCalcRepo } from "../memBench.js";

/** A spawn double that records the exact argv the launcher would run. */
function recordingSpawn(): { impl: SpawnFn; calls: Array<{ file: string; args: string[]; options: SpawnOptions }> } {
  const calls: Array<{ file: string; args: string[]; options: SpawnOptions }> = [];
  const impl: SpawnFn = (file, args, options) => {
    calls.push({ file, args, options });
    // A child that exits immediately with no output: enough to exercise the
    // spawn/collect path without running a real session.
    return spawn(process.execPath, ["-e", "process.stdout.write('done')"], {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
  };
  return { impl, calls };
}

describe("bench/launchers", () => {
  it("parses the J1 CLI flags and rejects unknown ones", () => {
    const args = parseJ1Args(["--n", "1,10", "--kinds", "shared", "--sample-ms", "500", "--interval-ms", "50", "--json-out", "out.json"]);
    assert.deepEqual(args.n, [1, 10]);
    assert.deepEqual(args.kinds, ["shared"]);
    assert.equal(args.sampleMs, 500);
    assert.equal(args.intervalMs, 50);
    assert.equal(args.jsonOut, "out.json");
    assert.equal(args.help, undefined);

    assert.equal(parseJ1Args(["--help"]).help, true);
    assert.equal(parseJ1Args([]).kinds?.join(","), "per-process,shared");
    assert.equal(parseJ1Args(["--cooldown-ms", "1500"]).cooldownMs, 1500);
    assert.match(J1_HELP_TEXT, /--cooldown-ms/);
    assert.throws(() => parseJ1Args(["--bogus"]), /unknown flag/);
    assert.match(J1_HELP_TEXT, /bench:j1/);
  });

  it("spawns the shared server with the pin flag and the bench markers", () => {
    const { impl, calls } = recordingSpawn();
    spawnSharedServer(
      { socketPath: "\\\\.\\pipe\\loam-test", modelUrl: "http://127.0.0.1:1", model: "mock-coder", suppressFinal: true },
      impl,
    );
    assert.equal(calls.length, 1);
    const { file, args, options } = calls[0]!;
    assert.equal(file, process.execPath);
    assert.ok(args.includes(SHARED_SERVER_ENTRY), "server entry is on the command line");
    assert.deepEqual(args.slice(0, 2), ["--import", "tsx"]);
    assert.equal(args[args.length - 2], "1", "suppressFinal flag");
    assert.equal(args[args.length - 1], "1", "pinToLocalModel flag");
    assert.equal(options.env.LOAM_BENCH_SESSION, "shared");
    assert.equal(options.env.LOAM_BENCH_MODEL, "mock-coder");
    assert.equal(options.cwd, PROJECT_ROOT);
  });

  it("spawns the per-process session with the BEFORE shape and the bench markers", () => {
    const { impl, calls } = recordingSpawn();
    spawnPerProcess({ cwd: os.tmpdir(), modelUrl: "http://127.0.0.1:1", model: "mock-coder" }, impl);
    const { args, options } = calls[0]!;
    assert.ok(args.some((a) => a.endsWith("perProcess.ts")), "per-process entry is on the command line");
    assert.equal(args[args.length - 1], "1", "suppressFinal flag");
    assert.equal(options.env.LOAM_BENCH_SESSION, "per-process");
    assert.equal(options.env.LOAM_BENCH_MODEL, "mock-coder");
  });

  it("strips the coding-router env keys from the bench environment", () => {
    const env = benchEnvFromProcessEnv({
      PATH: "/bin",
      LOAM_CODER_CHAIN: "x",
      MANUS_LOCAL_CODER_CHAIN: "y",
      LOAM_CODER_ROUTING: "z",
    });
    assert.equal(env.PATH, "/bin");
    assert.equal("LOAM_CODER_CHAIN" in env, false);
    assert.equal("MANUS_LOCAL_CODER_CHAIN" in env, false);
    assert.equal("LOAM_CODER_ROUTING" in env, false);
  });

  it("collectOutput resolves for a fast child and for a child that already exited", async () => {
    const fast = spawn(process.execPath, ["-e", "process.stdout.write('hello\\n')"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const output = await collectOutput(fast);
    assert.match(output, /hello/);

    // A child that exits before the caller attaches listeners must still resolve.
    const already = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    await new Promise((resolve) => already.once("close", () => resolve(null)));
    await assert.doesNotReject(collectOutput(already));
  });

  it("usableSocketPath matches the platform's socket form", () => {
    const pipe = "\\\\.\\pipe\\loam-cs-1";
    const file = "/tmp/loam-cs-1.sock";
    assert.equal(usableSocketPath(pipe), process.platform === "win32");
    assert.equal(usableSocketPath(file), process.platform !== "win32");
  });

  it("exposes the J1 prompt, target and settle delay", () => {
    assert.equal(BENCH_PROMPT.includes("Fix the failing test"), true);
    assert.equal(MARGINAL_SESSION_TARGET_MB, 10);
    assert.equal(SESSION_SETTLE_MS, 1500);
    assert.equal(SHARED_SERVER_ENTRY.endsWith(path.join("sharedCodeSession.ts")), true);
  });
});

describe("bench/launchers runLauncherBench", () => {
  it("produces a valid shared report with one fixed session", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-j1-test-"));
    try {
      const cwd = path.join(baseDir, "s0");
      makeCalcRepo(cwd);
      const report = await runLauncherBench({
        n: 1,
        kind: "shared",
        model: "mock-coder",
        cwd: baseDir,
        keepCwd: true,
        sampleMs: 60_000,
        intervalMs: 250,
      });
      assert.equal(report.kind, "shared");
      assert.equal(report.N, 1);
      assert.equal(report.fixed, 1, "the shared session really fixed the fixture");
      assert.equal(isFixed(cwd), true);
      assert.ok(report.peakMB > 0);
      assert.ok(report.idleMB > 0);
      // `perSessionMB` is rounded to one decimal, so compare on that scale.
      assert.equal(report.perSessionMB, Math.round((report.peakMB - report.idleMB) * 10) / 10);
      assert.ok(report.notes.some((n) => n.includes("fake model")));
      assert.ok(report.notes.some((n) => n.includes("shared server pid=")));
      assert.equal(report.sessions.length, 1);
      assert.equal(report.sessions[0]!.fixed, true);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("produces a valid per-process report with one fixed session", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-j1-test-"));
    try {
      makeCalcRepo(path.join(baseDir, "s0"));
      const report = await runLauncherBench({
        n: 1,
        kind: "per-process",
        model: "mock-coder",
        cwd: baseDir,
        keepCwd: true,
        sampleMs: 60_000,
        intervalMs: 250,
      });
      assert.equal(report.kind, "per-process");
      assert.equal(report.N, 1);
      assert.equal(report.fixed, 1, "the per-process session really fixed the fixture");
      assert.ok(report.peakMB > report.idleMB);
      assert.equal(report.sessions.length, 1);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("reports a failing session as not fixed", async () => {
    // Make the session genuinely fail fast: the scripted model only reads the file
    // and then claims it is done, so `calc.py` is never edited. Pointing the
    // session at a dead endpoint instead would work, but the agent loop then burns
    // its whole retry budget before giving up, which makes this test take minutes.
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-j1-test-"));
    try {
      makeCalcRepo(path.join(baseDir, "s0"));
      const report = await runLauncherBench({
        n: 1,
        kind: "per-process",
        model: "mock-coder",
        sequence: [
          { tool: { name: "file_read", arguments: { path: "calc.py" } } },
          { text: "I looked at the file but changed nothing." },
        ],
        cwd: baseDir,
        keepCwd: true,
        sampleMs: 5_000,
        intervalMs: 250,
      });
      assert.equal(report.fixed, 0, "a session that edits nothing must not count as fixed");
      assert.equal(isFixed(path.join(baseDir, "s0")), false);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("runJ1Bench writes a JSON report with before and after sections", async () => {
    const out = path.join(os.tmpdir(), `loam-j1-report-${process.pid}.json`);
    try {
      const report = await runJ1Bench({
        n: [1],
        kinds: ["shared"],
        sampleMs: 60_000,
        intervalMs: 250,
        jsonOut: out,
        isolateEach: false,
      });
      assert.equal(report.before.length, 0);
      assert.equal(report.after.length, 1);
      assert.equal(report.after[0]!.fixed, 1);
      assert.ok(report.generatedAt.length > 0);
      assert.ok(report.notes.length > 0);
      const written = JSON.parse(fs.readFileSync(out, "utf8")) as typeof report;
      assert.equal(written.after.length, 1);
      assert.equal(written.after[0]!.N, 1);
    } finally {
      try {
        fs.rmSync(out, { force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("runJ1Bench measures every N of one shape before starting the other", async () => {
    // The AFTER numbers must not be taken on a machine the BEFORE shape has just
    // filled with dying processes (V8 then grows the shared server's heap), so the
    // order is launcher-outer with a cooldown between measurements. Both properties
    // are observable from the spawn order. Real spawns are used (not a double)
    // because the shared measurement only finishes if its server really binds.
    const order: string[] = [];
    const stamps: number[] = [];
    const timedSpawn: SpawnFn = (file, args, options) => {
      order.push(options.env.LOAM_BENCH_SESSION === "shared" ? "shared" : "per-process");
      stamps.push(Date.now());
      return spawn(file, args, options);
    };
    const report = await runJ1Bench({
      n: [1],
      kinds: ["per-process", "shared"],
      sampleMs: 60_000,
      intervalMs: 200,
      cooldownMs: 500,
      isolateEach: false,
      spawnImpl: timedSpawn,
    });
    assert.deepEqual(report.before.map((r) => r.N), [1]);
    assert.deepEqual(report.after.map((r) => r.N), [1]);
    assert.equal(report.before[0]!.kind, "per-process");
    assert.equal(report.after[0]!.kind, "shared");
    assert.equal(order[0], "per-process", "the per-process shape is measured first");
    assert.ok(order.includes("shared"), "the shared shape is measured too");
    assert.equal(order.indexOf("shared") > order.lastIndexOf("per-process"), true);
    // The gap that spans the shape switch includes the cooldown.
    const switchGap = stamps[order.indexOf("shared")]! - stamps[order.lastIndexOf("per-process")]!;
    assert.ok(switchGap >= 500, `expected a >=500ms cooldown between measurements, saw ${switchGap}ms`);
    assert.ok(report.notes.some((n) => n.includes("cooldown")));
  });

  it("runJ1Bench isolates every measurement in its own child process", async () => {
    // The J1 measurement is only meaningful per-process: a shared run that
    // shares a process with a per-process run that just peaked at ~4.2 GB
    // measures ~36 MB/session instead of ~3 MB. The child invocation is what
    // guarantees that, so assert on it rather than on a recorded number.
    const calls: Array<{ file: string; args: string[] }> = [];
    const writeReport = (args: string[]): void => {
      const out = args[args.indexOf("--report-out") + 1];
      if (!out) return;
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(
        out,
        JSON.stringify({
          launcher: args[args.indexOf("--isolate") + 1],
          kind: args[args.indexOf("--isolate") + 1],
          N: 1,
          idleMB: 1,
          peakMB: 1,
          finalMB: 1,
          perSessionMB: 1,
          baselineMB: null,
          marginalSessionMB: null,
          fixed: 1,
          sessions: [],
          durationMs: 0,
          platform: process.platform,
          notes: [],
        }),
        "utf8",
      );
    };
    const childSpawn: SpawnFn = (file, args, options) => {
      calls.push({ file, args });
      writeReport(args);
      // A no-op child: this test only needs the invocation, not a real run.
      return spawn(process.execPath, ["-e", "process.exit(0)"], {
        ...options,
        stdio: ["ignore", "pipe", "pipe"],
      });
    };
    try {
      const report = await runJ1Bench({
        n: [1],
        kinds: ["shared"],
        sampleMs: 1000,
        intervalMs: 100,
        isolateEach: true,
        spawnImpl: childSpawn,
      });
      assert.ok(calls.length >= 1, "at least one isolated child is spawned");
      const isolated = calls.find((c) => c.args.includes("--isolate"));
      assert.ok(isolated, "the measurement is spawned as its own process");
      assert.equal(isolated!.args[isolated!.args.indexOf("--isolate") + 1], "shared");
      assert.ok(isolated!.args.includes("--report-out"), "the child writes a report file");
      assert.equal(report.after.length, 1);
      assert.equal(report.after[0]!.kind, "shared");
    } finally {
      try {
        const out = calls.find((c) => c.args.includes("--isolate"));
        if (out) fs.rmSync(out.args[out.args.indexOf("--report-out") + 1]!, { force: true });
      } catch {
        /* ignore */
      }
    }
  });
});

describe("bench/launchers fake-model integration", () => {
  it("the fake model serves the bench sequence over the ollama transport", async () => {
    const model = new FakeModelServer({ host: "127.0.0.1", port: 0, transport: "ollama", model: "mock-coder" });
    await model.start();
    try {
      assert.ok(model.baseUrl.startsWith("http://127.0.0.1:"));
      assert.equal(model.requests.length, 0);
    } finally {
      await model.stop();
    }
  });
});
