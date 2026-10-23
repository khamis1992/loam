// Adapted from jcode (MIT) ref/bench_memory_cli.py (app-level RSS benchmark).
//
// J6 measurement: the base (bench:mem, J2) drives N spawned *sessions* of a
// coding CLI and measures the growth attributed to each session. J6's question
// is different: how much does the app's own in-memory working set grow while it
// holds a long chat fixture, once every hot-path cache has an enforced bound?
//
// This is the "app" variant. It spawns the real server (src/index.ts) with the
// local auth token disabled, then repeatedly runs the same fixed scenario
// against it over loopback HTTP — a fresh chat task plus a large memory-store
// POST, which is the long-chat fixture path. Each iteration allocates a fresh
// task, fresh SSE stream and fresh request buffers, so an unbounded cache shows
// up as monotonic RSS growth while a bounded one plateaus at the cap.
//
// Everything is offline: no real model API is called (the chat run's provider
// calls are the scenario's own concern and are not asserted on), no data leaves
// the machine.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sampleProcessTree, type MemoryReport } from "./rssSampler.js";

/** Root of the repo (this file lives in bench/). */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A fresh data dir for one bench run. Two runs in the same process (or two
 * sibling runs on one machine) must never share a directory, because the
 * server takes an exclusive lease on `<data dir>/manus.db` and a collision
 * makes the second server exit as "another runtime owns this data directory".
 */
export function benchDataDir(): string {
  const unique = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  return path.join(os.tmpdir(), `loam-bench-data-${unique}`);
}

export interface AppBenchOptions {
  /** Number of scenario iterations. Default 25; env LOAM_APP_BENCH_ITERATIONS. */
  iterations?: number;
  /** Characters per memory-store POST (the long-chat fixture). Default 200_000. */
  fixtureChars?: number;
  /** Sampling window in ms. Default 4000. */
  sampleMs?: number;
  /** Interval between samples in ms. Default 100. */
  intervalMs?: number;
  /** Base URL of the server under test. Default http://127.0.0.1:<port>. */
  baseUrl?: string;
  /** Port the server was started on. Default 3939. */
  port?: number;
  /** Data dir the spawned server owns (defaults to an isolated temp dir). */
  dataDir?: string;
  /** How long to wait for the spawned server to answer /api/health. Default 120s. */
  readyTimeoutMs?: number;
  /** Set the environment for the child (tests inject stubs here). */
  env?: Record<string, string>;
  /** Override the child spawn (tests). */
  spawnImpl?: (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdio: unknown }) => ChildProcess;
  /** Where to write the JSON report. */
  jsonOut?: string;
}

export interface AppSessionResult {
  /** 1-based iteration index. */
  iteration: number;
  /** Task id returned by the chat run, or null when the run failed. */
  taskId: string | null;
  /** Chat status code. */
  chatStatus: number;
  /** Memory-store POST status code. */
  memoryStatus: number;
  /** Response bytes read from the chat stream. */
  chatBytes: number;
  /** Response bytes read from the memory-store response. */
  memoryBytes: number;
  /** Error message when a request failed. */
  error: string | null;
}

export interface AppBenchReport {
  /** Always "app-scenario" so a report can be identified without its filename. */
  kind: "app-scenario";
  /** Launcher description. */
  launcher: string;
  /** Number of scenario iterations. */
  iterations: number;
  /** Server port the scenario was driven against. */
  port: number;
  /** Git commit the server under test was built from (best effort). */
  sourceCommit?: string;
  /** True when the server under test already has the J6 `debug:memory` route. */
  debugRoutePresent?: boolean;
  /** RSS before the first scenario iteration. */
  idleMB: number;
  /** Highest RSS observed. */
  peakMB: number;
  /** RSS after the last iteration. */
  finalMB: number;
  /** Growth attributed to the whole scenario, i.e. peakMB - idleMB. */
  growthMB: number;
  /** RSS of the last sample taken (leak indicator). */
  lastSampleMB: number;
  /** Retained bytes reported by the server's own cache counters. */
  retainedCacheBytes: number;
  /** Total live entries across every bounded cache. */
  cacheEntries: number;
  /** Number of bounded caches registered on the server. */
  cacheCount: number;
  sessions: AppSessionResult[];
  thresholdMB: number;
  thresholdExceeded: boolean;
  durationMs: number;
  platform: string;
  notes: string[];
  samples: MemoryReport["samples"];
}

