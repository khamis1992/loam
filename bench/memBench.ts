// Adapted from jcode (MIT) ref/jcode_daemon_bench.py and ref/bench_memory_cli.py
//
// J2 memory benchmark: spawn N coding sessions of a pluggable launcher against a
// generated repo with a tiny bug, sample the process-tree working set with
// bench/rssSampler.ts, and report idle / peak / final MB plus per-session cost.
// No real model API is used: the built-in `node-echo` launcher is fully offline.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sampleProcessTree, type MemoryReport } from "./rssSampler.js";

export interface BenchOptions {
  /** Number of concurrent sessions. Defaults to 1. */
  n?: number;
  /** Launcher name. Defaults to "node-echo". */
  launcher?: string;
  /** Regression threshold in MB per session. Defaults to 250. */
  thresholdMB?: number;
  /** Root pid to sample (defaults to this process, so children are included). */
  rootPid?: number;
  /** How long to sample before reading the peak. Defaults to 4000ms. */
  sampleMs?: number;
  /** Interval between samples. Defaults to 100ms. */
  intervalMs?: number;
  /** Override the process spawner (tests). */
  spawnImpl?: SpawnImpl;
  /** Extra environment for the launcher. */
  env?: NodeJS.ProcessEnv;
  /** Working directory for the sessions. Defaults to a generated repo. */
  cwd?: string;
  /** Skip generating the calc repo. */
  keepCwd?: boolean;
  /** Base URL handed to a pluggable launcher as OPENAI_BASE_URL. */
  fakeModelUrl?: string;
  /** Also write the JSON report here. */
  jsonOut?: string;
}

export type SpawnImpl = (file: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: ["ignore", "pipe", "pipe"];
  windowsHide: boolean;
}

export interface BenchReport {
  launcher: string;
  N: number;
  idleMB: number;
  peakMB: number;
  finalMB: number;
  perSessionMB: number;
  fixed: number;
  sessions: SessionResult[];
  thresholdMB: number | null;
  thresholdExceeded: boolean;
  durationMs: number;
  platform: string;
  notes: string[];
}

export interface SessionResult {
  index: number;
  cwd: string;
  pid: number | null;
  exitCode: number | null;
  fixed: boolean;
  output: string;
}

/** A trivial offline launcher: it applies the fix itself and exits. */
export const NODE_ECHO_SCRIPT = `const fs = require("node:fs");
const path = require("node:path");
const file = path.join(process.cwd(), "calc.py");
let text = fs.readFileSync(file, "utf8");
text = text.replace("return a - b", "return a + b");
fs.writeFileSync(file, text);
process.stdout.write("fixed add(): " + (text.includes("return a + b") ? "ok" : "failed") + "\\n");
`;

export const CALC_PY = `def add(a, b):
    return a - b
`;

export const TEST_CALC_PY = `from calc import add


def test_add():
    assert add(2, 3) == 5, add(2, 3)


if __name__ == "__main__":
    test_add()
    print("ok")
`;

/** Launcher names resolved by `resolveLauncher`. */
export const BUILT_IN_LAUNCHERS = ["node-echo"] as const;

export interface LauncherSpec {
  name: string;
  /** Command to spawn for one session. */
  file: string;
  args: (cwd: string, index: number, options: BenchOptions) => string[];
  /** Environment additions per session. */
  env?: (cwd: string, index: number, options: BenchOptions) => NodeJS.ProcessEnv;
}

export function resolveLauncher(name: string, options: BenchOptions = {}): LauncherSpec {
  const builtIn = BUILT_IN_LAUNCHERS.includes(name as (typeof BUILT_IN_LAUNCHERS)[number]);
  if (builtIn) {
    const scriptPath = path.join(os.tmpdir(), `loam-bench-node-echo-${process.pid}.cjs`);
    fs.writeFileSync(scriptPath, NODE_ECHO_SCRIPT, "utf8");
    return {
      name,
      file: process.execPath,
      args: () => [scriptPath],
      env: () => ({ LOAM_BENCH_SESSION: "node-echo" }),
    };
  }
  // Pluggable launcher: benchmark an external CLI (opencode run, a dev server...)
  // that talks to bench/fakeModel.ts via LOAM_BENCH_FAKE_MODEL_URL.
  const custom = process.env.LOAM_BENCH_LAUNCHER_FILE;
  if (typeof custom === "string" && custom.trim().length > 0) {
    return {
      name,
      file: custom,
      args: (cwd, index) => [cwd, String(index)],
      env: () => {
        const url = options.fakeModelUrl ?? process.env.LOAM_BENCH_FAKE_MODEL_URL ?? "";
        return url ? { OPENAI_BASE_URL: url, OPENAI_API_KEY: "mock" } : {};
      },
    };
  }
  throw new Error(
    `unknown launcher "${name}". Built-ins: ${BUILT_IN_LAUNCHERS.join(", ")} (or set LOAM_BENCH_LAUNCHER_FILE)`,
  );
}

