// Adapted from jcode (MIT) ref/jcode_daemon_bench.py (shared daemon control socket)
//
// J1 launcher layer. Two launcher shapes are benchmarked against the same bench
// fixture and the same fake model:
//
//   per-process (BEFORE) — one heavyweight `node --import tsx` process per coding
//                         session, the shape Loam's coding launcher has today
//                         (code_session -> `opencode run`, or a per-task agent).
//   shared (AFTER)       — ONE long-lived agent server process hosting N
//                         concurrent sessions over a control socket. The server
//                         itself is production code (src/server/sharedCodeSession.ts);
//                         the bench only starts it and drives its control socket,
//                         so the measured shape is the shape `code_session
//                         launcher: "shared"` actually uses.
//
// `runLauncherBench` measures both with the same sampler so the marginal
// per-session cost is comparable, and writes the committed J1 before/after JSON.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sampleProcessTree, type MemoryReport } from "./rssSampler.js";
import { FakeModelServer, type ScriptedTurn } from "./fakeModel.js";
import { benchEnvFromProcessEnv } from "./perProcess.js";
import { CALC_PY, TEST_CALC_PY, makeCalcRepo, isFixed } from "./memBench.js";
import {
  SharedControlClient,
  defaultCodeSessionSocketPath,
  isNamedPipePath,
  isValidSessionId,
  waitForSharedSocket,
} from "../src/server/sharedCodeSession.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Loam project root (bench/ -> ..); `node --import tsx` must run from here. */
export const PROJECT_ROOT = path.join(HERE, "..");

/** Production entry point of the shared agent server (the AFTER launcher). */
export const SHARED_SERVER_ENTRY = path.join(PROJECT_ROOT, "src", "server", "sharedCodeSession.ts");

/**
 * The bench turn script, spelled with Loam's own tool names. The default
 * `read`/`edit`/`bash` names in bench/fakeModel.ts are not registered in a Loam
 * registry, so a session would fail every tool call and never fix the fixture.
 */
export const BENCH_SEQUENCE = [
  { tool: { name: "file_read", arguments: { path: "calc.py" } } },
  {
    tool: {
      name: "file_edit",
      arguments: { path: "calc.py", old_string: "return a - b", new_string: "return a + b" },
    },
  },
  { tool: { name: "shell_run", arguments: { command: `py ${path.join(HERE, "runTests.js")}`, description: "run tests" } } },
  { text: "Fixed add(): it subtracted instead of adding. Tests pass." },
];

export type LauncherKind = "per-process" | "shared";

/**
 * The J1 acceptance budget: once the shared server is running, each additional
 * session must cost less than this. Enforced by the CLI so a regression fails CI.
 */
export const MARGINAL_SESSION_TARGET_MB = 10;

export interface LauncherSpec {
  kind: LauncherKind;
  /** Human label recorded in the report. */
  name: string;
  /** Command used for one session (for diagnostics/notes). */
  command: string;
}

export interface LauncherSessionResult {
  index: number;
  cwd: string;
  pid: number | null;
  /** Whether the session really changed the on-disk fixture. */
  fixed: boolean;
  /** Session id inside the shared server (shared launcher only). */
  sessionId?: string;
  steps?: number;
  output: string;
}

export interface LauncherReport {
  launcher: string;
  kind: LauncherKind;
  N: number;
  idleMB: number;
  peakMB: number;
  finalMB: number;
  /**
   * `(peakMB - idleMB) / N`: the average memory each session appears to cost when
   * the launcher's own fixed overhead is spread across the sessions. For the
   * per-process shape this is the honest per-session number (every session is a
   * whole process). For the shared shape it overstates the marginal cost, because
   * the one-time server startup is divided by N as well.
   */
  perSessionMB: number;
  /** Peak of the same launcher at N=1: its fixed, one-time overhead. */
  baselineMB: number | null;
  /**
   * `(peakMB - baselineMB) / (N - 1)`: what each *additional* session costs once
   * the launcher is already running. This is the number the J1 target is about
   * ("marginal session < 10 MB in shared mode") and the one that shows whether
   * sharing actually helps. Null when no N=1 baseline is available or N=1.
   */
  marginalSessionMB: number | null;
  fixed: number;
  sessions: LauncherSessionResult[];
  durationMs: number;
  platform: string;
  notes: string[];
}