/** Default per-run growth threshold; env LOAM_APP_BENCH_THRESHOLD_MB. */
export const DEFAULT_THRESHOLD_MB = 64;

const DEFAULT_ITERATIONS = 25;
const DEFAULT_FIXTURE_CHARS = 200_000;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The fixed scenario's long-chat fixture: a large text blob, one per iteration. */
export function fixtureText(chars: number, seed: number): string {
  const chunk = `iteration ${seed} — long-chat fixture line. `;
  const out: string[] = [];
  let length = 0;
  let n = 0;
  while (length < chars) {
    out.push(chunk);
    n += 1;
    length += chunk.length;
    if (n % 200 === 0) out.push("\n");
  }
  return out.join("").slice(0, chars);
}

/** POST one iteration of the scenario; returns what happened. */
export async function runScenarioIteration(
  baseUrl: string,
  iteration: number,
  fixtureChars: number,
): Promise<AppSessionResult> {
  const result: AppSessionResult = {
    iteration,
    taskId: null,
    chatStatus: 0,
    memoryStatus: 0,
    chatBytes: 0,
    memoryBytes: 0,
    error: null,
  };
  try {
    // 1. A chat run: creates a task, opens an SSE stream and drives the agent
    //    loop. This is the long-chat fixture path — a run that allocates a
    //    transcript, an event stream and per-task caches.
    const chatRes = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: fixtureText(fixtureChars, iteration), title: `J6 app bench ${iteration}` }),
      cache: "no-store",
    });
    result.chatStatus = chatRes.status;
    const chatText = await chatRes.text();
    result.chatBytes = Buffer.byteLength(chatText, "utf8");
    const taskId = /"taskId":"([^"]+)"/.exec(chatText)?.[1];
    if (taskId) result.taskId = taskId;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  try {
    // 2. A large memory-store POST: the companion memory path retains the text
    //    plus an embedding, so it is the second long-lived allocation per turn.
    const memRes = await fetch(`${baseUrl}/api/memory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: fixtureText(fixtureChars, iteration), kind: "task" }),
      cache: "no-store",
    });
    result.memoryStatus = memRes.status;
    const memText = await memRes.text();
    result.memoryBytes = Buffer.byteLength(memText, "utf8");
  } catch (err) {
    result.error = result.error ?? (err instanceof Error ? err.message : String(err));
  }
  return result;
}

/**
 * Best-effort provenance: the git revision of the tree being measured, with a
 * `-dirty` suffix when the working tree has uncommitted changes. That suffix is
 * what lets a BEFORE run on a clean base commit be distinguished from an AFTER
 * run on the same commit with the change applied but not yet committed.
 */
export function readSourceCommit(): string | undefined {
  const run = (args: string[]) =>
    execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    const head = run(["rev-parse", "HEAD"]);
    if (!head) return undefined;
    let dirty = false;
    try {
      dirty = run(["status", "--porcelain"]).length > 0;
    } catch {
      /* not a git work tree; report the bare revision */
    }
    return dirty ? `${head}-dirty` : head;
  } catch {
    return undefined;
  }
}

/** Read the server's own bounded-cache counters from the local debug route. */
export async function readServerCounters(baseUrl: string): Promise<{
  retainedCacheBytes: number;
  cacheEntries: number;
  cacheCount: number;
  /** True when `/api/debug/memory` answered 200 (i.e. the server is J6-aware). */
  debugRoutePresent: boolean;
}> {
  try {
    const res = await fetch(`${baseUrl}/api/debug/memory`, { cache: "no-store" });
    if (!res.ok) return { retainedCacheBytes: 0, cacheEntries: 0, cacheCount: 0, debugRoutePresent: false };
    const body = (await res.json()) as {
      totals?: { caches: number; entries: number; bytes: number };
    };
    return {
      retainedCacheBytes: body.totals?.bytes ?? 0,
      cacheEntries: body.totals?.entries ?? 0,
      cacheCount: body.totals?.caches ?? 0,
      debugRoutePresent: true,
    };
  } catch {
    return { retainedCacheBytes: 0, cacheEntries: 0, cacheCount: 0, debugRoutePresent: false };
  }
}

/** Wait until the server answers /api/health, or give up. */
export async function waitForServer(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`, { cache: "no-store" });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await delay(150);
  }
  return false;
}

