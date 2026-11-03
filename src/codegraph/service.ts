import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { argsDigest, CodeGraphAudit } from "./audit.js";
import { capBytes, classifyCliExit, classifyGraphifyText } from "./budget.js";
import { GraphifyMcpClient } from "./client.js";
import { resolveCodeGraphConfig, type CodeGraphConfig, type GraphifyAllowedTool } from "./config.js";
import { buildChildEnv } from "./env.js";
import { CodeGraphIndexer } from "./indexer.js";
import { auditPath, codeGraphHome, engineExecutables, graphJsonPath } from "./paths.js";
import { run } from "./proc.js";
import type { CodeGraphQueryRequest, CodeGraphQueryResult, ProjectIndexStatus } from "./types.js";

export interface OpenDecision { action: "none" | "ask-consent" | "index"; status: ProjectIndexStatus }

/**
 * Windows deviation (spec §A.2 assumed git in /usr/bin, which buildChildEnv puts
 * on the child PATH): resolve git's directory once so graphify's export step can
 * stamp built_at_commit. Null when git is absent — staleness then falls back to
 * the age/max-age signal only.
 */
function defaultGitDir(): string | null {
  try {
    const finder = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(finder, ["git"], { encoding: "utf8", windowsHide: true, timeout: 5_000 });
    const first = out.split(/\r?\n/)[0]?.trim();
    return first ? path.dirname(first) : null;
  } catch {
    return null;
  }
}

/** Facade used by agent tools, HTTP routes and runtime bootstrap. One instance per Loam process. */
export class CodeGraphService {
  readonly cfg: CodeGraphConfig;
  readonly home: string;
  readonly audit: CodeGraphAudit;
  readonly indexer: CodeGraphIndexer;
  readonly mcp: GraphifyMcpClient;

  constructor(partial: Partial<CodeGraphConfig> | undefined, opts: { gitBin?: string; gitDir?: string | null } = {}) {
    this.cfg = resolveCodeGraphConfig(partial);
    this.home = codeGraphHome(this.cfg);
    this.audit = new CodeGraphAudit(auditPath(this.home));
    const gitDir = opts.gitDir !== undefined ? opts.gitDir : defaultGitDir();
    this.indexer = new CodeGraphIndexer({ cfg: this.cfg, home: this.home, audit: this.audit, gitBin: opts.gitBin, gitDir });
    this.mcp = new GraphifyMcpClient({ cfg: this.cfg, home: this.home, audit: this.audit });
  }

  status(root: string): Promise<ProjectIndexStatus> {
    return this.indexer.status(root);
  }

  /** Called when a task/workspace becomes active. Never indexes a project the user has not opted in. */
  async onWorkspaceOpen(root: string): Promise<OpenDecision> {
    const status = await this.indexer.status(root);
    if (!this.cfg.enabled || status.runtime !== "ready" || this.indexer.isDenied(root)) return { action: "none", status };
    if (!status.optedIn) {
      if (status.declined) return { action: "none", status };
      if (this.cfg.autoIndex === "ask-on-first-open") return { action: "ask-consent", status };
      if (this.cfg.autoIndex === "always") {
        this.indexer.optIn(root);
        this.indexer.requestIndex(root, "workspace-open");
        return { action: "index", status: await this.indexer.status(root) };
      }
      return { action: "none", status };
    }
    if ((status.state === "never-indexed" || status.state === "stale" || status.state === "failed") && this.cfg.autoRefresh) {
      this.indexer.requestIndex(root, status.state === "stale" ? "head-changed" : "workspace-open");
      return { action: "index", status: await this.indexer.status(root) };
    }
    return { action: "none", status };
  }

  async query(root: string, req: CodeGraphQueryRequest): Promise<CodeGraphQueryResult> {
    const t0 = Date.now();
    const status = await this.indexer.status(root);
    const base = { kind: req.kind, projectId: status.projectId, state: status.state, builtAtCommit: status.builtAtCommit } as const;
    const hasGraph = fs.existsSync(graphJsonPath(status.storeDir));
    if (!hasGraph || status.state === "disabled" || status.state === "runtime-missing") {
      const text = notIndexedText(status.state, status.optedIn);
      return { ...base, ok: false, outcome: "not-indexed", text, bytes: Buffer.byteLength(text), truncatedByLoam: false, durationMs: Date.now() - t0 };
    }
    // Stale graphs still answer (labelled) while an incremental refresh runs in the background.
    if (status.state === "stale" && this.cfg.autoRefresh && status.optedIn) {
      try { this.indexer.requestIndex(root, "tool"); } catch { /* disabled mid-flight */ }
    }

    let text: string;
    let isError = false;
    let cliOutcome: ReturnType<typeof classifyCliExit> | null = null;
    try {
      if (req.kind === "affected") {
        const r = await this.affected(status.storeDir, req.name, req.depth, req.relations);
        text = r.text;
        cliOutcome = classifyCliExit(r.code);
        // Windows deviation (U-7): the CLI may exit 0 for "No unique node match …"
        // text. Text classification wins over an exit code that claims an answer.
        if (cliOutcome === "answer") {
          const byText = classifyGraphifyText(text, false);
          if (byText !== "answer") cliOutcome = byText;
        }
      } else {
        const [tool, args] = this.toTool(req);
        const reply = await this.mcp.call(tool, args, status.storeDir);
        text = reply.text;
        isError = reply.isError;
      }
    } catch (err) {
      text = `codegraph ${req.kind} failed: ${err instanceof Error ? err.message : String(err)}`;
      isError = true;
    }
    const outcome = cliOutcome ?? classifyGraphifyText(text, isError);
    const header = headerLine(status);
    const capped = capBytes(`${header}\n${text}`, this.cfg.maxResultBytes, "Narrow the question, lower depth, or use codegraph_node / codegraph_neighbors on one symbol.");
    const result: CodeGraphQueryResult = {
      ...base, ok: outcome !== "error", outcome, text: capped.text, bytes: capped.bytes,
      truncatedByLoam: capped.truncated, durationMs: Date.now() - t0,
    };
    this.audit.write({
      event: "codegraph.query", projectId: status.projectId, tool: req.kind, outcome,
      durationMs: result.durationMs, bytes: result.bytes, argsDigest: argsDigest(req as unknown as Record<string, unknown>),
    });
    return result;
  }