/** Create the tiny generated repo (calc.py with the add() bug + its test). */
export function makeCalcRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "calc.py"), CALC_PY, "utf8");
  fs.writeFileSync(path.join(dir, "test_calc.py"), TEST_CALC_PY, "utf8");
  return dir;
}

export function isFixed(dir: string): boolean {
  try {
    return fs.readFileSync(path.join(dir, "calc.py"), "utf8").includes("return a + b");
  } catch {
    return false;
  }
}

const DEFAULT_THRESHOLD_MB = 250;
const DEFAULT_SAMPLE_MS = 4000;
const DEFAULT_INTERVAL_MS = 100;
/** How long to wait between spawning sessions so their work overlaps the sampling. */
const SESSION_SETTLE_MS = 750;

/** Run the benchmark and return the JSON report. */
export async function runBench(options: BenchOptions = {}): Promise<BenchReport> {
  const n = Math.max(1, Math.floor(options.n ?? Number(process.env.LOAM_BENCH_N ?? 1)));
  const launcherName = options.launcher ?? process.env.LOAM_BENCH_LAUNCHER ?? "node-echo";
  const thresholdMB =
    options.thresholdMB ??
    (process.env.LOAM_BENCH_THRESHOLD_MB ? Number(process.env.LOAM_BENCH_THRESHOLD_MB) : DEFAULT_THRESHOLD_MB);
  const sampleMs = Math.max(0, options.sampleMs ?? DEFAULT_SAMPLE_MS);
  const intervalMs = Math.max(1, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const spawnImpl: SpawnImpl =
    options.spawnImpl ??
    ((file, args, spawnOptions) => spawn(file, args, spawnOptions as never));
  const notes: string[] = [];
  const started = Date.now();

  const launcher = resolveLauncher(launcherName, options);
  const root = options.rootPid ?? process.pid;
  const baseDir = options.keepCwd && options.cwd ? options.cwd : fs.mkdtempSync(path.join(os.tmpdir(), "loam-bench-"));
  if (!options.keepCwd) makeCalcRepo(baseDir);

  const sessions: SessionResult[] = [];
  const children: ChildProcess[] = [];
  const sessionOutputs: Array<Promise<string>> = [];

  // Baseline before any session starts (a single snapshot).
  const idleReport: MemoryReport = await sampleProcessTree([root], { timeoutMs: 1, intervalMs: 1 });

  for (let i = 0; i < n; i++) {
    const cwd = options.keepCwd ? baseDir : path.join(baseDir, `s${i}`);
    if (!options.keepCwd) makeCalcRepo(cwd);
    const args = launcher.args(cwd, i, options);
    const child = spawnImpl(launcher.file, args, {
      cwd,
      env: { ...process.env, ...(options.env ?? {}), ...(launcher.env?.(cwd, i, options) ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    children.push(child);
    const output = collectChildOutput(child);
    sessions.push({
      index: i,
      cwd,
      pid: child.pid ?? null,
      exitCode: null,
      fixed: false,
      output: "",
    });
    sessionOutputs.push(output);
    // Let each session start and finish its scripted work before the next one;
    // sessions are meant to overlap, so this is short and independent of sampleMs.
    await delay(SESSION_SETTLE_MS);
  }

  const report: MemoryReport = await sampleProcessTree([root], { timeoutMs: sampleMs, intervalMs });
  const peakMB = Math.max(report.peakMB, idleReport.peakMB);
  const finalMB = report.finalMB;

  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i]!;
    const child = children[i]!;
    session.exitCode = await waitForExit(child, 5000);
    session.fixed = isFixed(session.cwd);
    session.output = (await sessionOutputs[i]!).slice(0, 2000);
  }

  const fixed = sessions.filter((s) => s.fixed).length;
  const perSessionMB = n > 0 ? round1(Math.max(0, peakMB - idleReport.idleMB) / n) : 0;
  const thresholdExceeded = perSessionMB > thresholdMB;

  const result: BenchReport = {
    launcher: launcherName,
    N: n,
    idleMB: idleReport.idleMB,
    peakMB: round1(peakMB),
    finalMB: round1(finalMB),
    perSessionMB,
    fixed,
    sessions,
    thresholdMB,
    thresholdExceeded,
    durationMs: Date.now() - started,
    platform: process.platform,
    notes,
  };

  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
  if (!options.keepCwd) {
    try {
      fs.rmSync(baseDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  if (options.jsonOut) {
    try {
      const outDir = path.dirname(options.jsonOut);
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(options.jsonOut, JSON.stringify(result, null, 2), "utf8");
    } catch (err) {
      notes.push(`could not write ${options.jsonOut}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(code);
    };
    const timer = setTimeout(() => finish(child.exitCode), timeoutMs);
    child.once("exit", (code) => finish(code));
    child.once("error", () => finish(child.exitCode));
  });
}

/** Buffered stdout+stderr for a spawned child (test spawners may emit nothing). */
function collectChildOutput(child: ChildProcess): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let pending = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const track = (stream: NodeJS.ReadableStream | null) => {
      if (!stream) return;
      pending += 1;
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      const done = () => {
        pending -= 1;
        if (pending <= 0) finish();
      };
      stream.on("end", done);
      stream.on("error", done);
      stream.on("close", done);
    };
    track(child.stdout);
    track(child.stderr);
    child.once("error", finish);
    // The process object only emits 'exit' on real children; test doubles and
    // already-exited processes never do, so resolve on a short timer too.
    later(finish, 50);
    // Never hang forever on a stub that emits nothing.
    later(finish, 4000);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Small defer helper that ignores the resolved value (keeps `no-void` quiet). */
function later(fn: () => void, ms: number): void {
  setTimeout(() => fn(), ms);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

interface CliArgs {
  n?: number;
  launcher?: string;
  thresholdMB?: number;
  sampleMs?: number;
  intervalMs?: number;
  cwd?: string;
  jsonOut?: string;
  keepCwd?: boolean;
  help?: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    const next = () => argv[++i];
    switch (token) {
      case "--n":
      case "-n":
        args.n = Number(next());
        break;
      case "--launcher":
        args.launcher = next();
        break;
      case "--threshold":
      case "--threshold-mb":
        args.thresholdMB = Number(next());
        break;
      case "--sample-ms":
        args.sampleMs = Number(next());
        break;
      case "--interval-ms":
        args.intervalMs = Number(next());
        break;
      case "--cwd":
        args.cwd = next();
        break;
      case "--json-out":
        args.jsonOut = next();
        break;
      case "--keep-cwd":
        args.keepCwd = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        if (token.startsWith("--")) throw new Error(`unknown flag ${token}`);
        break;
    }
  }
  return args;
}

export const HELP_TEXT = `Loam J2 memory benchmark (mock model, offline)

Usage: npm run bench:mem -- [options]

Options:
  -n, --n <count>          Number of sessions (default 1; try 1, 10, 30)
      --launcher <name>    Launcher (default node-echo; set LOAM_BENCH_LAUNCHER_FILE
                           to benchmark an external CLI against bench/fakeModel.ts;
                           it receives LOAM_BENCH_FAKE_MODEL_URL / OPENAI_BASE_URL)
      --threshold <mb>     Fail when per-session MB exceeds this (default 250,
                           env LOAM_BENCH_THRESHOLD_MB)
      --sample-ms <ms>     Sampling window (default 4000)
      --interval-ms <ms>   Sample interval (default 100)
      --cwd <dir>          Reuse an existing repo instead of generating one
      --json-out <path>    Also write the JSON report here
      --keep-cwd           Do not delete the generated repo
  -h, --help               Show this help
`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n${HELP_TEXT}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  const report = await runBench({
    n: args.n,
    launcher: args.launcher,
    thresholdMB: args.thresholdMB,
    sampleMs: args.sampleMs,
    intervalMs: args.intervalMs,
    cwd: args.cwd,
    jsonOut: args.jsonOut,
    keepCwd: args.keepCwd,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.thresholdExceeded) {
    process.stdout.write(`threshold exceeded: perSessionMB ${report.perSessionMB} > ${report.thresholdMB}\n`);
    return 1;
  }
  return 0;
}

// Run only when invoked directly (node --import tsx bench/memBench.ts ...).
const invokedDirectly = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  : false;
if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`bench:mem failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
