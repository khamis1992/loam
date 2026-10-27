/**
 * Code Graph (graphify) — data model surfaced to Loam.
 *
 * Raw* types mirror graphify 0.9.95 `graph.json` exactly as OBSERVED on the
 * box (field census over an 18,425-node graph of Loam itself). Loam never
 * writes graph.json; it only reads the tail (built_at_commit) and asks the
 * pinned graphify MCP server / CLI for answers.
 */

/** Edge provenance, OBSERVED in graphify ARCHITECTURE.md "Confidence labels". */
export type CodeGraphConfidence = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";

/** Relations OBSERVED in the Loam graph (descending frequency), open for new upstream values. */
export type CodeGraphRelation =
  | "contains" | "calls" | "imports" | "imports_from" | "method" | "references"
  | "indirect_call" | "re_exports" | "dynamic_import" | "inherits" | "declares" | "implements"
  | (string & {});

/** Node file_type values OBSERVED: code, concept, rationale (code-only run). Docs/papers/images need an LLM pass Loam disables. */
export type CodeGraphFileType = "code" | "concept" | "rationale" | "document" | "paper" | "image" | (string & {});

/** One node as written in graph.json (`nodes[]`). */
export interface RawGraphNode {
  id: string;
  label: string;
  norm_label: string;
  community: number;
  file_type: CodeGraphFileType;
  source_file: string;
  source_location?: string; // "L42"
  _origin?: "ast" | (string & {});
  _callable?: boolean;
  _callable_class?: boolean;
  metadata?: Record<string, unknown>;
  external?: boolean;
  type?: string;
  _ts_fields?: Record<string, string>;
}

/** One edge as written in graph.json (`links[]`); arc order is the direction (source -> target). */
export interface RawGraphLink {
  source: string;
  target: string;
  relation: CodeGraphRelation;
  confidence: CodeGraphConfidence;
  confidence_score: number;
  source_file: string;
  source_location?: string;
  weight?: number;
  context?: string; // "call" | "field" | ...
  type_only?: boolean;
  deferred?: boolean;
  _origin?: string;
  metadata?: Record<string, unknown>;
}

/** Top-level graph.json (OBSERVED keys: directed, multigraph, graph, nodes, links, hyperedges, built_at_commit). */
export interface RawGraphFile {
  directed: boolean;
  multigraph: boolean;
  graph: { schema_version: number; graphify_version?: string };
  nodes: RawGraphNode[];
  links: RawGraphLink[];
  hyperedges?: unknown[];
  built_at_commit?: string | null;
}

/** Loam-facing node shape (camelCase; what UI/status code uses). */
export interface CodeGraphNode {
  id: string;
  label: string;
  fileType: CodeGraphFileType;
  sourceFile: string;
  line?: number;
  community: number;
  callable: boolean;
}

/** Loam-facing edge shape. */
export interface CodeGraphEdge {
  source: string;
  target: string;
  relation: CodeGraphRelation;
  confidence: CodeGraphConfidence;
  confidenceScore: number;
  sourceFile: string;
  line?: number;
}

export function toCodeGraphNode(n: RawGraphNode): CodeGraphNode {
  return {
    id: n.id,
    label: n.label,
    fileType: n.file_type,
    sourceFile: n.source_file,
    line: parseLine(n.source_location),
    community: n.community,
    callable: n._callable === true,
  };
}

export function toCodeGraphEdge(l: RawGraphLink): CodeGraphEdge {
  return {
    source: l.source,
    target: l.target,
    relation: l.relation,
    confidence: l.confidence,
    confidenceScore: l.confidence_score,
    sourceFile: l.source_file,
    line: parseLine(l.source_location),
  };
}

export function parseLine(loc: string | undefined): number | undefined {
  const m = loc ? /^L(\d+)/.exec(loc) : null;
  return m?.[1] ? Number(m[1]) : undefined;
}

// ---------------------------------------------------------------------------
// Index lifecycle
// ---------------------------------------------------------------------------

export type CodeGraphRuntimeState = "not-installed" | "installing" | "ready" | "broken";

export type ProjectIndexState =
  | "disabled"        // feature off or project not opted in
  | "runtime-missing" // engine not installed
  | "never-indexed"
  | "indexing"
  | "ready"
  | "stale"           // HEAD moved or Loam wrote files since the last successful job
  | "failed";

