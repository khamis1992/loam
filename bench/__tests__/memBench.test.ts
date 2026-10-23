/**
 * Tests for bench/memBench.ts (J2 benchmark orchestration).
 *
 * Guarantees under test:
 *  - the built-in node-echo launcher fixes the generated calc repo
 *  - runBench reports the documented JSON shape and a per-session cost
 *  - the threshold gate flags perSessionMB > thresholdMB
 *  - unknown launchers are rejected, the pluggable one gets the fake-model URL
 *  - CLI flags are parsed and help is available
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { describe, it } from "node:test";

import {
  CALC_PY,
  HELP_TEXT,
  NODE_ECHO_SCRIPT,
  isFixed,
  makeCalcRepo,
  parseArgs,
  resolveLauncher,
  runBench,
  type BenchOptions,
  type SpawnOptions,
} from "../memBench.js";

/** A spawn double that records what runBench tried to launch. */
class FakeChild implements Partial<ChildProcess> {
  pid: number | undefined;
  stdout = null;
  stderr = null;
  exitCode: number | null = null;
  private readonly listeners = new Map<string, Array<(...args: never[]) => void>>();
  constructor(
    readonly file: string,
    readonly args: string[],
    readonly options: SpawnOptions,
    private readonly applyFix: boolean,
  ) {
    this.pid = 4242;
  }
  on(event: string, listener: (...args: never[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }
  once(event: string, listener: (...args: never[]) => void): this {
    return this.on(event, listener);
  }
  kill(): boolean {
    return true;
  }
  emitExit(code: number): void {
    this.exitCode = code;
    if (this.applyFix && this.options.cwd) {
      fs.writeFileSync(
        path.join(this.options.cwd, "calc.py"),
        CALC_PY.replace("a - b", "a + b"),
        "utf8",
      );
    }
    for (const listener of this.listeners.get("exit") ?? []) listener(code as never);
  }
}

function optionsWith(overrides: Partial<BenchOptions>): BenchOptions {
  return {
    n: 1,
    sampleMs: 0,
    intervalMs: 25,
    ...overrides,
  };
}

describe("bench/memBench", () => {
  it("generates the calc repo with the add() bug and detects the fix", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-bench-repo-"));
    try {
      makeCalcRepo(dir);
      assert.equal(fs.readFileSync(path.join(dir, "calc.py"), "utf8"), CALC_PY);
      assert.ok(fs.readFileSync(path.join(dir, "test_calc.py"), "utf8").includes("def test_add"));
      assert.equal(isFixed(dir), false);
      fs.writeFileSync(path.join(dir, "calc.py"), CALC_PY.replace("a - b", "a + b"), "utf8");
      assert.equal(isFixed(dir), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs the node-echo launcher offline and reports the JSON shape", async () => {
    const jsonOut = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "loam-bench-json-")), "report.json");
    const report = await runBench(optionsWith({ n: 1, jsonOut }));
    try {
      assert.equal(report.launcher, "node-echo");
      assert.equal(report.N, 1);
      assert.equal(report.fixed, 1, "the launcher fixed calc.py");
      assert.equal(report.thresholdExceeded, false);
      assert.equal(typeof report.idleMB, "number");
      assert.equal(typeof report.peakMB, "number");
      assert.equal(typeof report.finalMB, "number");
      assert.equal(typeof report.perSessionMB, "number");
      assert.equal(report.platform, process.platform);
      assert.equal(report.sessions.length, 1);
      assert.equal(report.sessions[0]!.exitCode, 0);
      assert.equal(report.sessions[0]!.fixed, true);
      assert.ok(fs.existsSync(jsonOut), "jsonOut is written");
      const written = JSON.parse(fs.readFileSync(jsonOut, "utf8")) as { N: number };
      assert.equal(written.N, 1);
    } finally {
      fs.rmSync(path.dirname(jsonOut), { recursive: true, force: true });
    }
  });
  it("spawns N sessions and divides the growth by N", async () => {
    const launched: Array<{ file: string; args: string[] }> = [];
    const report = await runBench(
      optionsWith({
        n: 3,
        spawnImpl: (file, args, spawnOptions) => {
          launched.push({ file, args });
          const child = new FakeChild(file, args, spawnOptions, true);
          queueMicrotask(() => child.emitExit(0));
          return child as unknown as ChildProcess;
        },
      }),
    );
    assert.equal(report.N, 3);
    assert.equal(report.sessions.length, 3);
    assert.equal(launched.length, 3);
    assert.equal(report.fixed, 3);
  });

  it("flags a threshold regression when perSessionMB exceeds the threshold", async () => {
    const report = await runBench(
      optionsWith({
        n: 1,
        thresholdMB: -1,
        spawnImpl: (file, args, spawnOptions) => {
          const child = new FakeChild(file, args, spawnOptions, true);
          queueMicrotask(() => child.emitExit(0));
          return child as unknown as ChildProcess;
        },
      }),
    );
    assert.equal(report.thresholdExceeded, true);
    assert.equal(report.thresholdMB, -1);
  });

  it("rejects unknown launchers and exposes the pluggable one", () => {
    assert.throws(() => resolveLauncher("does-not-exist"), /unknown launcher/);
    process.env.LOAM_BENCH_LAUNCHER_FILE = "opencode";
    try {
      const spec = resolveLauncher("opencode", { fakeModelUrl: "http://127.0.0.1:11435" });
      assert.equal(spec.file, "opencode");
      assert.deepEqual(spec.args("/tmp/repo", 2, {}), ["/tmp/repo", "2"]);
      assert.deepEqual(spec.env?.("/tmp/repo", 0, {}), {
        OPENAI_BASE_URL: "http://127.0.0.1:11435",
        OPENAI_API_KEY: "mock",
      });
    } finally {
      delete process.env.LOAM_BENCH_LAUNCHER_FILE;
    }
  });

  it("parses CLI flags and prints help", () => {
    assert.deepEqual(parseArgs(["--n", "10", "--launcher", "node-echo", "--threshold", "99"]), {
      n: 10,
      launcher: "node-echo",
      thresholdMB: 99,
    });
    assert.equal(parseArgs(["--help"]).help, true);
    assert.match(HELP_TEXT, /bench:mem/);
    assert.match(HELP_TEXT, /--threshold/);
    assert.throws(() => parseArgs(["--bogus"]), /unknown flag/);
  });

  it("NODE_ECHO_SCRIPT is a self-contained node program", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-bench-script-"));
    const script = path.join(dir, "echo.cjs");
    try {
      fs.writeFileSync(script, NODE_ECHO_SCRIPT, "utf8");
      makeCalcRepo(dir);
      const child = spawn(process.execPath, [script], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
      const out = await new Promise<string>((resolve) => {
        let text = "";
        child.stdout!.on("data", (c: Buffer) => (text += c.toString()));
        child.on("exit", () => resolve(text));
      });
      assert.match(out, /fixed add\(\): ok/);
      assert.equal(isFixed(dir), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reuses an existing cwd when keepCwd is set", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-bench-keep-"));
    try {
      makeCalcRepo(dir);
      const report = await runBench(optionsWith({ n: 1, cwd: dir, keepCwd: true }));
      assert.equal(report.fixed, 1);
      assert.ok(fs.existsSync(path.join(dir, "calc.py")), "repo is left in place");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
