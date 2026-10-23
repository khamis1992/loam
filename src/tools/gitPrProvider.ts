/**
 * Pull-request provider interface for the Git/PR workflow tools (D1).
 *
 * Two implementations:
 *  - GitHubPrProvider talks to the GitHub REST API using the sealed OAuth token
 *    from the existing github connector (src/server/connectors/providers/github.ts).
 *  - LocalPrProvider stores pull requests, review comments and CI check-runs as
 *    JSON under a local directory (tests and local bare-remote workflows).
 *
 * CI check-runs (D2) extend the same provider seam: `listCheckRuns` on the
 * GitHub provider hits the check-runs API, while LocalPrProvider returns the
 * scripted results stored per head ref. No network happens unless a live
 * provider is used; tests inject a mocked fetch, so nothing here reaches the
 * network by itself.
 */
import fs from "node:fs";
import path from "node:path";
import { getAccessToken } from "../server/connectors/oauth.js";
import { githubConnector } from "../server/connectors/providers/github.js";

export interface PrComment {
  id: string;
  author: string;
  body: string;
  path?: string;
  line?: number;
  createdAt: string;
}

export interface PrInfo {
  number: number;
  title: string;
  state: string;
  url: string;
  head: string;
  base: string;
  body?: string;
}

export interface CreatePrInput {
  repo: string;
  title: string;
  head: string;
  base: string;
  body?: string;
  /**
   * Optional explicit PR number. The local provider otherwise numbers PRs
   * itself; tests pin it so a scripted diff can be seeded under the number the
   * review will fetch.
   */
  number?: number;
}

export interface AddCommentOptions {
  path?: string;
  line?: number;
}

/**
 * One file of a pull request diff, with the file's full unified-diff hunks.
 *
 * The diff is intentionally plain text: the reviewer parses the hunk headers
 * itself (D15) so it can compute the new-file line numbers findings are reported
 * against without asking the model to do arithmetic on the patch.
 */
export interface PrFileDiff {
  path: string;
  status: string;
  /** Unified diff for this file, including the `@@` hunk headers. */
  diff: string;
}

/** The diff of a whole pull request, one entry per changed file. */
export interface PrDiff {
  repo: string;
  number: number;
  head: string;
  base: string;
  files: PrFileDiff[];
}

/** One CI check-run as the agent needs it (D2 ci_watch). */
export interface CheckRunInfo {
  /** Check-run id. */
  id: string;
  /** Job/check name, e.g. "build (node 22)". */
  name: string;
  /** queued | in_progress | completed | waiting | requested | pending */
  status: string;
  /** success | failure | neutral | cancelled | skipped | timed_out | action_required | stale | null */
  conclusion: string | null;
  /** Target branch/ref the check-run belongs to. */
  head: string;
}

/** A failing check-run plus the trimmed tail of its job log. */
export interface FailingJob {
  /** Job/check name. */
  name: string;
  /** Normalized failure signature used to key the fix budget. */
  signature: string;
  /** Last lines of the job log, already trimmed and capped. */
  logTail: string;
}

export interface PrProvider {
  readonly id: string;
  createPr(input: CreatePrInput): Promise<PrInfo>;
  viewPr(repo: string, number: number): Promise<PrInfo>;
  listReviewComments(repo: string, number: number): Promise<PrComment[]>;
  addComment(repo: string, number: number, body: string, opts?: AddCommentOptions): Promise<PrComment>;
  /** D2: CI check-runs for a pull request's head ref (scripted for the local provider). */
  listCheckRuns(repo: string, ref: string): Promise<CheckRunInfo[]>;
  /** D2: job log for a failing check-run (scripted for the local provider). */
  getCheckRunLog(repo: string, checkRunId: string): Promise<string>;
  /** D15: unified diff per changed file, used by pr_review. */
  prDiff(repo: string, number: number): Promise<PrDiff>;
}

function sanitizeRepo(repo: string): string {
  const cleaned = repo.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned || "repo";
}

function normalizePr(data: Record<string, unknown>): PrInfo {
  const head = (data.head ?? {}) as { ref?: unknown };
  const base = (data.base ?? {}) as { ref?: unknown };
  return {
    number: Number(data.number ?? 0),
    title: String(data.title ?? ""),
    state: String(data.state ?? ""),
    url: String(data.html_url ?? ""),
    head: String(head.ref ?? ""),
    base: String(base.ref ?? ""),
    ...(typeof data.body === "string" ? { body: data.body } : {}),
  };
}