  private toTool(req: Exclude<CodeGraphQueryRequest, { kind: "affected" }>): [GraphifyAllowedTool, Record<string, unknown>] {
    const budget = (b?: number): number => Math.min(Math.max(Math.trunc(b ?? this.cfg.defaultTokenBudget), 200), this.cfg.maxTokenBudget);
    switch (req.kind) {
      case "query":
        return ["query_graph", {
          question: req.question, mode: req.mode === "dfs" ? "dfs" : "bfs",
          depth: Math.min(Math.max(Math.trunc(req.depth ?? 3), 1), 6), token_budget: budget(req.tokenBudget),
          ...(req.contextFilter?.length ? { context_filter: req.contextFilter } : {}),
        }];
      case "node":
        return ["get_node", { label: req.name }];
      case "neighbors":
        return ["get_neighbors", { label: req.name, token_budget: budget(req.tokenBudget), ...(req.relation ? { relation_filter: req.relation } : {}) }];
      case "path":
        return ["shortest_path", { source: req.from, target: req.to, max_hops: Math.min(Math.max(Math.trunc(req.maxHops ?? 8), 1), 12), undirected: req.undirected === true }];
      case "community":
        return ["get_community", { community_id: Math.trunc(req.id), token_budget: budget(req.tokenBudget) }];
      case "hubs":
        return ["god_nodes", { top_n: Math.min(Math.max(Math.trunc(req.topN ?? 10), 1), 50) }];
      case "stats":
        return ["graph_stats", {}];
    }
  }

  /** `graphify affected` is CLI-only in 0.9.95 (not in the MCP catalogue) — reverse blast radius of a symbol. */
  private async affected(storeDir: string, name: string, depth?: number, relations?: string[]): Promise<{ text: string; code: number | null }> {
    const exe = engineExecutables(this.home);
    const args = ["affected", name, "--graph", graphJsonPath(storeDir), "--depth", String(Math.min(Math.max(Math.trunc(depth ?? 2), 1), 4))];
    for (const r of relations ?? []) if (/^[a-z_]{1,32}$/.test(r)) args.push("--relation", r);
    const env = buildChildEnv({ pathPrepend: [path.dirname(exe.graphify)] });
    const r = await run(exe.graphify, args, { cwd: storeDir, env, timeoutMs: this.cfg.queryTimeoutMs, maxCaptureBytes: this.cfg.maxResultBytes * 2 });
    if (r.timedOut) return { text: `graphify affected timed out after ${this.cfg.queryTimeoutMs} ms`, code: null };
    return { text: (r.stdout || r.stderr).trim() || "(no output)", code: r.code };
  }

  async dispose(): Promise<void> {
    this.indexer.dispose();
    await this.mcp.close();
  }
}

export function headerLine(s: ProjectIndexStatus): string {
  const built = s.builtAtCommit ? s.builtAtCommit.slice(0, 7) : "unknown";
  const stale = s.state === "stale" ? ` STALE(${s.staleReasons.join(",")}) — verify with file_read before editing` : "";
  return `[codegraph project=${s.displayName} state=${s.state} built=${built}${stale}] EXTRACTED = read from source, INFERRED = resolved by graphify; locations are path Lnn.`;
}

export function notIndexedText(state: string, optedIn: boolean): string {
  if (state === "runtime-missing") return "Code Graph engine is not installed. Ask the user to install it from Services › خريطة الكود. Meanwhile use code_symbols, semantic_search and grep.";
  if (state === "disabled" && !optedIn) return "This project is not indexed in Code Graph (the user has not enabled it for this project). Use code_symbols, semantic_search and grep instead; do not ask repeatedly.";
  if (state === "disabled") return "Code Graph is turned off in settings. Use code_symbols, semantic_search and grep.";
  if (state === "indexing") return "Code Graph is building the first index for this project. Use code_symbols / grep for now, or call codegraph_index with wait=true.";
  return "No code graph exists yet for this project. Call codegraph_index (wait=true) or use code_symbols / grep.";
}