export interface RunLauncherBenchOptions {
  /** Number of concurrent sessions. */
  n: number;
  kind: LauncherKind;
  /** Sampling window; each sample costs one OS snapshot. */
  sampleMs?: number;
  intervalMs?: number;
  /** Fake model bind host/port; defaults to an ephemeral 127.0.0.1 port. */
  modelHost?: string;
  modelPort?: number;
  model?: string;
  /**
   * Turn script the fake model replays. Defaults to `BENCH_SEQUENCE`, which fixes
   * the fixture. Tests override it to make a session genuinely fail without
   * waiting out the agent loop's retry budget.
   */
  sequence?: ScriptedTurn[];
  suppressFinal?: boolean;
  /** Keep the generated repos (debugging). */
  keepCwd?: boolean;
  cwd?: string;
  /** Override the shared server's control socket (tests). */
  socketPath?: string;
  /** Injectable spawner for tests. */
  spawnImpl?: SpawnFn;
  /** Peak already measured for this kind at N=1; enables marginalSessionMB. */
  baselineMB?: number;
}

export interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: ["ignore", "pipe", "pipe"];
  windowsHide: boolean;
}

/** How the bench starts child processes; injectable so tests can assert the contract. */
export type SpawnFn = (file: string, args: string[], options: SpawnOptions) => ChildProcess;

const defaultSpawn: SpawnFn = (file, args, options) => spawn(file, args, options);

/**
 * True when a path is usable as a control socket on this platform: a named pipe
 * on Windows, a plain path elsewhere. Lets callers (and tests) assert the shape
 * without spawning a server.
 */
export function usableSocketPath(socketPath: string): boolean {
  return process.platform === "win32" ? isNamedPipePath(socketPath) : !isNamedPipePath(socketPath);
}

/**
 * Spawn the long-lived shared agent server process.
 * `LOAM_BENCH_SESSION=shared` marks it so the bench can tell the two shapes apart.
 */
