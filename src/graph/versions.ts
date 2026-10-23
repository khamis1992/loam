/**
 * Neo N13: versioned document nodes and their line diffs.
 *
 * A `document`/`webpage`/`kb_seed` node on the run graph is a snapshot: it holds
 * the text the agent produced at that moment. When the user edits the node by
 * hand on the canvas, the previous text is *kept* here so the canvas can show
 * what changed instead of discarding it.
 *
 * Version rows live in the existing `entities` table (see `src/server/sqliteStore.ts`)
 * under the `node_version` family, one row per (nodeId, version) pair. That keeps
 * the module dependency-light: no schema migration, no second database, and the
 * same reset hook the rest of the graph uses. Rows are ordered by their
 * monotonically increasing `seq`, not by wall clock, so two snapshots taken in
 * the same millisecond still keep their order.
 *
 * `diffLines` is the only dependency-free part: a classic LCS over lines that
 * yields a unified-diff-shaped list of hunks, so the canvas can colour each line
 * added, removed or unchanged. It is written to stay exact on multi-line and
 * adjacent-edit inputs (the diff is checked against a brute-force oracle in
 * `__tests__/versions.test.ts`).
 */
import { allEntities, onDatabaseReset, putEntity, removeEntity } from "../server/sqliteStore.js";

/** Storage family for one document node version. */
export const NODE_VERSION_ENTITY = "node_version";

/** A text document: the only payload the diff view can render. */
export const DOCUMENT_NODE_TYPES = ["document", "webpage", "kb_seed"] as const;
export type DocumentNodeType = (typeof DOCUMENT_NODE_TYPES)[number];

/** Ceiling per node: a runaway loop of edits must not fill the database. */
export const MAX_VERSIONS_PER_NODE = 200;

/** One stored snapshot of a node's document. */
export interface NodeVersion {
  id: string;
  /** The run node this version belongs to. */
  nodeId: string;
  /** Owning run (Loam task id); keeps reads per-run without a join. */
  runId: string;
  /** 1-based version number, matching the node's own `version` field. */
  version: number;
  /** Monotonic insertion order; the diff orders rows by it, not by wall clock. */
  seq: number;
  /** The node kind at capture time (`document`, `webpage`, `kb_seed`). */
  type: string;
  /** Which revision of the run node this text was read from. */
  nodeVersion: number;
  /** Human title of the document. */
  title: string;
  /** Full text of this version. */
  content: string;
  /** Wall-clock capture time. */
  created: number;
  /** ISO string kept for display; `created` drives ordering. */
  createdAt: string;
  /** Where the snapshot came from: the agent, or the user's canvas edit. */
  source: "agent" | "user";
}

/** Strip the storage-only `seq` from the public projection. */
function publicVersion(row: NodeVersion): Omit<NodeVersion, "seq"> {
  const { seq: _seq, ...rest } = row;
  return rest;
}

/** Coerce an unknown row; undefined when it cannot be used. */
function coerceVersion(value: unknown): NodeVersion | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.nodeId !== "string" || typeof row.runId !== "string") return undefined;
  if (typeof row.version !== "number" || !Number.isFinite(row.version)) return undefined;
  if (typeof row.content !== "string") return undefined;
  return {
    id: typeof row.id === "string" ? row.id : `${row.nodeId}@${row.version}`,
    nodeId: row.nodeId,
    runId: row.runId,
    version: row.version,
    seq: typeof row.seq === "number" && Number.isFinite(row.seq) ? row.seq : 0,
    type: typeof row.type === "string" ? row.type : "document",
    nodeVersion: typeof row.nodeVersion === "number" && Number.isFinite(row.nodeVersion) ? row.nodeVersion : 1,
    title: typeof row.title === "string" ? row.title : "",
    content: row.content,
    created: typeof row.created === "number" && Number.isFinite(row.created) ? row.created : 0,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
    source: row.source === "user" ? "user" : "agent",
  };
}

/** True when a node kind carries text that can be versioned and diffed. */
export function isDocumentNodeType(type: string): boolean {
  return (DOCUMENT_NODE_TYPES as readonly string[]).includes(type);
}

/**
 * Persistence and diffing for one node's document versions.
 *
 * The row cache is dropped by the shared `onDatabaseReset` hook, so a test that
 * swaps the data directory cannot read a stale cache.
 */
export class NodeVersionStore {
  /** Insertion cursor; never resets so rows keep a stable order. */
  private seq = 0;
  private rows = new Map<string, NodeVersion>();
  private loaded = false;