export type IndexTrigger = "user" | "consent-first-open" | "workspace-open" | "agent-writes" | "head-changed" | "tool";

export type IndexJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timeout";

export interface IndexJob {
  id: string;            // "cgj_" + 12 hex
  projectId: string;
  root: string;
  trigger: IndexTrigger;
  full: boolean;         // true = --force
  status: IndexJobStatus;
  queuedAt: string;      // ISO
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  nodes?: number;
  edges?: number;
  communities?: number;
  filesCached?: number;
  filesReextracted?: number;
  filesDeleted?: number;
  oversizedExcluded?: number;
  error?: string;
  /** Last 4,000 chars of stderr, secrets never present (child env is allowlisted). */
  stderrTail?: string;
}

/** Persisted per project at <store>/loam-index.json. */
export interface ProjectIndexRecord {
  version: 1;
  projectId: string;
  root: string;
  displayName: string;
  optedIn: boolean;
  optedInAt?: string;
  /** Set by «أبداً» in the consent banner; Loam never asks again until the user opts in from Services. */
  declinedAt?: string | null;
  lastJob?: IndexJob;
  lastSuccess?: IndexJob;
  builtAtCommit?: string | null;
  graphifyVersion?: string;
  schemaVersion?: number;
  graphBytes?: number;
  dirtySince?: string | null;
}

export interface ProjectIndexStatus {
  projectId: string;
  root: string;
  displayName: string;
  state: ProjectIndexState;
  runtime: CodeGraphRuntimeState;
  optedIn: boolean;
  declined: boolean;
  builtAtCommit: string | null;
  headCommit: string | null;
  staleReasons: StaleReason[];
  nodes?: number;
  edges?: number;
  communities?: number;
  graphBytes?: number;
  lastJob?: IndexJob;
  storeDir: string;
}

export type StaleReason = "head-moved" | "loam-wrote-files" | "older-than-max-age" | "schema-mismatch" | "version-mismatch";

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export type CodeGraphQueryKind = "query" | "node" | "neighbors" | "path" | "community" | "hubs" | "stats" | "affected";

export type CodeGraphQueryRequest =
  | { kind: "query"; question: string; mode?: "bfs" | "dfs"; depth?: number; tokenBudget?: number; contextFilter?: string[] }
  | { kind: "node"; name: string }
  | { kind: "neighbors"; name: string; relation?: string; tokenBudget?: number }
  | { kind: "path"; from: string; to: string; maxHops?: number; undirected?: boolean }
  | { kind: "community"; id: number; tokenBudget?: number }
  | { kind: "hubs"; topN?: number }
  | { kind: "stats" }
  | { kind: "affected"; name: string; depth?: number; relations?: string[] };

export type CodeGraphOutcome = "answer" | "ambiguous" | "not-found" | "truncated" | "error" | "not-indexed";

export interface CodeGraphQueryResult {
  ok: boolean;
  kind: CodeGraphQueryKind;
  outcome: CodeGraphOutcome;
  /** Text returned to the model (already budget-capped; wrapped as untrusted by the agent loop). */
  text: string;
  bytes: number;
  truncatedByLoam: boolean;
  projectId: string;
  state: ProjectIndexState;
  builtAtCommit: string | null;
  durationMs: number;
}

/** Audit record appended to <home>/audit.jsonl. Never contains file contents or query results. */
export interface CodeGraphAuditEvent {
  ts: string;
  event:
    | "codegraph.runtime.install.start" | "codegraph.runtime.install.ok" | "codegraph.runtime.install.fail"
    | "codegraph.project.optin" | "codegraph.project.optout" | "codegraph.project.purge"
    | "codegraph.index.start" | "codegraph.index.ok" | "codegraph.index.fail"
    | "codegraph.mcp.connect" | "codegraph.mcp.disconnect" | "codegraph.mcp.catalogue-drift"
    | "codegraph.query";
  projectId?: string;
  jobId?: string;
  tool?: string;
  outcome?: string;
  durationMs?: number;
  bytes?: number;
  /** sha256 of the canonical JSON args — never the raw question text. */
  argsDigest?: string;
  detail?: string;
}
