/**
 * Pull-request provider interface for the Git/PR workflow tools (D1).
 *
 * Two implementations:
 *  - GitHubPrProvider talks to the GitHub REST API using the sealed OAuth token
 *    from the existing github connector (src/server/connectors/providers/github.ts).
 *  - LocalPrProvider stores pull requests and review comments as JSON under a
 *    local directory (tests and local bare-remote workflows).
 *
 * No network happens unless a live provider is used; tests inject a mocked
 * fetch, so nothing here reaches the network by itself.
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
}

export interface AddCommentOptions {
  path?: string;
  line?: number;
}

export interface PrProvider {
  readonly id: string;
  createPr(input: CreatePrInput): Promise<PrInfo>;
  viewPr(repo: string, number: number): Promise<PrInfo>;
  listReviewComments(repo: string, number: number): Promise<PrComment[]>;
  addComment(repo: string, number: number, body: string, opts?: AddCommentOptions): Promise<PrComment>;
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
}

interface LocalPrRecord {
  pr: PrInfo;
  comments: PrComment[];
}

/** Stores PRs and review comments as JSON under a directory (`.loam/prs`). */
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
    const number = this.nextNumber(input.repo);
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