export function spawnSharedServer(
  options: {
    socketPath: string;
    modelUrl: string;
    model?: string;
    suppressFinal?: boolean;
  },
  spawnImpl: SpawnFn = defaultSpawn,
): ChildProcess {
  const benchEnv = benchEnvFromProcessEnv();
  const args = [
    SHARED_SERVER_ENTRY,
    options.socketPath,
    options.modelUrl,
    options.model ?? "",
    options.suppressFinal === false ? "0" : "1",
    // Pin every session to the fake model: the bench must never reach the host's
    // real failover chain.
    "1",
  ];
  return spawnImpl(process.execPath, ["--import", "tsx", ...args], {
    cwd: PROJECT_ROOT,
    env: {
      ...benchEnv,
      LOAM_BENCH_SESSION: "shared",
      ...(options.model ? { LOAM_BENCH_MODEL: options.model } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

/** Spawn one per-process session (BEFORE shape). */
export function spawnPerProcess(
  options: {
    cwd: string;
    modelUrl: string;
    model?: string;
    suppressFinal?: boolean;
  },
  spawnImpl: SpawnFn = defaultSpawn,
): ChildProcess {
  const benchEnv = benchEnvFromProcessEnv();
  const args = [
    path.join(HERE, "perProcess.ts"),
    options.cwd,
    options.modelUrl,
    options.model ?? "",
    options.suppressFinal === false ? "0" : "1",
  ];
  return spawnImpl(process.execPath, ["--import", "tsx", ...args], {
    // cwd must be the project root so Node can resolve `tsx`; the session's own
    // workspace is passed as an argument and used for every tool call.
    cwd: PROJECT_ROOT,
    env: {
      ...benchEnv,
      LOAM_BENCH_SESSION: "per-process",
      ...(options.model ? { LOAM_BENCH_MODEL: options.model } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

/**
 * Run one launcher shape over the generated bench repos and return its report.
 *
 * `fixed` is the honest signal: a session counts as fixed when its repo's
 * `calc.py` really contains `return a + b`. The shared launcher reports the
 * session status from the server; the per-process launcher reads the child's
 * exit code. Both are compared against the on-disk result at the end.
 */
export async function runLauncherBench(options: RunLauncherBenchOptions): Promise<LauncherReport> {
  const n = Math.max(1, Math.floor(options.n));
  const sampleMs = Math.max(0, options.sampleMs ?? 4000);
  const intervalMs = Math.max(1, options.intervalMs ?? 100);
  const notes: string[] = [];
  const started = Date.now();
  const spawnImpl = options.spawnImpl ?? defaultSpawn;

  // One fake model serves every session in this run, exactly like the real setup.
  // `transport: "ollama"` because the agent loop calls `OllamaClient.chatLocal`
  // (`/api/chat`, NDJSON), not the OpenAI-compatible cloud path.
  const model = new FakeModelServer({
    host: options.modelHost ?? "127.0.0.1",
    port: options.modelPort ?? 0,
    sequence: options.sequence ?? BENCH_SEQUENCE,
    transport: "ollama",
    ...(options.model ? { model: options.model } : {}),
  });
  await model.start();
  const modelUrl = model.baseUrl;
  notes.push(`fake model ${modelUrl}`);

  const baseDir = options.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), "loam-j1-"));
  const cwds: string[] = [];
  for (let i = 0; i < n; i++) {
    // Every session gets its own repo under the base dir, even when the caller
    // supplied one: sessions run concurrently, so sharing a workspace would let
    // them edit the same files. `keepCwd` only controls whether it is deleted.
    const cwd = path.join(baseDir, `s${i}`);
    makeCalcRepo(cwd);
    cwds.push(cwd);
  }

  const sessions: LauncherSessionResult[] = [];
  let server: ChildProcess | null = null;

  try {
    const idleReport: MemoryReport = await sampleProcessTree([process.pid], { timeoutMs: 1, intervalMs: 1 });

    // Sample *while* the sessions run. Sampling after they finish would only see
    // whatever is left behind, which is exactly the wrong number: the J1 question
    // is how much memory N concurrent sessions hold at once.
    let peakMB = idleReport.peakMB;
    let finalMB = idleReport.finalMB;
    const sampleDuring = async (work: () => Promise<void>): Promise<void> => {
      const workDone = work();
      // Sample for the whole run, stopping when the run's work is done. The window
      // must not *cap* the run: N=30 takes ~15s, and capping the sampler at the
      // 4s default truncates the peak (1.49 GB instead of the real 2.56 GB).
      // `sampleMs` is therefore the backstop, not the deadline, and the sampler's
      // own stop handling bounds a run that never finishes.
      const sampler = sampleProcessTree([process.pid], {
        timeoutMs: Math.max(sampleMs, MAX_SAMPLE_WINDOW_MS),
        intervalMs,
        stop: workDone,
      });
      // Await both: awaiting only the sampler would swallow a failure in the
      // work (for example every control send rejecting) and report a run whose
      // sessions never ran at all.
      const [report] = await Promise.all([sampler, workDone]);
      peakMB = Math.max(peakMB, report.peakMB, idleReport.peakMB);
      finalMB = report.finalMB;
    };

    if (options.kind === "shared") {
      const socketPath = options.socketPath ?? defaultCodeSessionSocketPath();
      server = spawnSharedServer(
        {
          socketPath,
          modelUrl,
          ...(options.model ? { model: options.model } : {}),
          suppressFinal: options.suppressFinal ?? true,
        },
        spawnImpl,
      );
      notes.push(`shared server pid=${server.pid ?? "unknown"} socket=${socketPath}`);
      await waitForSharedSocket(socketPath);

      await sampleDuring(async () => {
        // One control connection per session. A single connection would have to
        // correlate replies by order, but the server runs sessions concurrently
        // and may answer out of order; one client each makes the mapping exact.
        const clients: SharedControlClient[] = [];
        for (let i = 0; i < n; i++) {
          const client = new SharedControlClient(socketPath);
          await client.connect();
          clients.push(client);
          const reply = await client.send("create_session", cwds[i]!);
          const sessionId = typeof reply.session === "string" ? reply.session : undefined;
          if (!sessionId || !isValidSessionId(sessionId)) {
            notes.push(`session ${i}: create_session returned ${JSON.stringify(reply)}`);
          }
          sessions.push({
            index: i,
            cwd: cwds[i]!,
            pid: server!.pid ?? null,
            fixed: false,
            ...(sessionId ? { sessionId } : {}),
            output: "",
          });
        }
        // Every session now runs at once in the one server process; that is the
        // shared-model claim the peak measurement is testing.
        await Promise.all(
          sessions.map(async (session, i) => {
            const client = clients[i]!;
            const reply = await client.send(
              "message",
              JSON.stringify({ session: session.sessionId, text: BENCH_PROMPT }),
            );
            const status = typeof reply.status === "string" ? reply.status : "failed";
            session.output = JSON.stringify(reply);
            if (typeof reply.steps === "number") session.steps = reply.steps;
            if (status !== "done") notes.push(`session ${i}: ${status} ${String(reply.error ?? "")}`);
          }),
        );
        await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
      });
    } else {
      await sampleDuring(async () => {
        // Spawn every session first so all N overlap, then wait for them. Each
        // child is a whole Node runtime, which is the cost this shape pays per task.
        await Promise.all(
          cwds.map(async (cwd, i) => {
            const child = spawnPerProcess(
              {
                cwd,
                modelUrl,
                ...(options.model ? { model: options.model } : {}),
                suppressFinal: options.suppressFinal ?? true,
              },
              spawnImpl,
            );
            // A short settle keeps the children from starting in the same tick,
            // which matches the real concurrent-task case (each task is dispatched
            // when it arrives, not all at once).
            await delay(SESSION_SETTLE_MS);
            return child;
          }),
        ).then((started) =>
          Promise.all(
            started.map(async (child, i) => {
              sessions.push({ index: i, cwd: cwds[i]!, pid: child.pid ?? null, fixed: false, output: "" });
              sessions[i]!.output = await collectOutput(child);
            }),
          ),
        );
      });
    }

    for (const session of sessions) {
      session.fixed = isFixed(session.cwd);
    }
    const fixed = sessions.filter((s) => s.fixed).length;
    const baselineMB = options.baselineMB ?? null;
    return {
      launcher: options.kind,
      kind: options.kind,
      N: n,
      idleMB: idleReport.idleMB,
      peakMB: round1(peakMB),
      finalMB: round1(finalMB),
      perSessionMB: n > 0 ? round1(Math.max(0, peakMB - idleReport.idleMB) / n) : 0,
      baselineMB: baselineMB === null ? null : round1(baselineMB),
      marginalSessionMB:
        baselineMB === null || n < 2 ? null : round1(Math.max(0, peakMB - baselineMB) / (n - 1)),
      fixed,
      sessions,
      durationMs: Date.now() - started,
      platform: process.platform,
      notes,
    };
  } finally {
    if (server) {
      try {
        server.kill();
      } catch {
        /* already gone */
      }
    }
    await model.stop();
    if (!options.keepCwd) {
      try {
        fs.rmSync(baseDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

/** The prompt each bench session receives (one sentence, fixture-specific). */
export const BENCH_PROMPT = "Fix the failing test in this repository and report what you changed.";

/** How long to let each per-process session start before spawning the next. */
export const SESSION_SETTLE_MS = 1500;

/**
 * Buffered stdout+stderr for a spawned child.
 *
 * Always resolves when the child exits. A child that exits before the caller
 * attaches its listeners has already drained its pipes, so the only signal left
 * is `exit`/`close`; relying on stream `end` alone would leave the promise
 * pending (and the benchmark waiting out its 120s backstop) for fast sessions.
 */
export function collectOutput(child: ChildProcess): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      resolve(Buffer.concat(chunks).toString("utf8").slice(0, 2000));
    };
    // A child that exited before this was called has already drained its pipes and
    // will never emit `exit`/`close` again: resolve on its recorded exit code
    // instead of waiting out the backstop.
    if (child.exitCode !== null || child.signalCode !== null) {
      finish();
      return;
    }
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      // Attach immediately: a fast child can close its pipes before a caller
      // gets here, which would silently lose its output.
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    }
    child.once("error", finish);
    child.once("close", finish);
    child.once("exit", finish);
    // Backstop only: a child that somehow never emits close/exit must not hang
    // the benchmark forever. Real exits are always observed above. Unref'd so an
    // armed timer cannot keep the process alive after its report is written: an
    // isolated measurement would otherwise linger the full 120s and its parent
    // would wait on that timer for every measurement.
    later(finish, 120_000).unref();
  });
}

function later(fn: () => void, ms: number): NodeJS.Timeout {
  return setTimeout(fn, ms);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// ---------------------------------------------------------------------------
// CLI: npm run bench:j1 -- [--n 1,10,30] [--json-out bench/results/J1-after.json]
// ---------------------------------------------------------------------------

interface CliArgs {
  n?: number[];
  sampleMs?: number;
  intervalMs?: number;
  cooldownMs?: number;
  jsonOut?: string;
  beforeOut?: string;
  afterOut?: string;
  help?: boolean;
  kinds?: LauncherKind[];
  /** Isolated single-measurement mode: `--isolate <kind>`. */
  isolate?: LauncherKind;
  /** N=1 peak used to compute the marginal cost in isolated mode. */
  baselineMB?: number;
  /** Where the isolated measurement writes its JSON report. */
  reportOut?: string;
}

export function parseJ1Args(argv: string[]): CliArgs {
  const args: CliArgs = { kinds: ["per-process", "shared"] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    const next = (): string => argv[++i]!;
    switch (token) {
      case "--n":
      case "-n": {
        const value = next();
        args.n = value.split(",").map((part) => Number(part.trim())).filter((v) => Number.isFinite(v) && v > 0);
        break;
      }
      case "--sample-ms":
        args.sampleMs = Number(next());
        break;
      case "--interval-ms":
        args.intervalMs = Number(next());
        break;
      case "--cooldown-ms":
        args.cooldownMs = Number(next());
        break;
      case "--json-out":
        args.jsonOut = next();
        break;
      case "--before-out":
        args.beforeOut = next();
        break;
      case "--after-out":
        args.afterOut = next();
        break;
      case "--kinds":
        args.kinds = next().split(",").map((k) => k.trim()) as LauncherKind[];
        break;
      case "--isolate":
        args.isolate = next() as LauncherKind;
        break;
      case "--baseline-mb":
        args.baselineMB = Number(next());
        break;
      case "--report-out":
        args.reportOut = next();
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

export const J1_HELP_TEXT = `Loam J1 shared-agent benchmark (mock model, offline)

Usage: npm run bench:j1 -- [options]

Options:
  -n, --n <list>        Comma-separated session counts (default 1,10,30)
      --kinds <list>    Launcher shapes to run: per-process,shared (default both)
      --sample-ms <ms>  Sampling window (default 4000)
      --interval-ms <ms> Sample interval (default 100)
      --cooldown-ms <ms> Pause between measurements (default 8000; 0 disables)
      --isolate <kind>   Run exactly one measurement of this shape (child mode)
      --baseline-mb <mb> N=1 peak for the marginal calculation (child mode)
      --report-out <path> Where the isolated measurement writes its JSON report
      --json-out <path> Write the JSON report here
      --before-out <path> Write the BEFORE (per-process) shape reports here
      --after-out <path>  Write the AFTER (shared) shape reports here
  -h, --help            Show this help
`;

export interface J1Report {
  before: LauncherReport[];
  after: LauncherReport[];
  generatedAt: string;
  platform: string;
  fakeModel: string;
  notes: string[];
}

/**
 * Floor for the sampler window: the window must never *cap* a run that is still
 * going. N=30 spawns 30 sessions one settle-delay apart (~45s of settling) and
 * peaks part way through, so a window shorter than the run truncates the peak
 * (4s gave 1.49 GB where the real peak is 2.56 GB). The sampler's stop signal
 * ends sampling as soon as the run's work is done, so this only bounds a run
 * that never finishes.
 */
const MAX_SAMPLE_WINDOW_MS = 120_000;

/**
 * Run one measurement in a fresh child process and read its report back.
 *
 * Memory benchmarks must not share a process with a previous measurement. The
 * per-process N=30 run peaks around 4.2 GB, and V8 answers that pressure by
 * growing the *next* measurement's heap, so a shared N=30 measured afterwards
 * reads ~36 MB/session instead of the ~2 MB it really costs. Each measurement in
 * its own process makes the AFTER number a property of the launcher, not of the
 * measurement order.
 */
async function runIsolatedMeasurement(options: {
  kind: LauncherKind;
  n: number;
  sampleMs?: number;
  intervalMs?: number;
  baselineMB?: number;
  reportOut: string;
  /** Injectable spawner so tests can assert the child invocation without spawning. */
  spawnImpl?: SpawnFn;
}): Promise<LauncherReport> {
  const args = [
    "--isolate",
    options.kind,
    "--n",
    String(options.n),
    "--sample-ms",
    String(options.sampleMs ?? 4000),
    "--interval-ms",
    String(options.intervalMs ?? 100),
    "--report-out",
    options.reportOut,
  ];
  if (options.baselineMB !== undefined) {
    args.push("--baseline-mb", String(options.baselineMB));
  }
  const child = (options.spawnImpl ?? spawn)(process.execPath, ["--import", "tsx", path.join(HERE, "launchers.ts"), ...args], {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const output = await new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    const done = (): void => resolve(Buffer.concat(chunks).toString("utf8"));
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("close", done);
    child.once("error", done);
    // Generous backstop: N=30 per-process spends ~45s settling alone. A child
    // that never exits must not hang the benchmark forever, but an armed timer
    // would keep this process alive long after the measurement finished.
    setTimeout(done, 1_800_000).unref();
  });
  if (!fs.existsSync(options.reportOut)) {
    throw new Error(
      `isolated ${options.kind} N=${options.n} measurement produced no report: ${output.slice(0, 2000)}`,
    );
  }
  const report = JSON.parse(fs.readFileSync(options.reportOut, "utf8")) as LauncherReport;
  try {
    fs.rmSync(options.reportOut, { force: true });
  } catch {
    /* best effort */
  }
  return report;
}

/** Run both launcher shapes at each N and return the combined report. */
export async function runJ1Bench(options: {
  n: number[];
  sampleMs?: number;
  intervalMs?: number;
  /**
   * Pause between measurements. Without it the shared run at a given N starts
   * while the per-process run at the same N is still being reclaimed by the OS,
   * and V8 responds to the memory pressure by growing the shared server's heap:
   * a shared N=30 measured right after 30 per-process children peaked ~992 MB,
   * against ~519 MB when the same run is measured on a settled machine. The
   * cooldown keeps the AFTER number a property of the launcher, not of the
   * measurement order.
   */
  cooldownMs?: number;
  jsonOut?: string;
  beforeOut?: string;
  afterOut?: string;
  kinds?: LauncherKind[];
  /** Injectable spawner, forwarded to every measurement (tests). */
  spawnImpl?: SpawnFn;
  /**
   * Run every measurement in its own child process (default true). Turn off for
   * tests that assert on the in-process spawn order.
   */
  isolateEach?: boolean;
}): Promise<J1Report> {
  const kinds = options.kinds ?? (["per-process", "shared"] as LauncherKind[]);
  const cooldownMs = Math.max(0, options.cooldownMs ?? 8000);
  const isolateEach = options.isolateEach ?? true;
  const before: LauncherReport[] = [];
  const after: LauncherReport[] = [];
  const notes: string[] = [];
  // Ascending N so the N=1 run of each shape is measured first and can serve as
  // that shape's fixed-overhead baseline for the marginal per-session number.
  const counts = [...options.n].sort((a, b) => a - b);
  const baselines = new Map<LauncherKind, number>();
  let measured = 0;
  // Launcher-outer, N-inner: every per-process measurement happens before any
  // shared one, so the AFTER numbers are never taken on a machine that the
  // BEFORE shape has just filled with dying 130 MB processes.
  for (const kind of kinds) {
    for (const n of counts) {
      // Let the previous measurement's processes exit and their memory be
      // reclaimed before starting the next one (see `cooldownMs`).
      if (measured > 0 && cooldownMs > 0) await delay(cooldownMs);
      measured += 1;
      const baselineMB = baselines.get(kind);
      const report = isolateEach
        ? await runIsolatedMeasurement({
            kind,
            n,
            sampleMs: options.sampleMs,
            intervalMs: options.intervalMs,
            ...(baselineMB !== undefined ? { baselineMB } : {}),
            reportOut: path.join(os.tmpdir(), `loam-j1-${kind}-${n}-${process.pid}.json`),
            ...(options.spawnImpl ? { spawnImpl: options.spawnImpl } : {}),
          })
        : await runLauncherBench({
            n,
            kind,
            sampleMs: options.sampleMs,
            intervalMs: options.intervalMs,
            model: "mock-coder",
            ...(options.spawnImpl ? { spawnImpl: options.spawnImpl } : {}),
            ...(baselineMB !== undefined ? { baselineMB } : {}),
          });
      if (n === counts[0]) baselines.set(kind, report.peakMB);
      (kind === "shared" ? after : before).push(report);
      notes.push(
        `${kind} N=${n}: perSessionMB=${report.perSessionMB} marginalSessionMB=${report.marginalSessionMB ?? "n/a"} fixed=${report.fixed}/${n}`,
      );
    }
  }
  if (cooldownMs > 0) {
    notes.push(`cooldown ${cooldownMs}ms between measurements (the OS reclaims the previous run's processes)`);
  }

  const payload: J1Report = {
    before,
    after,
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    fakeModel: "bench/fakeModel.ts (per-run ephemeral port)",
    notes,
  };
  if (options.jsonOut) {
    try {
      fs.mkdirSync(path.dirname(options.jsonOut), { recursive: true });
      fs.writeFileSync(options.jsonOut, JSON.stringify(payload, null, 2), "utf8");
    } catch (err) {
      notes.push(`could not write ${options.jsonOut}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Shape files: the BEFORE/AFTER halves on their own, each carrying every N.
  for (const [out, reports] of [
    [options.beforeOut, before],
    [options.afterOut, after],
  ] as Array<[string | undefined, LauncherReport[]]>) {
    if (!out || reports.length === 0) continue;
    try {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify(reports, null, 2), "utf8");
    } catch (err) {
      notes.push(`could not write ${out}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return payload;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: CliArgs;
  try {
    args = parseJ1Args(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n${J1_HELP_TEXT}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(J1_HELP_TEXT);
    return 0;
  }
  const counts = (args.n && args.n.length > 0 ? args.n : [1, 10, 30]).map((v) => Math.floor(v));
  // Child mode: one measurement, one process. The parent reads the report file.
  if (args.isolate) {
    const n = counts[0]!;
    let report: LauncherReport;
    let failure: string | null = null;
    try {
      report = await runLauncherBench({
        n,
        kind: args.isolate,
        model: "mock-coder",
        sampleMs: args.sampleMs,
        intervalMs: args.intervalMs,
        ...(args.baselineMB !== undefined ? { baselineMB: args.baselineMB } : {}),
      });
    } catch (err) {
      // Still write a report: the parent treats a missing file as a hard error,
      // so without this a crashed measurement looks like a hung one.
      failure = err instanceof Error ? err.message : String(err);
      report = {
        launcher: args.isolate,
        kind: args.isolate,
        N: n,
        idleMB: 0,
        peakMB: 0,
        finalMB: 0,
        perSessionMB: 0,
        baselineMB: args.baselineMB ?? null,
        marginalSessionMB: null,
        fixed: 0,
        sessions: [],
        durationMs: 0,
        platform: process.platform,
        notes: [`measurement failed: ${failure}`],
      };
    }
    const payload = JSON.stringify(report);
    if (args.reportOut) {
      fs.mkdirSync(path.dirname(args.reportOut), { recursive: true });
      fs.writeFileSync(args.reportOut, payload, "utf8");
    } else {
      process.stdout.write(`${payload}\n`);
    }
    if (failure) process.stderr.write(`isolated ${args.isolate} N=${n} failed: ${failure}\n`);
    return report.fixed < n ? 1 : 0;
  }
  const report = await runJ1Bench({
    n: counts,
    sampleMs: args.sampleMs,
    intervalMs: args.intervalMs,
    cooldownMs: args.cooldownMs,
    jsonOut: args.jsonOut,
    beforeOut: args.beforeOut,
    afterOut: args.afterOut,
    kinds: args.kinds,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  const failed = [...report.before, ...report.after].filter((r) => r.fixed < r.N);
  if (failed.length > 0) {
    process.stdout.write(`not all sessions fixed the task: ${failed.map((r) => `${r.launcher} N=${r.N} fixed=${r.fixed}`).join(", ")}\n`);
    return 1;
  }
  // The J1 target: a session added to an already-running shared server must stay
  // under this budget. Only the shared shape is gated; the per-process shape is
  // the BEFORE baseline this work is meant to improve on.
  const over = report.after.filter(
    (r) => r.marginalSessionMB !== null && r.marginalSessionMB >= MARGINAL_SESSION_TARGET_MB,
  );
  if (over.length > 0) {
    process.stdout.write(
      `shared marginal session cost over target (${MARGINAL_SESSION_TARGET_MB} MB): ${over
        .map((r) => `N=${r.N} marginal=${r.marginalSessionMB} MB`)
        .join(", ")}\n`,
    );
    return 1;
  }
  return 0;
}

// Run only when invoked directly (node --import tsx bench/launchers.ts ...).
const invokedDirectly = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  : false;
if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`bench:j1 failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}

// Re-exported so bench callers and tests share one implementation with production.
export {
  SharedCodeSessionServer,
  defaultCodeSessionSocketPath,
  isNamedPipePath,
  isValidSessionId,
  waitForSharedSocket,
} from "../src/server/sharedCodeSession.js";
export { CALC_PY, TEST_CALC_PY };