  constructor() {
    onDatabaseReset(() => this.reset());
  }

  /** Forget the cached rows (called when the database connection is reset). */
  reset(): void {
    this.rows.clear();
    this.loaded = false;
    this.seq = 0;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    for (const row of allEntities<NodeVersion>(NODE_VERSION_ENTITY)) {
      const coerced = coerceVersion(row);
      if (coerced) this.rows.set(coerced.id, coerced);
    }
    this.seq = [...this.rows.values()].reduce((max, row) => Math.max(max, row.seq), 0);
    this.loaded = true;
  }

  /** Versions of one node, oldest first. */
  list(nodeId: string): Array<Omit<NodeVersion, "seq">> {
    this.ensureLoaded();
    return [...this.rows.values()]
      .filter((row) => row.nodeId === nodeId)
      .sort(compareVersions)
      .map(publicVersion);
  }

  /** Versions of every document node of a run, keyed by node id. */
  listForRun(runId: string): Record<string, Array<Omit<NodeVersion, "seq">>> {
    this.ensureLoaded();
    const out: Record<string, Array<Omit<NodeVersion, "seq">>> = {};
    for (const row of this.rows.values()) {
      if (row.runId !== runId) continue;
      (out[row.nodeId] ??= []).push(publicVersion(row));
    }
    for (const nodeId of Object.keys(out)) out[nodeId]!.sort((a, b) => a.version - b.version);
    return out;
  }

  /** One version by its number; undefined when this node has no such version. */
  get(nodeId: string, version: number): Omit<NodeVersion, "seq"> | undefined {
    this.ensureLoaded();
    for (const row of this.rows.values()) {
      if (row.nodeId === nodeId && row.version === version) return publicVersion(row);
    }
    return undefined;
  }

  /** The newest stored version; undefined when the node has none. */
  latest(nodeId: string): Omit<NodeVersion, "seq"> | undefined {
    const list = this.list(nodeId);
    return list.length > 0 ? list[list.length - 1] : undefined;
  }

  /** Total stored versions of one node. */
  count(nodeId: string): number {
    return this.list(nodeId).length;
  }

  /**
   * Store one version. Idempotent per (nodeId, version): capturing the same
   * snapshot twice replaces the row instead of duplicating it, and the returned
   * row reports the version actually written.
   */
  put(input: {
    nodeId: string;
    runId: string;
    version: number;
    type: string;
    /** Which node revision this text was read from. */
    nodeVersion: number;
    title: string;
    content: string;
    source?: "agent" | "user";
    created?: number;
  }): Omit<NodeVersion, "seq"> {
    this.ensureLoaded();
    const existing = [...this.rows.values()].find(
      (row) => row.nodeId === input.nodeId && row.version === input.version,
    );
    const now = input.created ?? Date.now();
    const row: NodeVersion = {
      id: existing?.id ?? `${input.nodeId}@${input.version}`,
      nodeId: input.nodeId,
      runId: input.runId,
      version: input.version,
      seq: existing?.seq ?? ++this.seq,
      type: input.type,
      nodeVersion: input.nodeVersion,
      title: input.title,
      content: input.content,
      created: existing?.created ?? now,
      createdAt: new Date(now).toISOString(),
      source: input.source ?? "agent",
    };
    putEntity(NODE_VERSION_ENTITY, row);
    this.rows.set(row.id, row);
    return publicVersion(row);
  }

  /**
   * Capture the current node text as a version. When the node has moved since
   * the last snapshot the new version number is `previous + 1`; the first
   * capture of a node is version 1.
   *
   * Returns undefined for a node that carries no text (a search, a media node,
   * ...) and for a repeat capture, so a caller can use the return value as
   * "was a row written?". A caller that needs the current snapshot regardless
   * reads it with `latest`.
   */
  capture(input: {
    nodeId: string;
    runId: string;
    type: string;
    title: string;
    content: string;
    /** Which node revision this text was read from; recorded, not numbered from. */
    nodeVersion: number;
    source?: "agent" | "user";
    created?: number;
  }): Omit<NodeVersion, "seq"> | undefined {
    if (!isDocumentNodeType(input.type)) return undefined;
    const content = input.content ?? "";
    const latest = this.latest(input.nodeId);
    // Same text from the *same* node revision is a repeat capture, not a new
    // snapshot. A later event that writes identical text does move the node
    // revision on, and that is a distinct snapshot: the canvas diffs revisions,
    // so "the agent re-wrote this unchanged" has to stay visible.
    if (latest && latest.content === content && latest.nodeVersion === input.nodeVersion) return undefined;
    // The snapshot number counts *snapshots*, not node revisions: a node is
    // created (v1) and then its text is written (v2), so deriving the version
    // from the node revision would make the first snapshot "v2" and leave v1
    // permanently missing from the diff view.
    return this.put({
      ...input,
      version: latest ? latest.version + 1 : 1,
      content,
      source: input.source ?? (latest ? latest.source : "agent"),
    });
  }

