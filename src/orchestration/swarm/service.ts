/**
 * C11: RealSwarmService, the self-organizing coding team.
 * Self-organizing swarm coordination model inspired by Agensh (Microsoft Research, MIT;
 * arXiv:2609.26781); shared-context idea traces to DeLM (arXiv:2606.10662).
 * Reimplemented independently for Loam.
 *
 * Mirrors SwarmService's class shape (lanes, persistence, cancel, interrupted-on-restart,
 * engine-executed merge; src/swarm/service.ts:156-301) without importing or editing it.
 * There is NO planner and NO stage DAG: the service only hands every worker the same goal.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "../../config.js";
import { DATA_DIR } from "../../config.js";
import type { OllamaClient } from "../../ollama.js";
import type { ToolRegistry } from "../../tools/registry.js";
import type { WorkerCheckpoint } from "../../agent/checkpoint.js";
import { runAgent } from "../../agent/loop.js";
import { taskPath } from "../../server/taskWorkspace.js";
import { isCloudModel } from "../../llm/cloudModel.js";
import { clampOrchestration, ORCHESTRATION_DEFAULTS } from "../config.js";
import { SPAN, LOAM } from "../tracing/genai.js";
import { CoordinationDb, coordinationDbPath } from "./board.js";
import { runWorkerTurn, type SwarmExecutor } from "./worker.js";
import { FORCED_WRITE_NUDGE, idleNudge, mergeConflictNote } from "./prompt.js";
import { loamSwarmCoreFactory, type SwarmCoreBinding, type SwarmCoreFactory } from "./corePort.js";
import { loamSwarmHost, type SwarmHost } from "./loamHost.js";
import {
  addWorkerWorktree, branchDiff, claimBranch, currentBranch, initRunRepo, lastCommitEpochSec,
  mainCommitCount, mainMergeCount, mergeWorkerBranch, removeWorktrees, switchClaimBranch, type MergeOutcome,
} from "./workspace.js";
import {
  HARD_MAX_WORKERS, MAX_ACTIVE_REALSWARM_RUNS, MAX_TURNS_PER_WORKER, REALSWARM_LANES,
  type CreateRealSwarmInput, type RealSwarmSnapshot, type RunStatus, type SwarmSpan, type SwarmUsage, type WorkerState,
} from "./types.js";

export class RealSwarmError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "RealSwarmError";
  }
}

export interface RealSwarmServiceOptions {
  cfg: Config;
  ollama: OllamaClient;
  tools: ToolRegistry;
  dataDir?: string;
  /** Defaults to runAgent, as SwarmService does (src/swarm/service.ts:573). */
  executor?: SwarmExecutor;
  /** Defaults to one Orchestration Core per run (C1/C2/C3/C5 through public.ts). */
  coreFactory?: SwarmCoreFactory;
  host?: SwarmHost;
  /** Watchdog period. Default 1000 ms. */
  tickMs?: number;
  /** Internal seam for tests only: shorter timings than the clamped config allows. */
  testTiming?: { idleNudgeMs?: number; activationStaggerMs?: number; retryBackoffMs?: readonly number[] };
}

type StopReason = NonNullable<RealSwarmSnapshot["completionReason"]> | "interrupted";

interface ActiveRun {
  ctl: AbortController;
  reason?: StopReason;
  db?: CoordinationDb;
  binding?: SwarmCoreBinding;
  runSpan?: SwarmSpan;
  workerSpans: Map<string, SwarmSpan>;
  revisions: Map<string, number>;
  conflicted: Map<string, Set<string>>;
  merged: Set<string>;
  recentTexts: Map<string, string[]>;
  deadlineAt: number;
  baseMerges: number;
  done: Promise<void>;
}