function normalizeComment(data: Record<string, unknown>): PrComment {
  return {
    id: String(data.id ?? ""),
    author: String((data.user as { login?: unknown } | undefined)?.login ?? ""),
    body: String(data.body ?? ""),
    ...(typeof data.path === "string" ? { path: data.path } : {}),
    ...(typeof data.line === "number" ? { line: data.line } : {}),
    createdAt: String(data.created_at ?? ""),
  };
}

function normalizeCheckRun(data: Record<string, unknown>): CheckRunInfo {
  return {
    id: String(data.id ?? ""),
    name: String(data.name ?? ""),
    status: String(data.status ?? ""),
    conclusion: typeof data.conclusion === "string" ? data.conclusion : null,
    head: String(data.head_sha ?? "").slice(0, 7),
  };
}

export interface GitHubPrProviderOptions {
  /** Resolves the bearer token. Defaults to the connected github connector. */
  token?: () => Promise<string>;
  /** Fetch implementation; tests inject a mock so no network is used. */
  fetchImpl?: typeof fetch;
  apiBase?: string;
}

export class GitHubPrProvider implements PrProvider {
  readonly id = "github";
  private readonly token: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;

  constructor(options: GitHubPrProviderOptions = {}) {
    this.token = options.token ?? (() => getAccessToken(githubConnector));
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.apiBase = options.apiBase ?? "https://api.github.com";
  }

  private async request(method: string, pathname: string, body?: unknown): Promise<Record<string, unknown>> {
    const token = await this.token();
    const res = await this.fetchImpl(`${this.apiBase}${pathname}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`GitHub ${method} ${pathname} failed (${res.status}): ${text.slice(0, 300)}`);
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }

  async createPr(input: CreatePrInput): Promise<PrInfo> {
    const data = await this.request("POST", `/repos/${input.repo}/pulls`, {
      title: input.title,
      head: input.head,
      base: input.base,
      body: input.body ?? "",
    });
    return normalizePr(data);
  }

  async viewPr(repo: string, number: number): Promise<PrInfo> {
    const data = await this.request("GET", `/repos/${repo}/pulls/${number}`);
    return normalizePr(data);
  }

  async listReviewComments(repo: string, number: number): Promise<PrComment[]> {
    const data = await this.request("GET", `/repos/${repo}/pulls/${number}/comments`);
    if (!Array.isArray(data)) return [];
    return (data as Record<string, unknown>[]).map(normalizeComment);
  }

  async addComment(repo: string, number: number, body: string, opts: AddCommentOptions = {}): Promise<PrComment> {
    const payload: Record<string, unknown> = { body };
    if (opts.path) payload.path = opts.path;
    if (typeof opts.line === "number") payload.line = opts.line;
    const data = await this.request("POST", `/repos/${repo}/pulls/${number}/comments`, payload);
    return normalizeComment(data);
  }

  async listCheckRuns(repo: string, ref: string): Promise<CheckRunInfo[]> {
    const data = await this.request("GET", `/repos/${repo}/commits/${encodeURIComponent(ref)}/check-runs`);
    const runs = (data.check_runs ?? data) as unknown;
    if (!Array.isArray(runs)) return [];
    return runs.map(normalizeCheckRun);
  }

  async getCheckRunLog(_repo: string, checkRunId: string): Promise<string> {
    // GitHub requires a separate log download that is not always available for
    // every check-run; the tool degrades to "no log" rather than failing the
    // whole watch. The provider interface keeps it injectable for tests.
    return `check-run ${checkRunId} has no downloadable log`;
  }

  async prDiff(repo: string, number: number): Promise<PrDiff> {
    const pr = await this.viewPr(repo, number);
    const data = await this.request("GET", `/repos/${repo}/pulls/${number}/files?per_page=100`);
    const files = Array.isArray(data) ? data : ((data.files ?? []) as unknown[]);
    return {
      repo,
      number,
      head: pr.head,
      base: pr.base,
      files: (files as Record<string, unknown>[]).map((file) => ({
        path: String(file.filename ?? ""),
        status: String(file.status ?? ""),
        // GitHub omits `patch` for binary files and for very large diffs; the
        // reviewer skips files whose patch is missing rather than guessing.
        diff: typeof file.patch === "string" ? file.patch : "",
      })),
    };
  }
}

interface LocalPrRecord {
  pr: PrInfo;
  comments: PrComment[];
}

interface LocalCheckRecord {
  repo: string;
  ref: string;
  runs: CheckRunInfo[];
  logs: Record<string, string>;
}

/** Scripted diff for the local provider: one pull request's changed files. */
interface LocalDiffRecord {
  repo: string;
  number: number;
  head: string;
  base: string;
  files: PrFileDiff[];
}

/** Scripted check-runs for the local provider: `fail -> fail -> pass` by default. */
export interface LocalCheckScript {
  runs?: CheckRunInfo[];
  logs?: Record<string, string>;
}

/** Stores PRs, review comments and CI check-runs as JSON under a directory (`.loam/prs`). */
export class LocalPrProvider implements PrProvider {
  readonly id = "local";
  constructor(private readonly dir: string) {}

  private fileFor(repo: string, number: number): string {
    return path.join(this.dir, `${sanitizeRepo(repo)}-${number}.json`);
  }

  private read(repo: string, number: number): LocalPrRecord | null {
    try {
      return JSON.parse(fs.readFileSync(this.fileFor(repo, number), "utf8")) as LocalPrRecord;
    } catch {
      return null;
    }
  }

  private write(repo: string, record: LocalPrRecord): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.fileFor(repo, record.pr.number)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), "utf8");
    fs.renameSync(tmp, this.fileFor(repo, record.pr.number));
  }

  private nextNumber(repo: string): number {
    const prefix = `${sanitizeRepo(repo)}-`;
    let max = 0;
    try {
      for (const entry of fs.readdirSync(this.dir)) {
        if (!entry.startsWith(prefix) || !entry.endsWith(".json")) continue;
        const n = Number(entry.slice(prefix.length, -".json".length));
        if (Number.isFinite(n) && n > max) max = n;
      }
    } catch {
      /* directory does not exist yet */
    }
    return max + 1;
  }

  async createPr(input: CreatePrInput): Promise<PrInfo> {
    const number = input.number ?? this.nextNumber(input.repo);
    const pr: PrInfo = {
      number,
      title: input.title,
      state: "open",
      url: `local://${sanitizeRepo(input.repo)}/${number}`,
      head: input.head,
      base: input.base,
      ...(input.body ? { body: input.body } : {}),
    };
    this.write(input.repo, { pr, comments: [] });
    return pr;
  }