  /** Keep the newest `keep` versions of a node; returns how many were dropped. */
  prune(nodeId: string, keep = MAX_VERSIONS_PER_NODE): number {
    this.ensureLoaded();
    const versions = [...this.rows.values()]
      .filter((row) => row.nodeId === nodeId)
      .sort(compareVersions);
    const stale = versions.slice(0, Math.max(0, versions.length - keep));
    for (const row of stale) {
      removeEntity(NODE_VERSION_ENTITY, row.id);
      this.rows.delete(row.id);
    }
    return stale.length;
  }

  /** Drop every version of one node (used when the node itself is removed). */
  clearNode(nodeId: string): void {
    this.ensureLoaded();
    for (const row of [...this.rows.values()]) {
      if (row.nodeId !== nodeId) continue;
      removeEntity(NODE_VERSION_ENTITY, row.id);
      this.rows.delete(row.id);
    }
  }

  /** Drop every version of a run. */
  clearRun(runId: string): void {
    this.ensureLoaded();
    for (const row of [...this.rows.values()]) {
      if (row.runId !== runId) continue;
      removeEntity(NODE_VERSION_ENTITY, row.id);
      this.rows.delete(row.id);
    }
  }
}

/** Stable version order: insertion order first, then version number, then id. */
export function compareVersions(a: { seq: number; version: number; id: string }, b: { seq: number; version: number; id: string }): number {
  if (a.seq !== b.seq) return a.seq - b.seq;
  if (a.version !== b.version) return a.version - b.version;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/* ------------------------------------------------------------------ diff ---- */

export type DiffOp = "equal" | "delete" | "insert";

export interface DiffLine {
  op: DiffOp;
  /** Line text without its trailing newline. */
  text: string;
  /** 1-based line number in `a`, or null for an inserted line. */
  oldLine: number | null;
  /** 1-based line number in `b`, or null for a removed line. */
  newLine: number | null;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The changed lines plus `context` unchanged lines on each side. */
  lines: DiffLine[];
}

export interface DiffResult {
  /** Every line of the aligned pair, in order; the source of truth for a view. */
  lines: DiffLine[];
  /** Changed blocks, each padded with `context` unchanged lines. Empty when equal. */
  hunks: DiffHunk[];
  added: number;
  removed: number;
  unchanged: number;
  /** True when nothing changed (and `hunks` is empty). */
  empty: boolean;
}

/** Split into lines, keeping a trailing newline from producing a phantom line. */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const parts = text.split("\n");
  // "a\n" -> ["a", ""]; the empty tail is not a line of its own.
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/**
 * Line diff by longest-common-subsequence. `lines` is the full aligned pair
 * (every line of both documents, in order), and `hunks` groups the changed
 * blocks the way `unified diff` does. `delete` precedes `insert` inside a
 * changed block, so removed lines read as a block.
 */
export function diffLines(a: string, b: string): DiffResult {
  const aLines = splitLines(a);
  const bLines = splitLines(b);
  const table = lcsTable(aLines, bLines);
  const lines: DiffLine[] = walkBacktrack(table, aLines, bLines).map((step) => ({
    op: step.kind,
    text: step.text,
    oldLine: step.kind === "insert" ? null : step.oldIndex + 1,
    newLine: step.kind === "delete" ? null : step.newIndex + 1,
  }));
  return summarize(lines);
}

/** Flatten a hunk back to its changed lines (context stripped). */
export function changedLines(lines: readonly DiffLine[]): DiffLine[] {
  return lines.filter((line) => line.op !== "equal");
}

type LcsStep =
  | { kind: "equal"; oldIndex: number; newIndex: number; text: string }
  | { kind: "delete"; oldIndex: number; newIndex: null; text: string }
  | { kind: "insert"; oldIndex: null; newIndex: number; text: string };

/**
 * Classic O(nm) dynamic programming LCS. Documents a node holds are bounded (a
 * report is a few thousand lines), so storing the whole backtrack table is fine
 * and the diff stays exact rather than heuristic.
 */
function lcsTable(a: readonly string[], b: readonly string[]): Int32Array {
  const n = a.length;
  const m = b.length;
  // `dp[i][j]` = length of the LCS of `a.slice(i)` and `b.slice(j)`.
  const dp = new Int32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const value = a[i] === b[j]
        ? dp[(i + 1) * (m + 1) + (j + 1)]! + 1
        : Math.max(dp[(i + 1) * (m + 1) + j]!, dp[i * (m + 1) + (j + 1)]!);
      dp[i * (m + 1) + j] = value;
    }
  }
  return dp;
}