const RUN_ID = /^realswarm_[a-f0-9-]{36}$/;
const RUN_FILE = /^realswarm_[a-f0-9-]{36}\.json$/;
const isActive = (s: RunStatus) => s === "queued" || s === "running";
const iso = () => new Date().toISOString();
const zeroUsage = (): SwarmUsage => ({ promptTokens: 0, completionTokens: 0, durationMs: 0, modelCalls: 0 });
const copy = <T>(v: T): T => structuredClone(v);

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, Math.max(0, ms));
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Process-wide cap on concurrent worker turns across all runs (U9: provider rate limits). */
class TurnGate {
  private busy = 0;
  private waiters: Array<() => void> = [];
  constructor(public capacity: number) {}
  async acquire(signal: AbortSignal): Promise<(() => void) | null> {
    while (this.busy >= this.capacity) {
      if (signal.aborted) return null;
      await new Promise<void>((resolve) => {
        const wake = () => {
          signal.removeEventListener("abort", wake);
          resolve();
        };
        this.waiters.push(wake);
        signal.addEventListener("abort", wake, { once: true });
      });
    }
    if (signal.aborted) return null;
    this.busy++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.busy--;
      this.waiters.shift()?.();
    };
  }
}

export class RealSwarmService {
  private readonly runs = new Map<string, RealSwarmSnapshot>();
  private readonly active = new Map<string, ActiveRun>();
  private readonly dir: string;
  private readonly host: SwarmHost;
  private readonly executor: SwarmExecutor;
  private readonly coreFactory: SwarmCoreFactory;
  private readonly gate: TurnGate;
  private readonly tickMs: number;
  private busyLanes = 0;
  private laneWaiters: Array<() => void> = [];
  private closed = false;