  async viewPr(repo: string, number: number): Promise<PrInfo> {
    const record = this.read(repo, number);
    if (!record) throw new Error(`no local pull request #${number} for ${repo}`);
    return record.pr;
  }

  async listReviewComments(repo: string, number: number): Promise<PrComment[]> {
    const record = this.read(repo, number);
    if (!record) throw new Error(`no local pull request #${number} for ${repo}`);
    return record.comments;
  }

  async addComment(repo: string, number: number, body: string, opts: AddCommentOptions = {}): Promise<PrComment> {
    const record = this.read(repo, number);
    if (!record) throw new Error(`no local pull request #${number} for ${repo}`);
    const comment: PrComment = {
      id: `c_${Date.now().toString(36)}_${record.comments.length + 1}`,
      author: "reviewer",
      body,
      createdAt: new Date().toISOString(),
      ...(opts.path ? { path: opts.path } : {}),
      ...(typeof opts.line === "number" ? { line: opts.line } : {}),
    };
    record.comments.push(comment);
    this.write(repo, record);
    return comment;
  }

  private checkFileFor(repo: string): string {
    return path.join(this.dir, `${sanitizeRepo(repo)}-checks.json`);
  }

  private readChecks(repo: string): LocalCheckRecord[] {
    try {
      return JSON.parse(fs.readFileSync(this.checkFileFor(repo), "utf8")) as LocalCheckRecord[];
    } catch {
      return [];
    }
  }

