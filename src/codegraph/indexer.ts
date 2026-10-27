import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { log } from "../log.js";
import type { CodeGraphAudit } from "./audit.js";
import { DEFAULT_EXCLUDES, GRAPHIFY_PIN, type CodeGraphConfig } from "./config.js";
import { buildChildEnv } from "./env.js";
import { excludeArgChars, MAX_EXCLUDE_ARG_CHARS, prescan } from "./excludes.js";
import { graphJsonPath, isInsideOrEqual, projectIdFor, projectStoreDir, recordPath } from "./paths.js";
import { run } from "./proc.js";
import { checkRuntime } from "./runtime.js";
import { gitHead, readBuiltAtCommit, readGraphMeta } from "./staleness.js";
import type { IndexJob, IndexTrigger, ProjectIndexRecord, ProjectIndexState, ProjectIndexStatus, StaleReason } from "./types.js";

const WROTE_RE = /wrote .*graph\.json: (\d+) nodes, (\d+) edges, (\d+) communities/;
const INCR_RE = /incremental summary: (\d+) files cached\/unchanged, (\d+) re-extracted, (\d+) deleted/;
const SHRINK_GUARD_RE = /refusing to overwrite/i;

export interface IndexerDeps {
  cfg: CodeGraphConfig;
  home: string;
  audit: CodeGraphAudit;
  gitBin?: string;
  gitDir?: string | null;
  platform?: NodeJS.Platform;
}

/** Owns per-project index records and a single global extract queue (indexing is CPU/RAM heavy). */
export class CodeGraphIndexer {
  private readonly queue: IndexJob[] = [];
  private running: { job: IndexJob; abort: AbortController } | null = null;
  private readonly waiters = new Map<string, Array<(j: IndexJob) => void>>();
  private readonly debouncers = new Map<string, NodeJS.Timeout>();
  private readonly platform: NodeJS.Platform;

  constructor(private readonly deps: IndexerDeps) {
    this.platform = deps.platform ?? process.platform;
  }

  // ---------------- records ----------------

  storeDirFor(root: string): string {
    return projectStoreDir(this.deps.home, projectIdFor(root, this.platform));
  }

  readRecord(root: string): ProjectIndexRecord {
    const projectId = projectIdFor(root, this.platform);
    const file = recordPath(projectStoreDir(this.deps.home, projectId));
    try {
      const rec = JSON.parse(fs.readFileSync(file, "utf8")) as ProjectIndexRecord;
      if (rec.version === 1 && rec.projectId === projectId) return rec;
    } catch { /* missing or corrupt -> fresh record */ }
    return { version: 1, projectId, root: path.resolve(root), displayName: path.basename(path.resolve(root)), optedIn: false, dirtySince: null };
  }