/** Walk the table from (0,0) to the end, preferring a match then a deletion. */
function walkBacktrack(table: Int32Array, a: readonly string[], b: readonly string[]): LcsStep[] {
  const row = b.length + 1;
  const steps: LcsStep[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      steps.push({ kind: "equal", oldIndex: i, newIndex: j, text: a[i]! });
      i += 1;
      j += 1;
      continue;
    }
    const down = table[(i + 1) * row + j]!;
    const right = table[i * row + (j + 1)]!;
    if (down >= right) {
      steps.push({ kind: "delete", oldIndex: i, newIndex: null, text: a[i]! });
      i += 1;
    } else {
      steps.push({ kind: "insert", oldIndex: null, newIndex: j, text: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) {
    steps.push({ kind: "delete", oldIndex: i, newIndex: null, text: a[i]! });
    i += 1;
  }
  while (j < b.length) {
    steps.push({ kind: "insert", oldIndex: null, newIndex: j, text: b[j]! });
    j += 1;
  }
  return steps;
}

/** Count the ops and cut the changed blocks into context-padded hunks. */
function summarize(lines: DiffLine[]): DiffResult {
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const line of lines) {
    if (line.op === "insert") added += 1;
    else if (line.op === "delete") removed += 1;
    else unchanged += 1;
  }
  return {
    lines,
    hunks: groupHunks(lines),
    added,
    removed,
    unchanged,
    empty: added === 0 && removed === 0,
  };
}

/**
 * Cut the aligned lines into hunks: a maximal run of changed lines, extended by
 * up to `context` unchanged lines on each side. Two runs separated by at most
 * `2 * context` unchanged lines merge into one hunk, matching `unified diff`.
 */
function groupHunks(lines: readonly DiffLine[], context = 3): DiffHunk[] {
  const isChange = (line: DiffLine): boolean => line.op !== "equal";
  const hunks: DiffHunk[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!isChange(lines[i]!)) {
      i += 1;
      continue;
    }
    const start = Math.max(0, i - context);
    // Walk forward to the end of this changed run, merging close runs.
    let j = i;
    let lastChange = i;
    let gap = 0;
    while (j < lines.length) {
      if (isChange(lines[j]!)) {
        lastChange = j;
        gap = 0;
      } else {
        gap += 1;
        if (gap > context * 2) break;
      }
      j += 1;
    }
    const end = Math.min(lines.length, lastChange + context + 1);
    const slice = lines.slice(start, end);
    const oldLines = slice.filter((line) => line.op !== "insert").length;
    const newLines = slice.filter((line) => line.op !== "delete").length;
    hunks.push({
      oldStart: slice[0]!.oldLine ?? 0,
      oldLines,
      newStart: slice[0]!.newLine ?? 0,
      newLines,
      lines: [...slice],
    });
    i = end;
  }
  return hunks;
}

/**
 * Is the diff of `a` -> `b` *exactly* a set of insertions? Used to answer "did
 * the agent only add material?" without scanning every line.
 */
export function isInsertOnly(diff: DiffResult): boolean {
  return diff.added > 0 && diff.removed === 0;
}

/** Compact one-line summary, e.g. `+2 -1`. */
export function diffSummary(diff: DiffResult): string {
  return `+${diff.added} -${diff.removed}`;
}

/** The new text, rebuilt from the aligned lines (`equal` + `insert`). */
export function applyNew(diff: DiffResult): string {
  return diff.lines.filter((line) => line.op !== "delete").map((line) => line.text).join("\n");
}

/** The old text, rebuilt from the aligned lines (`equal` + `delete`). */
export function applyOld(diff: DiffResult): string {
  return diff.lines.filter((line) => line.op !== "insert").map((line) => line.text).join("\n");
}