  private writeChecks(repo: string, records: LocalCheckRecord[]): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.checkFileFor(repo)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2), "utf8");
    fs.renameSync(tmp, this.checkFileFor(repo));
  }

  /** Scripted check-runs for a ref (tests drive the fail->pass sequence). */
  setCheckScript(repo: string, ref: string, script: LocalCheckScript): void {
    const records = this.readChecks(repo).filter((r) => r.ref !== ref);
    records.push({
      repo,
      ref,
      runs: script.runs ?? defaultCheckRuns(),
      logs: script.logs ?? {},
    });
    this.writeChecks(repo, records);
  }

  async listCheckRuns(repo: string, ref: string): Promise<CheckRunInfo[]> {
    const record = this.readChecks(repo).find((r) => r.ref === ref);
    return record?.runs ?? defaultCheckRuns();
  }

  async getCheckRunLog(repo: string, checkRunId: string): Promise<string> {
    const records = this.readChecks(repo);
    for (const record of records) {
      if (record.logs[checkRunId]) return record.logs[checkRunId]!;
    }
    return `no local log for check-run ${checkRunId}`;
  }

  private diffFileFor(repo: string): string {
    return path.join(this.dir, `${sanitizeRepo(repo)}-diffs.json`);
  }

  private readDiffs(repo: string): LocalDiffRecord[] {
    try {
      return JSON.parse(fs.readFileSync(this.diffFileFor(repo), "utf8")) as LocalDiffRecord[];
    } catch {
      return [];
    }
  }

  private writeDiffs(repo: string, records: LocalDiffRecord[]): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.diffFileFor(repo)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2), "utf8");
    fs.renameSync(tmp, this.diffFileFor(repo));
  }

  /** Scripted diff for a pull request (tests drive the reviewed patch). */
  setPrDiff(repo: string, number: number, diff: Omit<PrDiff, "repo" | "number">): void {
    const records = this.readDiffs(repo).filter((r) => r.number !== number);
    records.push({ repo, number, ...diff });
    this.writeDiffs(repo, records);
  }

  async prDiff(repo: string, number: number): Promise<PrDiff> {
    const record = this.readDiffs(repo).find((r) => r.number === number);
    if (!record) throw new Error(`no local diff for pull request #${number} in ${repo}`);
    return { repo, number, head: record.head, base: record.base, files: record.files };
  }
}

/**
 * Seed the diff `pr_diff` returns for a pull request on a LocalPrProvider.
 *
 * The local provider cannot compute a diff from a real git remote (and D15's
 * tests must not touch the network), so the diff is scripted exactly like
 * {@link LocalPrProvider.setCheckScript}.
 */
export function setPrDiff(
  provider: PrProvider,
  repo: string,
  number: number,
  diff: Omit<PrDiff, "repo" | "number">,
): void {
  if (typeof (provider as { setPrDiff?: unknown }).setPrDiff !== "function") {
    throw new Error("setPrDiff requires a LocalPrProvider");
  }
  (provider as unknown as { setPrDiff: (r: string, n: number, d: Omit<PrDiff, "repo" | "number">) => void }).setPrDiff(
    repo,
    number,
    diff,
  );
}

/** The default local script: two failing jobs and one passing job. */
export function defaultCheckRuns(): CheckRunInfo[] {
  return [
    { id: "1001", name: "build (node 22)", status: "completed", conclusion: "failure", head: "" },
    { id: "1002", name: "lint", status: "completed", conclusion: "failure", head: "" },
    { id: "1003", name: "test", status: "completed", conclusion: "success", head: "" },
  ];
}

export type ChecklistStatus = "open" | "done" | "outdated";

/** Per-PR review-comment checklist persisted as JSON in session state. */
export class PrChecklistStore {
  constructor(private readonly dir: string) {}

  private fileFor(repo: string, number: number): string {
    return path.join(this.dir, `${sanitizeRepo(repo)}-${number}.json`);
  }

  get(repo: string, number: number): Record<string, ChecklistStatus> {
    try {
      return JSON.parse(fs.readFileSync(this.fileFor(repo, number), "utf8")) as Record<string, ChecklistStatus>;
    } catch {
      return {};
    }
  }

  set(repo: string, number: number, commentId: string, status: ChecklistStatus): Record<string, ChecklistStatus> {
    const current = this.get(repo, number);
    current[commentId] = status;
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.fileFor(repo, number)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(current, null, 2), "utf8");
    fs.renameSync(tmp, this.fileFor(repo, number));
    return current;
  }
}