  private writeRecord(rec: ProjectIndexRecord): void {
    const dir = projectStoreDir(this.deps.home, rec.projectId);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `loam-index.json.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), "utf8");
    fs.renameSync(tmp, recordPath(dir));
  }

  isDenied(root: string): boolean {
    return this.deps.cfg.denyRoots.some((d) => isInsideOrEqual(d, root, this.platform));
  }

  optIn(root: string): ProjectIndexRecord {
    if (this.isDenied(root)) throw new Error(`project is in codeGraph.denyRoots: ${root}`);
    const rec = this.readRecord(root);
    rec.optedIn = true;
    rec.optedInAt = new Date().toISOString();
    rec.declinedAt = null;
    this.writeRecord(rec);
    this.deps.audit.write({ event: "codegraph.project.optin", projectId: rec.projectId });
    return rec;
  }

  /** decline=true records «أبداً» so onWorkspaceOpen stops asking; decline=false is «لاحقاً» / plain opt-out. */
  optOut(root: string, opts: { decline?: boolean } = {}): void {
    const rec = this.readRecord(root);
    rec.optedIn = false;
    if (opts.decline) rec.declinedAt = new Date().toISOString();
    this.writeRecord(rec);
    this.deps.audit.write({ event: "codegraph.project.optout", projectId: rec.projectId });
  }

  /** Delete the project's graph store entirely (graph.json, cache, manifest, record). */
  purge(root: string): void {
    const projectId = projectIdFor(root, this.platform);
    this.cancelProject(projectId);
    fs.rmSync(projectStoreDir(this.deps.home, projectId), { recursive: true, force: true });
    this.deps.audit.write({ event: "codegraph.project.purge", projectId });
  }

  // ---------------- status ----------------

  async status(root: string): Promise<ProjectIndexStatus> {
    const rec = this.readRecord(root);
    const storeDir = projectStoreDir(this.deps.home, rec.projectId);
    const graph = graphJsonPath(storeDir);
    const runtime = (await checkRuntime(this.deps.home)).state;
    const head = await gitHead(root, this.deps.gitBin);
    const built = fs.existsSync(graph) ? readBuiltAtCommit(graph) : null;
    const reasons = this.staleReasons(rec, graph, head, built);
    let state: ProjectIndexState;
    if (!this.deps.cfg.enabled || this.isDenied(root)) state = "disabled";
    else if (runtime !== "ready") state = "runtime-missing";
    else if (!rec.optedIn) state = "disabled";
    else if (this.isBusy(rec.projectId)) state = "indexing";
    else if (!fs.existsSync(graph)) state = rec.lastJob && rec.lastJob.status !== "succeeded" ? "failed" : "never-indexed";
    else state = reasons.length > 0 ? "stale" : "ready";
    const s = rec.lastSuccess;
    return {
      projectId: rec.projectId, root: rec.root, displayName: rec.displayName, state, runtime, optedIn: rec.optedIn, declined: !!rec.declinedAt,
      builtAtCommit: built, headCommit: head, staleReasons: reasons,
      nodes: s?.nodes, edges: s?.edges, communities: s?.communities, graphBytes: rec.graphBytes,
      lastJob: this.currentJob(rec.projectId) ?? rec.lastJob, storeDir,
    };
  }

  staleReasons(rec: ProjectIndexRecord, graph: string, head: string | null, built: string | null): StaleReason[] {
    if (!fs.existsSync(graph)) return [];
    const r: StaleReason[] = [];
    if (head && built && head !== built) r.push("head-moved");
    if (rec.dirtySince) r.push("loam-wrote-files");
    try {
      if (Date.now() - fs.statSync(graph).mtimeMs > this.deps.cfg.maxGraphAgeMs) r.push("older-than-max-age");
    } catch { /* raced with purge */ }
    const meta = readGraphMeta(graph);
    if (meta.schemaVersion !== undefined && meta.schemaVersion !== GRAPHIFY_PIN.graphSchemaVersion) r.push("schema-mismatch");
    if (meta.graphifyVersion && meta.graphifyVersion !== GRAPHIFY_PIN.version) r.push("version-mismatch");
    return r;
  }

  private isBusy(projectId: string): boolean {
    return this.running?.job.projectId === projectId || this.queue.some((j) => j.projectId === projectId);
  }

  private currentJob(projectId: string): IndexJob | undefined {
    if (this.running?.job.projectId === projectId) return this.running.job;
    return this.queue.find((j) => j.projectId === projectId);
  }

  // ---------------- triggers ----------------

  /** Enqueue an extract. De-duplicates: an already-queued job for the project is returned as-is. */
  requestIndex(root: string, trigger: IndexTrigger, opts: { full?: boolean } = {}): IndexJob {
    if (!this.deps.cfg.enabled) throw new Error("codeGraph is disabled in settings");
    if (this.isDenied(root)) throw new Error(`project is in codeGraph.denyRoots: ${root}`);
    const rec = this.readRecord(root);
    if (!rec.optedIn) throw new Error("project is not opted in to Code Graph indexing");
    const queued = this.queue.find((j) => j.projectId === rec.projectId);
    if (queued) {
      if (opts.full) queued.full = true;
      return queued;
    }
    const job: IndexJob = {
      id: `cgj_${randomBytes(6).toString("hex")}`, projectId: rec.projectId, root: path.resolve(root),
      trigger, full: opts.full === true, status: "queued", queuedAt: new Date().toISOString(),
    };
    this.queue.push(job);
    queueMicrotask(() => void this.pump());
    return job;
  }

  /** Called by Loam after its own file_write/file_edit/file_move/file_delete/git_commit inside `root`. */
  markDirty(root: string): void {
    const rec = this.readRecord(root);
    if (!rec.optedIn) return;
    if (!rec.dirtySince) {
      rec.dirtySince = new Date().toISOString();
      this.writeRecord(rec);
    }
    if (!this.deps.cfg.enabled || !this.deps.cfg.autoRefresh) return;
    const key = rec.projectId;
    const prev = this.debouncers.get(key);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.debouncers.delete(key);
      try { this.requestIndex(root, "agent-writes"); } catch (err) { log.warn(`codegraph refresh skipped: ${String(err)}`); }
    }, this.deps.cfg.refreshDebounceMs);
    t.unref?.();
    this.debouncers.set(key, t);
  }

  waitFor(jobId: string, timeoutMs: number): Promise<IndexJob | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      timer.unref?.();
      const list = this.waiters.get(jobId) ?? [];
      list.push((j) => { clearTimeout(timer); resolve(j); });
      this.waiters.set(jobId, list);
    });
  }

  cancelProject(projectId: string): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const j = this.queue[i]!;
      if (j.projectId === projectId) {
        this.queue.splice(i, 1);
        j.status = "cancelled";
        this.settle(j);
      }
    }
    if (this.running?.job.projectId === projectId) this.running.abort.abort();
  }

  dispose(): void {
    for (const t of this.debouncers.values()) clearTimeout(t);
    this.debouncers.clear();
    this.queue.length = 0;
    this.running?.abort.abort();
  }

  // ---------------- worker ----------------

  private settle(job: IndexJob): void {
    const list = this.waiters.get(job.id) ?? [];
    this.waiters.delete(job.id);
    for (const w of list) w(job);
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const job = this.queue.shift();
    if (!job) return;
    const abort = new AbortController();
    this.running = { job, abort };
    try {
      await this.execute(job, abort.signal);
    } catch (err) {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
    } finally {
      job.finishedAt = new Date().toISOString();
      this.persistJob(job);
      this.running = null;
      this.settle(job);
      void this.pump();
    }
  }

  buildArgs(root: string, storeDir: string, full: boolean, oversizedExcludeArgs: string[]): string[] {
    const excludes = [...DEFAULT_EXCLUDES, ...this.deps.cfg.extraExcludes];
    const args = [
      "extract", root,
      "--code-only",
      "--out", storeDir,
      "--max-workers", String(this.deps.cfg.maxWorkers),
      "--timing",
      ...(full ? ["--force"] : []),
    ];
    for (const g of excludes) args.push("--exclude", g);
    args.push(...oversizedExcludeArgs);
    return args;
  }

  private async execute(job: IndexJob, signal: AbortSignal): Promise<void> {
    const cfg = this.deps.cfg;
    const rt = await checkRuntime(this.deps.home);
    if (rt.state !== "ready") throw new Error(`graphify runtime is ${rt.state}`);
    const root = path.resolve(job.root);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`project root not found: ${root}`);
    const storeDir = projectStoreDir(this.deps.home, job.projectId);
    fs.mkdirSync(storeDir, { recursive: true });

    const pre = prescan(root, { maxCodeFileBytes: cfg.maxCodeFileBytes, excludes: [...DEFAULT_EXCLUDES, ...cfg.extraExcludes] });
    job.oversizedExcluded = pre.oversized.length;
    if (pre.codeFiles > cfg.maxCodeFiles) throw new Error(`project has ${pre.codeFiles} code files after excludes; limit is ${cfg.maxCodeFiles} (add codeGraph.extraExcludes)`);
    if (excludeArgChars(pre.excludeArgs) > MAX_EXCLUDE_ARG_CHARS) throw new Error(`too many oversized files (${pre.oversized.length}); add directory excludes in codeGraph.extraExcludes`);

    job.status = "running";
    job.startedAt = new Date().toISOString();
    this.persistJob(job);
    this.deps.audit.write({ event: "codegraph.index.start", projectId: job.projectId, jobId: job.id, detail: `${job.trigger}${job.full ? " full" : ""}` });

    const env = buildChildEnv({ pathPrepend: [path.dirname(rt.executables.graphify)], gitDir: this.deps.gitDir ?? null, platform: this.platform });
    const attempt = async (full: boolean) =>
      run(rt.executables.graphify, this.buildArgs(root, storeDir, full, pre.excludeArgs), {
        cwd: storeDir, env, timeoutMs: cfg.indexTimeoutMs, signal, maxCaptureBytes: 2_000_000,
      });
    let r = await attempt(job.full);
    if (r.code !== 0 && !r.timedOut && !r.cancelled && SHRINK_GUARD_RE.test(r.stderr + r.stdout)) {
      // The graph is a regenerable cache: a shrink after deletions/refactors is expected, so rebuild in full once.
      job.full = true;
      r = await attempt(true);
    }
    job.exitCode = r.code;
    job.durationMs = r.durationMs;
    job.stderrTail = r.stderr.slice(-4000);
    const wrote = WROTE_RE.exec(r.stdout);
    const incr = INCR_RE.exec(r.stdout);
    if (wrote) { job.nodes = Number(wrote[1]); job.edges = Number(wrote[2]); job.communities = Number(wrote[3]); }
    if (incr) { job.filesCached = Number(incr[1]); job.filesReextracted = Number(incr[2]); job.filesDeleted = Number(incr[3]); }

    if (r.cancelled) { job.status = "cancelled"; return; }
    if (r.timedOut) { job.status = "timeout"; job.error = `extract exceeded ${cfg.indexTimeoutMs} ms`; }
    else if (r.code === 0 && wrote && fs.existsSync(graphJsonPath(storeDir))) job.status = "succeeded";
    else { job.status = "failed"; job.error = `graphify extract exited ${r.code}`; }

    this.deps.audit.write({
      event: job.status === "succeeded" ? "codegraph.index.ok" : "codegraph.index.fail",
      projectId: job.projectId, jobId: job.id, durationMs: job.durationMs, outcome: job.status,
      detail: job.status === "succeeded" ? `${job.nodes} nodes ${job.edges} edges` : job.error,
    });
  }

  private persistJob(job: IndexJob): void {
    const rec = this.readRecord(job.root);
    rec.lastJob = { ...job };
    if (job.status === "succeeded") {
      rec.lastSuccess = { ...job };
      const graph = graphJsonPath(projectStoreDir(this.deps.home, job.projectId));
      rec.builtAtCommit = readBuiltAtCommit(graph);
      const meta = readGraphMeta(graph);
      rec.graphifyVersion = meta.graphifyVersion;
      rec.schemaVersion = meta.schemaVersion;
      try { rec.graphBytes = fs.statSync(graph).size; } catch { /* ignore */ }
      // Writes that landed after this job started still make the graph stale.
      if (rec.dirtySince && job.startedAt && rec.dirtySince <= job.startedAt) rec.dirtySince = null;
    }
    this.writeRecord(rec);
  }
}