/** Run the whole benchmark and return the JSON report. */
export async function runAppBench(options: AppBenchOptions = {}): Promise<AppBenchReport> {
  const iterations = Math.max(1, Math.floor(options.iterations ?? Number(process.env.LOAM_APP_BENCH_ITERATIONS ?? DEFAULT_ITERATIONS)));
  const fixtureChars = Math.max(1, Math.floor(options.fixtureChars ?? DEFAULT_FIXTURE_CHARS));
  const sampleMs = Math.max(0, options.sampleMs ?? 4000);
  const intervalMs = Math.max(1, options.intervalMs ?? 100);
  const thresholdMB =
    options.thresholdMB ?? (process.env.LOAM_APP_BENCH_THRESHOLD_MB ? Number(process.env.LOAM_APP_BENCH_THRESHOLD_MB) : DEFAULT_THRESHOLD_MB);
  const port = options.port ?? Number(process.env.LOAM_PORT ?? 3939);
  const baseUrl = options.baseUrl ?? `http://127.0.0.1:${port}`;
  const notes: string[] = [];
  const started = Date.now();

  // Baseline: one snapshot of this process tree before any work.
  const idleReport: MemoryReport = await sampleProcessTree([process.pid], { timeoutMs: 1, intervalMs: 1 });

  const sessions: AppSessionResult[] = [];
  for (let i = 1; i <= iterations; i++) {
    sessions.push(await runScenarioIteration(baseUrl, i, fixtureChars));
    // Keep the iterations short and independent of the sampling window, like the
    // J2 harness's session settle delay.
    if (i < iterations) await delay(50);
  }

  const report: MemoryReport = await sampleProcessTree([process.pid], { timeoutMs: sampleMs, intervalMs });
  const peakMB = Math.max(report.peakMB, idleReport.peakMB);
  const finalMB = report.finalMB;
  const growthMB = Math.max(0, peakMB - idleReport.idleMB);

  const counters = await readServerCounters(baseUrl);
  const thresholdExceeded = growthMB > thresholdMB;
  // Best-effort provenance: which revision was measured, and whether the server
  // under test already exposes the J6 debug route (a BEFORE run on the base
  // commit has neither, which is exactly what makes the comparison meaningful).
  const sourceCommit = readSourceCommit();
  const debugRoutePresent = counters.debugRoutePresent;

  const result: AppBenchReport = {
    kind: "app-scenario",
    launcher: "app-scenario",
    iterations,
    port,
    sourceCommit,
    debugRoutePresent,
    idleMB: round1(idleReport.idleMB),
    peakMB: round1(peakMB),
    finalMB: round1(finalMB),
    growthMB: round1(growthMB),
    lastSampleMB: round1(report.samples[report.samples.length - 1]?.totalMB ?? finalMB),
    retainedCacheBytes: counters.retainedCacheBytes,
    cacheEntries: counters.cacheEntries,
    cacheCount: counters.cacheCount,
    sessions,
    thresholdMB,
    thresholdExceeded,
    durationMs: Date.now() - started,
    platform: process.platform,
    notes,
    samples: report.samples,
  };

  if (options.jsonOut) {
    try {
      fs.mkdirSync(path.dirname(options.jsonOut), { recursive: true });
      fs.writeFileSync(options.jsonOut, JSON.stringify(result, null, 2), "utf8");
    } catch (err) {
      notes.push(`could not write ${options.jsonOut}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

export const HELP_TEXT = `Loam J6 app-RAM benchmark (offline, local server only)

Usage: npm run bench:ram:app -- [options]

Options:
  --port <n>            Server port (default 3939; env LOAM_PORT)
      --base-url <url>  Override the base URL entirely
      --iterations <n>  Scenario iterations (default 25; env LOAM_APP_BENCH_ITERATIONS)
      --fixture-chars <n>  Characters per iteration (default 200000)
      --threshold <mb>  Fail when total growth exceeds this (default 64,
                        env LOAM_APP_BENCH_THRESHOLD_MB)
      --sample-ms <ms>   Sampling window (default 4000)
      --interval-ms <ms> Sample interval (default 100)
      --json-out <path>  Also write the JSON report here
      --data-dir <path>  Data dir the spawned server owns (default: a fresh
                        temp dir, so the bench never touches the app's live
                        database)
      --ready-timeout-ms <ms>  How long to wait for the spawned server to
                        answer /api/health (default 120000; a cold Node + tsx
                        start can take a while)
      --spawn            Start the real server first (src/index.ts), then stop it
  -h, --help            Show this help

The scenario is fixed and offline: each iteration opens a chat run against the
local server (a fresh task, SSE stream and transcript) plus a large memory-store
POST, then the server's own bounded-cache counters are read back. No real model
API is called and nothing leaves the machine.
`;

interface CliArgs {
  port?: number;
  baseUrl?: string;
  iterations?: number;
  fixtureChars?: number;
  thresholdMB?: number;
  sampleMs?: number;
  intervalMs?: number;
  jsonOut?: string;
  /** Isolated data dir for the spawned server (default: a fresh temp dir). */
  dataDir?: string;
  /** How long to wait for the spawned server to answer /api/health. */
  readyTimeoutMs?: number;
  spawn?: boolean;
  help?: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    const next = () => argv[++i];
    switch (token) {
      case "--port":
        args.port = Number(next());
        break;
      case "--base-url":
        args.baseUrl = next();
        break;
      case "--iterations":
        args.iterations = Number(next());
        break;
      case "--fixture-chars":
        args.fixtureChars = Number(next());
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
      case "--json-out":
        args.jsonOut = next();
        break;
      case "--data-dir":
        args.dataDir = next();
        break;
      case "--ready-timeout-ms":
        args.readyTimeoutMs = Number(next());
        break;
      case "--cwd":
        args.cwd = next();
        break;
      case "--spawn":
        args.spawn = true;
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

/** Start the real server as a child, so the benchmark measures it. */
export async function spawnServer(
  env: Record<string, string> = {},
  dataDir: string = benchDataDir(),
  port: number = Number(process.env.LOAM_APP_BENCH_PORT ?? 3947),
): Promise<ChildProcess> {
  fs.mkdirSync(dataDir, { recursive: true });
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      LOAM_PORT: String(port),
      LOAM_AUTH_DISABLED: "true",
      LOAM_APP_BENCH: "1",
      // The server takes an exclusive lease on its data dir; point it at a
      // throwaway copy so the bench never disturbs the app's live database.
      LOAM_DATA_DIR: dataDir,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return child;
}

/** Stop the server child, tolerating an already-exited process. */
export function stopServer(child: ChildProcess | null): void {
  if (!child) return;
  try {
    child.kill();
  } catch {
    /* already gone */
  }
}

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

  let serverChild: ChildProcess | null = null;
  let baseUrl = args.baseUrl;
  let dataDir: string | null = args.dataDir ? path.resolve(args.dataDir) : null;
  if (args.spawn && !baseUrl) {
    const port = Number(args.port ?? process.env.LOAM_APP_BENCH_PORT ?? 3947);
    dataDir ??= benchDataDir();
    serverChild = await spawnServer({}, dataDir, port);
    baseUrl = `http://127.0.0.1:${port}`;
    const readyTimeoutMs = args.readyTimeoutMs ?? Number(process.env.LOAM_APP_BENCH_READY_TIMEOUT_MS ?? 120_000);
    const up = await waitForServer(baseUrl, readyTimeoutMs);
    if (!up) {
      stopServer(serverChild);
      process.stderr.write(`server did not become ready on ${baseUrl}\n`);
      return 1;
    }
  }

  const report = await runAppBench({
    baseUrl,
    port: args.port,
    iterations: args.iterations,
    fixtureChars: args.fixtureChars,
    thresholdMB: args.thresholdMB,
    sampleMs: args.sampleMs,
    intervalMs: args.intervalMs,
    jsonOut: args.jsonOut,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  stopServer(serverChild);
  if (dataDir) {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* the temp data dir is disposable */
    }
  }
  if (report.thresholdExceeded) {
    process.stdout.write(`threshold exceeded: growthMB ${report.growthMB} > ${report.thresholdMB}\n`);
    return 1;
  }
  return 0;
}

// Run only when invoked directly (node --import tsx bench/appRamBench.ts ...).
const invokedDirectly = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  : false;
if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`bench:ram:app failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}

// Keep os referenced for platforms that expose tmpdir in the report path helper.
export const TMP_DIR = os.tmpdir();