  constructor(private readonly opts: RealSwarmServiceOptions) {
    this.dir = taskPath(opts.dataDir ?? DATA_DIR, "realswarm");
    fs.mkdirSync(this.dir, { recursive: true });
    this.host = opts.host ?? loamSwarmHost(opts.cfg);
    this.executor = opts.executor ?? runAgent;
    this.coreFactory = opts.coreFactory ?? loamSwarmCoreFactory(opts.cfg, opts.ollama);
    this.gate = new TurnGate(this.swarmCfg().maxInFlightTurns);
    this.tickMs = opts.tickMs ?? 1000;
    // Interrupted-on-restart: the same rule as SwarmService (src/swarm/service.ts:169-185).
    for (const file of fs.readdirSync(this.dir)) {
      if (!RUN_FILE.test(file)) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(this.dir, file), "utf8")) as RealSwarmSnapshot;
        if (`${s.id}.json` !== file || !Array.isArray(s.workers) || !Array.isArray(s.events)) continue;
        this.runs.set(s.id, s);
        if (isActive(s.status)) {
          s.status = "interrupted";
          s.error = "Application stopped during the run. Resume restores each worker from its checkpoint; retry starts fresh workers on the same board and repository.";
          for (const w of s.workers) if (w.status === "running" || w.status === "idle" || w.status === "queued") w.status = "interrupted";
          this.event(s, "interrupted", s.error);
          this.host.setTaskStatus(s.taskId, "interrupted", s.error);
        }
      } catch {
        /* an invalid record never prevents the remaining history from loading */
      }
    }
  }

  private swarmCfg() {
    return clampOrchestration(this.opts.cfg.orchestration ?? ORCHESTRATION_DEFAULTS).swarm;
  }

  /* --------------------------------------------------------------- queries */

  list(): RealSwarmSnapshot[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(copy);
  }

  get(id: string): RealSwarmSnapshot {
    return copy(this.lookup(id));
  }

  /** Rendered board + derived entries, read from the run's coordination DB. */
  board(id: string): { rendered: string; entries: unknown[] } {
    const s = this.lookup(id);
    const live = this.active.get(id)?.db;
    if (live) return live.boardRead();
    const file = coordinationDbPath(s.workspace);
    if (!fs.existsSync(file)) return { rendered: "(no shared lessons yet)", entries: [] };
    const db = new CoordinationDb(file);
    try {
      return db.boardRead();
    } finally {
      db.close();
    }
  }

  /** Test and shutdown helper: resolves when the run's current execution has finished. */
  async settled(id: string): Promise<RealSwarmSnapshot> {
    await this.active.get(id)?.done;
    return this.get(id);
  }

  private lookup(id: string): RealSwarmSnapshot {
    if (!RUN_ID.test(id)) throw new RealSwarmError("Invalid run id");
    const s = this.runs.get(id);
    if (!s) throw new RealSwarmError("Run not found", 404);
    return s;
  }

  /* -------------------------------------------------------------- commands */

  private ensureAccepting(): void {
    if (this.closed) throw new RealSwarmError("Service closed", 409);
    if (!this.swarmCfg().enabled) throw new RealSwarmError("The coding team is turned off (orchestration.swarm.enabled = false)", 409);
    if (this.active.size >= MAX_ACTIVE_REALSWARM_RUNS) throw new RealSwarmError(`Too many active coding-team runs (limit ${MAX_ACTIVE_REALSWARM_RUNS}); wait or cancel one`, 409);
  }

  create(input: CreateRealSwarmInput): RealSwarmSnapshot {
    this.ensureAccepting();
    const sc = this.swarmCfg();
    const goal = typeof input.goal === "string" ? input.goal.trim() : "";
    if (!goal || goal.length > 20_000) throw new RealSwarmError("Goal must contain 1-20000 characters");
    const int = (v: unknown, lo: number, hi: number, d: number, name: string): number => {
      if (v === undefined) return d;
      if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) throw new RealSwarmError(`${name} must be an integer ${lo}-${hi}`);
      return v;
    };
    const maxWorkers = int(input.maxWorkers, 1, HARD_MAX_WORKERS, sc.maxWorkers, "maxWorkers");
    const claimTtlSeconds = int(input.claimTtlSeconds, 60, 86_400, sc.claimTtlSeconds, "claimTtlSeconds");
    const deadlineMs = int(input.deadlineMs, 60_000, 14_400_000, sc.deadlineMs, "deadlineMs");
    const model = input.model === undefined ? this.opts.cfg.model : typeof input.model === "string" ? input.model.trim() : "";
    if (!model || model.length > 200) throw new RealSwarmError("Invalid model");
    // Cloud models only for coding (standing rule; the local model never writes code).
    if (!isCloudModel(this.opts.cfg, model)) throw new RealSwarmError(`model ${model} is not a cloud model; the coding team runs on cloud models only`);
    if (input.repoSeed !== undefined && (typeof input.repoSeed !== "string" || !fs.existsSync(input.repoSeed) || !fs.statSync(input.repoSeed).isDirectory())) throw new RealSwarmError("repoSeed must be an existing folder");
    let baseRepo: string | undefined;
    if (input.baseRun !== undefined) {
      if (input.repoSeed !== undefined) throw new RealSwarmError("baseRun and repoSeed are mutually exclusive");
      const base = this.lookup(String(input.baseRun));
      if (base.status !== "completed") throw new RealSwarmError("baseRun must reference a completed run");
      baseRepo = base.workspace;
    }
    const { taskId, workspace } = this.host.createRunWorkspace(goal);
    const s: RealSwarmSnapshot = {
      id: `realswarm_${randomUUID()}`, taskId, workspace, goal, status: "queued", createdAt: iso(), updatedAt: iso(),
      model, maxWorkers, claimTtlSeconds, deadlineMs,
      activationStaggerMs: this.opts.testTiming?.activationStaggerMs ?? sc.activationStaggerMs,
      idleNudgeMs: this.opts.testTiming?.idleNudgeMs ?? sc.idleNudgeMs,
      repoReady: false, codeBranch: "main", ...(input.baseRun ? { baseRun: String(input.baseRun) } : {}),
      workers: [], merges: [], usage: zeroUsage(),
      metrics: { claimsOpened: 0, claimsActive: 0, claimsExpired: 0, patchSummaries: 0, patchVerified: 0, patchInvalidated: 0, failsRecorded: 0, factsRecorded: 0, mergesLanded: 0, conflictsResolved: 0, mainCommits: 0, messagesChannel: 0, messagesDirect: 0 },
      events: [], shared: { progress: false, checkpoints: false, selection: false, tracing: false },
    };
    this.runs.set(s.id, s);
    this.event(s, "created", `Coding team of ${maxWorkers} created`);
    this.persist(s);
    this.launch(s, "fresh", { seedDir: input.repoSeed, baseRepo });
    return copy(s);
  }

  cancel(id: string): RealSwarmSnapshot {
    const s = this.lookup(id);
    const run = this.active.get(id);
    if (run) this.stop(run, "cancelled");
    else if (isActive(s.status)) {
      s.status = "cancelled";
      this.persist(s);
    }
    return copy(s);
  }

  /** Fresh workers on the same board and repository. */
  retry(id: string): RealSwarmSnapshot {
    const s = this.lookup(id);
    if (this.active.has(id) || !["failed", "cancelled", "interrupted"].includes(s.status)) throw new RealSwarmError("Only a failed, cancelled or interrupted run can be retried", 409);
    this.ensureAccepting();
    s.status = "queued";
    delete s.error;
    delete s.completionReason;
    this.event(s, "retry", "Retry: fresh workers on the same board and repository");
    this.persist(s);
    this.launch(s, "fresh", {});
    return copy(s);
  }

  /** Restores every non-failed worker from its latest C2 checkpoint (needs the checkpoint capability). */
  resume(id: string): RealSwarmSnapshot {
    const s = this.lookup(id);
    if (this.active.has(id) || s.status !== "interrupted") throw new RealSwarmError("Only an interrupted run can be resumed", 409);
    this.ensureAccepting();
    const binding = this.coreFactory({ runId: s.id, taskId: s.taskId });
    if (!binding.port.checkpoints) {
      binding.end();
      throw new RealSwarmError("resume needs the checkpoint capability (C2); use retry", 409);
    }
    s.status = "queued";
    delete s.error;
    delete s.completionReason;
    this.event(s, "resume", "Resume: workers restored from their latest checkpoints");
    this.persist(s);
    this.launch(s, "resume", {}, binding);
    return copy(s);
  }

  /** App shutdown: running runs stop and are recorded as interrupted (resumable). */
  async close(): Promise<void> {
    this.closed = true;
    const runs = [...this.active.values()];
    for (const r of runs) this.stop(r, "interrupted");
    await Promise.all(runs.map((r) => r.done));
  }

  /* ------------------------------------------------------------- execution */

  private stop(run: ActiveRun, reason: StopReason): void {
    if (!run.reason) run.reason = reason;
    run.ctl.abort();
  }

  private acquireLane(signal: AbortSignal): Promise<(() => void) | null> {
    const release = () => {
      this.busyLanes--;
      this.laneWaiters.shift()?.();
    };
    if (this.busyLanes < REALSWARM_LANES) {
      this.busyLanes++;
      return Promise.resolve(release);
    }
    return new Promise((resolve) => {
      const onAbort = () => {
        this.laneWaiters = this.laneWaiters.filter((w) => w !== take);
        resolve(null);
      };
      const take = () => {
        signal.removeEventListener("abort", onAbort);
        this.busyLanes++;
        resolve(release);
      };
      this.laneWaiters.push(take);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private launch(s: RealSwarmSnapshot, mode: "fresh" | "resume", repo: { seedDir?: string; baseRepo?: string }, binding?: SwarmCoreBinding): void {
    const run: ActiveRun = {
      ctl: new AbortController(), workerSpans: new Map(), revisions: new Map(), conflicted: new Map(), merged: new Set(s.merges.map((m) => m.branch)),
      recentTexts: new Map(), deadlineAt: 0, baseMerges: 0, done: Promise.resolve(), ...(binding ? { binding } : {}),
    };
    this.active.set(s.id, run);
    run.done = this.execute(s, run, mode, repo)
      .catch((err) => {
        s.status = "failed";
        s.error = err instanceof Error ? err.message : String(err);
        this.event(s, "failed", s.error);
      })
      .finally(() => {
        this.active.delete(s.id);
        this.persist(s);
        this.host.setTaskStatus(s.taskId, s.status === "running" || s.status === "queued" ? "failed" : s.status, s.error);
      });
  }

  private async execute(s: RealSwarmSnapshot, run: ActiveRun, mode: "fresh" | "resume", repo: { seedDir?: string; baseRepo?: string }): Promise<void> {
    const release = await this.acquireLane(run.ctl.signal);
    if (!release) {
      s.status = run.reason === "interrupted" ? "interrupted" : "cancelled";
      run.binding?.end();
      return;
    }
    let ticker: ReturnType<typeof setInterval> | undefined;
    let tickInFlight: Promise<void> | undefined;
    try {
      s.status = "running";
      s.startedAt = iso();
      this.host.setTaskStatus(s.taskId, "running");
      if (!s.repoReady) {
        s.repoReady = await initRunRepo(s.workspace, repo);
        if (!s.repoReady) throw new RealSwarmError("git is unavailable or the run repository could not be initialised");
      }
      const db = new CoordinationDb(coordinationDbPath(s.workspace), undefined, this.opts.testTiming?.retryBackoffMs);
      run.db = db;
      db.requeueInterrupted();
      if (db.maxGistId() === 0) {
        db.boardWrite({ thread_id: "harness", type: "FACT", content: `Goal: ${s.goal}`.slice(0, 100), detail: s.goal });
        db.sendMessage({ from: "harness", body: `Team of ${s.maxWorkers} started. Goal: ${s.goal.slice(0, 1500)}` });
      }
      run.binding ??= this.coreFactory({ runId: s.id, taskId: s.taskId });
      const port = run.binding.port;
      s.shared = { progress: !!port.progress, checkpoints: !!port.checkpoints, selection: !!port.selection, tracing: !!port.tracing };
      run.runSpan = port.tracing?.startSpan(SPAN.swarmRun, { [LOAM.swarmRunId]: s.id, [LOAM.taskId]: s.taskId, "loam.swarm.workers": s.maxWorkers });
      if (run.runSpan) s.traceId = run.runSpan.traceId;
      run.baseMerges = mode === "fresh" && !s.merges.length ? await mainMergeCount(s.workspace) : run.baseMerges;

      const fresh = (id: string): WorkerState => ({ id, status: "queued", worktree: "", checkpointKey: `realswarm/${s.id}/${id}`, turns: 0, toolCalls: 0, attempts: 0, usage: zeroUsage() });
      if (mode === "fresh") s.workers = Array.from({ length: s.maxWorkers }, (_, i) => fresh(`w${i + 1}`));
      else for (const w of s.workers) if (w.status !== "failed") Object.assign(w, { status: "queued", attempts: 0 });
      for (const w of s.workers) if (w.status !== "failed") w.worktree = await addWorkerWorktree(s.workspace, w.id);
      this.persist(s);

      run.deadlineAt = Date.now() + s.deadlineMs;
      ticker = setInterval(() => {
        if (tickInFlight) return;
        tickInFlight = this.tick(s, run)
          .catch(() => undefined) // a watchdog error never crashes the process; the next tick retries
          .finally(() => (tickInFlight = undefined));
      }, this.tickMs);

      const loops: Array<Promise<void>> = [];
      const live = s.workers.filter((w) => w.status !== "failed");
      for (let i = 0; i < live.length; i++) {
        if (i > 0) await sleep(s.activationStaggerMs, run.ctl.signal);
        if (run.ctl.signal.aborted) break;
        loops.push(this.workerLoop(s, run, live[i]!, mode));
      }
      await Promise.all(loops);
      if (!run.reason) run.reason = s.workers.every((w) => w.status === "failed") ? "all_workers_failed" : "turn_limit";
    } finally {
      if (ticker) clearInterval(ticker);
      await tickInFlight; // finalize closes the coordination DB; never under a running tick
      await this.finalize(s, run).catch(() => undefined);
      release();
    }
  }

  private async finalize(s: RealSwarmSnapshot, run: ActiveRun): Promise<void> {
    const reason = run.reason ?? "cancelled";
    if (s.status === "running" || s.status === "queued") {
      s.status = reason === "interrupted" ? "interrupted" : reason === "cancelled" ? "cancelled" : reason === "all_workers_failed" ? "failed" : "completed";
      if (reason !== "interrupted") s.completionReason = reason;
    }
    for (const w of s.workers) {
      if (w.status === "running" || w.status === "idle" || w.status === "queued") w.status = s.status === "interrupted" ? "interrupted" : s.status === "cancelled" ? "cancelled" : "completed";
      run.workerSpans.get(w.id)?.end({ "loam.swarm.turns": w.turns });
    }
    if (run.db) {
      await this.refreshMetrics(s, run);
      run.db.close();
    }
    if (s.repoReady) await removeWorktrees(s.workspace);
    s.finishedAt = iso();
    this.event(s, s.status, `Run ${s.status}${s.completionReason ? ` (${s.completionReason})` : ""}: ${s.metrics.mergesLanded} merges, ${s.metrics.patchVerified} verified patches, ${s.usage.modelCalls} model calls`);
    run.runSpan?.end({ "loam.swarm.merges": s.metrics.mergesLanded, "loam.swarm.status": s.status }, s.status === "failed" ? s.error ?? "failed" : undefined);
    run.binding?.end();
  }

  /** All counters are read from the board and from git; nothing is estimated. */
  private async refreshMetrics(s: RealSwarmSnapshot, run: ActiveRun): Promise<void> {
    if (!run.db) return;
    const b = run.db.boardMetrics();
    const merges = s.repoReady ? Math.max(0, (await mainMergeCount(s.workspace)) - run.baseMerges) : 0;
    s.metrics = {
      ...b,
      mergesLanded: merges,
      conflictsResolved: s.merges.reduce((n, m) => n + m.conflictsResolved.length, 0),
      mainCommits: s.repoReady ? await mainCommitCount(s.workspace) : 0,
    };
  }

  /** Watchdog: deadline, quiescence, all-failed, idle nudges, live metrics. */
  private async tick(s: RealSwarmSnapshot, run: ActiveRun): Promise<void> {
    const db = run.db;
    if (!db || run.ctl.signal.aborted) return;
    if (Date.now() >= run.deadlineAt) return this.stop(run, "deadline");
    const live = s.workers.filter((w) => w.status !== "failed");
    if (!live.length) return this.stop(run, "all_workers_failed");
    const goalMet = db.verifiedPatchCount() >= 1 && db.openClaimCount() === 0;
    if (goalMet && live.every((w) => w.status === "idle" || w.status === "completed")) return this.stop(run, "quiescent");
    if (!goalMet) {
      for (const w of live) {
        if (w.status !== "idle" || db.hasPending(w.id, "idle_nudge")) continue;
        const last = Math.max(db.lastGistTs(w.id) ?? 0, (await lastCommitEpochSec(w.worktree)) ?? 0, Date.parse(w.lastActivityAt ?? s.startedAt ?? iso()) / 1000);
        if (Date.now() - last * 1000 >= s.idleNudgeMs) {
          db.enqueue(w.id, "idle_nudge", {});
          this.event(s, "idle_nudge", `Idle nudge queued for ${w.id}`, w.id);
        }
      }
    }
    await this.refreshMetrics(s, run);
    this.persist(s);
  }

  private async progressReason(s: RealSwarmSnapshot, run: ActiveRun, w: WorkerState): Promise<string | undefined> {
    const p = run.binding?.port.progress;
    if (!p || !run.db) return undefined;
    try {
      const j = await p.judgeProgress({ workerId: w.id, goal: s.goal, recentTurns: run.recentTexts.get(w.id) ?? [], boardExcerpt: run.db.boardRead().rendered.slice(0, 2000), signal: run.ctl.signal });
      return j?.reason || undefined;
    } catch {
      return undefined;
    }
  }

  private async workerLoop(s: RealSwarmSnapshot, run: ActiveRun, w: WorkerState, mode: "fresh" | "resume"): Promise<void> {
    const db = run.db!;
    const port = run.binding?.port ?? {};
    const signal = run.ctl.signal;
    w.status = "running";
    w.startedAt = iso();
    const wSpan = port.tracing?.startSpan(SPAN.swarmWorker, { [LOAM.swarmRunId]: s.id, [LOAM.swarmWorkerId]: w.id }, run.runSpan);
    if (wSpan) run.workerSpans.set(w.id, wSpan);
    let resume = mode === "resume" ? port.checkpoints?.loadLatestWorker(w.checkpointKey) : undefined;
    this.event(s, "worker_started", `${w.id} started${resume ? " from its checkpoint" : ""}`, w.id);
    while (!signal.aborted) {
      if (w.turns >= MAX_TURNS_PER_WORKER) {
        w.status = "completed";
        break;
      }
      const next = db.nextEventFor(w.id);
      if (!next.due) {
        if (next.waitMs !== undefined) await sleep(Math.min(next.waitMs, this.tickMs), signal);
        else if (w.status === "idle") {
          if (db.hasWakeSignal(w.id)) db.enqueue(w.id, "turn", { wake: true });
          else await sleep(this.tickMs, signal);
        } else db.enqueue(w.id, "turn", {});
        continue;
      }
      const ev = next.due;
      db.markSending(ev.id);
      const nudge =
        ev.kind === "idle_nudge" ? idleNudge(await this.progressReason(s, run, w))
        : ev.kind === "forced_write" ? FORCED_WRITE_NUDGE
        : ev.kind === "merge_conflict" ? String(ev.payload.note ?? "")
        : undefined;
      const releaseTurn = await this.gate.acquire(signal);
      if (!releaseTurn) break;
      let r: Awaited<ReturnType<typeof runWorkerTurn>>;
      try {
        r = await runWorkerTurn({
          cfg: this.opts.cfg, ollama: this.opts.ollama, baseTools: this.opts.tools, executor: this.executor, db,
          binding: { runId: s.id, claimTtlSeconds: s.claimTtlSeconds, requestMerge: (label) => this.requestMerge(s, run, w, label), onClaim: (label) => this.onClaim(s, w, label) },
          worker: w, goal: s.goal, teamSize: s.maxWorkers, model: s.model, taskId: s.taskId, runId: s.id, signal,
          ...(nudge ? { nudge } : {}), ...(resume ? { resume } : {}),
          ...(port.checkpoints ? { saveWorker: (cp) => this.saveCheckpoint(run, w, cp) } : {}),
          ...(port.tracing ? { tracing: port.tracing } : {}), ...(wSpan ? { parentSpan: wSpan } : {}),
        });
      } catch (err) {
        releaseTurn();
        if (signal.aborted) break;
        const msg = err instanceof Error ? err.message : String(err);
        const state = db.markFailed(ev.id, msg);
        w.attempts++;
        w.error = msg.slice(0, 500);
        this.event(s, "worker_turn_failed", `${w.id} turn failed (attempt ${w.attempts}): ${w.error}`, w.id);
        if (state === "failed") {
          w.status = "failed";
          this.event(s, "worker_failed", `${w.id} failed after ${w.attempts} attempts; the other workers continue`, w.id);
          break;
        }
        continue;
      }
      releaseTurn();
      db.markSent(ev.id);
      // runAgent counts restored steps in RunResult.steps (loop.ts:617, :870); only new model calls are added.
      const newCalls = Math.max(0, r.steps - (resume?.steps ?? 0));
      resume = undefined;
      w.attempts = 0;
      delete w.error;
      w.turns++;
      w.toolCalls += r.toolCalls;
      const add = (u: SwarmUsage) => {
        u.promptTokens += r.usage.promptTokens;
        u.completionTokens += r.usage.completionTokens;
        u.durationMs += r.usage.durationMs;
        u.modelCalls += newCalls;
      };
      add(w.usage);
      add(s.usage);
      w.lastActivityAt = iso();
      const texts = run.recentTexts.get(w.id) ?? [];
      texts.push(r.text.slice(0, 1500));
      run.recentTexts.set(w.id, texts.slice(-3));
      const claim = db.currentClaim(w.id);
      if (claim) w.currentClaimLabel = claim;
      else delete w.currentClaimLabel;
      const branch = await currentBranch(w.worktree);
      if (branch) w.branch = branch;
      if (r.gists === 0 && ev.kind !== "forced_write" && ev.payload.wake !== true) db.enqueue(w.id, "forced_write", {});
      else w.status = r.claims > 0 || claim ? "running" : "idle";
      this.persist(s);
    }
    wSpan?.end({ "loam.swarm.turns": w.turns }, w.status === "failed" ? w.error ?? "failed" : undefined);
    run.workerSpans.delete(w.id);
  }

  private saveCheckpoint(run: ActiveRun, w: WorkerState, cp: WorkerCheckpoint): void {
    const rev = (run.revisions.get(w.id) ?? 0) + 1;
    run.revisions.set(w.id, rev);
    try {
      run.binding?.port.checkpoints?.saveWorker(w.checkpointKey, cp, rev);
    } catch {
      /* a checkpoint write never breaks a turn */
    }
  }

  private async onClaim(s: RealSwarmSnapshot, w: WorkerState, label: string): Promise<string> {
    const r = await switchClaimBranch(w.worktree, w.id, label);
    if (r.ok) {
      w.branch = r.branch;
      w.currentClaimLabel = label;
    }
    this.event(s, "claim", `${w.id} claimed ${label}: ${r.note}`, w.id);
    return `branch: ${r.note}`;
  }

  private async requestMerge(s: RealSwarmSnapshot, run: ActiveRun, w: WorkerState, label: string): Promise<MergeOutcome & { selection?: string }> {
    const branch = claimBranch(w.id, label);
    const port = run.binding?.port;
    // OD-14: competing verified patches on one label go through C3 when the switch is on.
    if (port?.selection && run.db) {
      const competing = run.db.verifiedPatchesFor(label).filter((e) => !run.merged.has(claimBranch(e.thread_id, label)));
      const authors = [...new Set(competing.map((e) => e.thread_id))];
      if (authors.length >= 2 && authors.includes(w.id)) {
        const candidates = await Promise.all(authors.map(async (a) => {
          const e = competing.filter((x) => x.thread_id === a).pop()!;
          return { workerId: a, branch: claimBranch(a, label), gistLabel: e.label, evidence: e.content, diff: await branchDiff(s.workspace, claimBranch(a, label)) };
        }));
        const sel = await port.selection.selectBest({ label, goal: s.goal, candidates, signal: run.ctl.signal }).catch(() => undefined);
        if (sel?.chosenBranch && sel.chosenBranch !== branch) {
          this.event(s, "selection", `${label}: ${sel.chosenBranch} chosen over ${branch} (${sel.method})`, w.id);
          return { status: "noop", branch, changedFiles: [], conflicts: [], detail: "another candidate was selected", selection: `selection chose ${sel.chosenBranch} (${sel.method}): ${sel.reason}` };
        }
      }
    }
    const span = port?.tracing?.startSpan(SPAN.swarmMerge, { [LOAM.swarmWorkerId]: w.id, [LOAM.swarmWorkLabel]: label }, run.workerSpans.get(w.id));
    const m = await mergeWorkerBranch(s.workspace, branch, `realswarm: ${w.id} ${label}`);
    span?.end({ "loam.swarm.merge_status": m.status, "loam.swarm.changed_files": m.changedFiles.length });
    if (m.status === "merged") {
      const earlier = [...(run.conflicted.get(branch) ?? [])];
      s.merges.push({ worker: w.id, branch, label, changedFiles: m.changedFiles.length, conflictsResolved: earlier, mergedAt: iso(), commit: m.commit ?? "" });
      run.merged.add(branch);
      run.conflicted.delete(branch);
      run.db?.supersede(w.id, "merge_conflict");
      this.event(s, "merged", `${branch} merged into main (${m.changedFiles.length} files${earlier.length ? `, ${earlier.length} earlier conflicts resolved` : ""})`, w.id);
    } else if (m.status === "conflict") {
      const set = run.conflicted.get(branch) ?? new Set<string>();
      for (const f of m.conflicts) set.add(f);
      run.conflicted.set(branch, set);
      const note = mergeConflictNote(label, m.conflicts);
      run.db?.sendMessage({ from: "harness", to: w.id, body: note });
      // If the turn ends before the conflict is fixed, the next turn starts with the same note.
      if (run.db && !run.db.hasPending(w.id, "merge_conflict")) run.db.enqueue(w.id, "merge_conflict", { note });
      this.event(s, "merge_conflict", `${branch}: conflict in ${m.conflicts.join(", ")}`, w.id);
    }
    this.persist(s);
    return m;
  }

  /* ----------------------------------------------------------- persistence */

  private event(s: RealSwarmSnapshot, type: string, message: string, worker?: string): void {
    s.events.push({ at: iso(), type, message: message.slice(0, 1000), ...(worker ? { worker } : {}) });
    if (s.events.length > 500) s.events.splice(0, s.events.length - 500);
    s.updatedAt = iso();
  }

  private persist(s: RealSwarmSnapshot): void {
    s.updatedAt = iso();
    const file = path.join(this.dir, `${s.id}.json`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, file);
  }
}
