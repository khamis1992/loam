/**
 * Neo N13: capture a document node's text as a version.
 *
 * The version *store* (`src/graph/versions.ts`) only knows how to persist a
 * snapshot. This module decides *what* to snapshot: a `document`, `webpage` or
 * `kb_seed` node whose payload carries real text. Everything else (a search, a
 * media node, a status card) is skipped, so the version list never fills up with
 * nodes that cannot be diffed.
 *
 * Two things make the text trustworthy:
 *   1. it is read through the same `entities` table the graph uses, so a node
 *      written by the agent and a node edited on the canvas are the same object;
 *   2. an in-process cache means one edit that travels the round trip
 *      node -> server -> client -> server is captured once, not three times.
 *
 * Nothing here can break a run: `captureRunNodes` returns how many snapshots it
 * took and swallows every failure, exactly like `runGraphAdapter`.
 */
import fs from "node:fs";
import path from "node:path";
import { NodeVersionStore, isDocumentNodeType, type NodeVersion } from "./versions.js";
import type { RunNodeQuery, RunNodeRow } from "./store.js";
import { isInside } from "../policy/paths.js";

/** Payload keys that hold document text, most specific first. */
const TEXT_KEYS = ["content", "text", "body", "document", "markdown", "result"] as const;
const TITLE_KEYS = ["title", "path", "url", "name", "seedId", "tool"] as const;
/** A preview/summary is a truncated copy of the text, so it is never the source. */
const SUMMARY_KEYS = new Set(["summary", "preview", "description", "reason"]);

/** True when a node kind can carry a diffable document. */
export function canVersionNode(type: string): boolean {
  return isDocumentNodeType(type);
}

/** Read the document text out of a node payload; "" when it holds none. */
export function nodeText(node: { data?: unknown }): string {
  if (typeof node.data !== "object" || node.data === null) return "";
  const record = node.data as Record<string, unknown>;
  for (const key of TEXT_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  // Structured text: `{ "sections": [{ "body": "..." }] }`, a tool result body,
  // anything the agent produced as a nested list of strings.
  const nested = findNestedText(record);
  return nested ?? "";
}

function findNestedText(value: unknown, depth = 0): string | undefined {
  if (depth > 4) return undefined;
  if (typeof value === "string") return value.trim() ? value : undefined;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const text = findNestedText(item, depth + 1);
      if (text) parts.push(text);
    }
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (SUMMARY_KEYS.has(key)) continue;
    const text = findNestedText(child, depth + 1);
    if (text) return text;
  }
  return undefined;
}

/** Human title for a node, falling back to its kind when the payload has none. */
export function nodeTitle(node: { data?: unknown; type: string }): string {
  if (typeof node.data === "object" && node.data !== null) {
    const record = node.data as Record<string, unknown>;
    for (const key of TITLE_KEYS) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return node.type;
}

/** One node's text content resolved for capture. */
export function nodeDocument(node: { data?: unknown; type: string }): { title: string; content: string } | undefined {
  if (!canVersionNode(node.type)) return undefined;
  const content = nodeText(node);
  if (!content) return undefined;
  // A `tool_call` node holds only its call metadata (`{ tool, path, query }`),
  // which `findNestedText` happily reads as "text". That is not a document: the
  // real text arrives with the matching `tool_result`, so a metadata-only node
  // must not be snapshotted or it would capture the tool name as version 1.
  if (isToolCallData(node.data)) return undefined;
  return { title: nodeTitle(node), content };
}

/** True when a payload is exactly the shape `toolCallData` writes. */
function isToolCallData(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const record = data as Record<string, unknown>;
  if (typeof record.tool !== "string") return false;
  for (const [key, value] of Object.entries(record)) {
    if (key === "tool") continue;
    // `summary`/`ok` arrive with the tool result, so they prove this is a
    // result payload rather than the call metadata.
    if (key === "summary" || key === "ok" || key === "content") return false;
    if (typeof value !== "string") return false;
  }
  return true;
}

/** Live per-process store; the server owns one instance. */
let versionStore: NodeVersionStore | undefined;

/**
 * Live run-node rows, read through the *same* store `RunGraph` writes through.
 *
 * This must be a row-index supplied by the caller, not a `RunGraphStore` created
 * here: a store instance snapshots its rows on first read, so an index built
 * before the run existed would never see the nodes the live graph writes, and
 * every capture would silently miss. `runGraphAdapter.liveNodeIndex()` hands over
 * the graph's own store, so a node written by an event is immediately visible.
 */
let nodeIndex: NodeIndex | undefined;

/** The slice of `RunGraphStore` capture needs: read one row by id. */
export interface NodeIndex {
  getRow(id: string): RunNodeRow | undefined;
  /** Every row of one run, in graph order. */
  listRows(query: RunNodeQuery): RunNodeRow[];
}

/**
 * Point capture at the row index the live run graph writes through.
 *
 * `undefined` is accepted so a caller that holds a possibly-absent index (the live
 * adapter) can hand it over without a cast; capture then reports "nothing read"
 * rather than throwing.
 */
export function setNodeIndex(index: NodeIndex | undefined): void {
  nodeIndex = index;
}

/** Drop the row index (a swapped database must not read stale rows). */
export function clearNodeIndex(): void {
  nodeIndex = undefined;
}

/** The process-wide version store (created on first use). */
export function getVersionStore(): NodeVersionStore {
  if (!versionStore) versionStore = new NodeVersionStore();
  return versionStore;
}

/**
 * Forget the process-wide stores. A test that swaps the data directory must drop
 * both, or the next capture reads a stale row cache.
 */
export function resetNodeVersions(): void {
  versionStore = undefined;
  clearNodeIndex();
}

/**
 * Capture one run node's current text as a version.
 *
 * `expectedVersion` is the node version the caller read. When the node has moved
 * on since (the agent wrote again while the edit was in flight) the call is
 * skipped rather than capturing a stale overwrite, which keeps the returned
 * version number an honest match for the text.
 */
export function captureNodeVersion(input: {
  nodeId: string;
  runId: string;
  type?: string;
  title?: string;
  content?: string;
  nodeVersion: number;
  expectedVersion?: number;
  source?: "agent" | "user";
  created?: number;
}): Omit<NodeVersion, "seq"> | undefined {
  if (!nodeIndex) return undefined;
  const store = getVersionStore();
  const node = nodeIndex.getRow(input.nodeId);
  if (!node || node.run_id !== input.runId) return undefined;
  if (input.expectedVersion !== undefined && node.version !== input.expectedVersion) return undefined;
  const doc = input.content !== undefined
    ? { title: input.title ?? nodeTitle(node), content: input.content }
    : nodeDocument(node);
  if (!doc) return undefined;
  return store.capture({
    nodeId: node.id,
    runId: node.run_id,
    type: input.type ?? node.type,
    title: doc.title,
    content: doc.content,
    // Which node revision this text belongs to. Callers that only have a node id
    // pass nothing, so the row is stamped with the node's own version; a caller
    // that already read the node (the canvas) passes that number explicitly.
    nodeVersion: input.nodeVersion ?? node.version,
    source: input.source,
    ...(input.created !== undefined ? { created: input.created } : {}),
  });
}

/**
 * Capture every document node of a run that currently carries text.
 *
 * Called from the throwaway-safe seam (`runGraphAdapter`) so a snapshot is taken
 * as the agent emits, without the agent having to know versions exist. Returns
 * the number of snapshots written (0 is a normal answer for a run with no
 * documents yet).
 */
export function captureRunNodes(runId: string, source: "agent" | "user" = "agent"): number {
  if (!nodeIndex) return 0;
  const ids = nodeIndex.listRows({ runId })
    .filter((row) => canVersionNode(row.type))
    .map((row) => row.id);
  return captureNodeVersions(runId, ids, source);
}

/**
 * Capture only the given nodes of a run.
 *
 * The live graph calls this with the ids one event touched, so a 10k-node run
 * costs one snapshot per event instead of a full scan per event.
 */
export function captureNodeVersions(
  runId: string,
  nodeIds: readonly string[],
  source: "agent" | "user" = "agent",
): number {
  let captured = 0;
  try {
    const index = nodeIndex;
    if (!index) return 0;
    for (const id of nodeIds) {
      const row = index.getRow(id);
      if (!row || row.run_id !== runId || !canVersionNode(row.type)) continue;
      if (captureNodeVersion({
        nodeId: row.id,
        runId,
        nodeVersion: row.version,
        source,
        created: row.updated,
      })) captured += 1;
    }
  } catch (err) {
    console.warn(`[nodeVersions] failed to capture run ${runId}: ${String(err)}`);
  }
  return captured;
}

/* ------------------------------------------------------------------ files ---- */

/**
 * The text versions of a node that came from *files* rather than its payload.
 *
 * Only `captureNodeFiles` writes these; a normal agent-written document is a
 * single payload version, so a node has at most a handful. They are kept out of
 * `listVersionsForNode` so the diff view never compares a page against its own
 * asset.
 */
export function listFileVersions(nodeId: string): Array<Omit<NodeVersion, "seq">> {
  const rows = getVersionStore().list(nodeId);
  const typed = rows.filter((row) => row.type === "file");
  if (typed.length > 0) return typed;
  // A file row captured by an older build was stored without the `file` type.
  // Fall back to the file titles so the archive still carries those pages.
  return rows.filter((row) => isTextFileName(row.title));
}

/** Text file extensions a webpage/document node can point at. */
const TEXT_EXTENSIONS = new Set([
  ".html", ".htm", ".xhtml", ".css", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx",
  ".json", ".md", ".markdown", ".txt", ".xml", ".svg", ".csv", ".yml", ".yaml",
  ".py", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".cs", ".rb", ".php", ".vue", ".svelte",
]);

/** True when a title is a text file name (used to spot legacy file versions). */
function isTextFileName(title: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(title).toLowerCase());
}

/**
 * Capture the files a node's text refers to, by absolute path.
 *
 * A webpage node frequently names its own output (`path: "site/index.html"`). The
 * text version is the page as it stood when the agent wrote it; the file list is
 * what lets the ZIP carry the assets beside it. Paths are verified to exist, so a
 * node that names a URL or a directory simply contributes no file.
 *
 * When `root` is given, a path outside it is refused. `nodeFiles` already filters
 * by workspace, but this guard makes the function's own contract hold: a caller
 * that passes a raw path (a hand-edited payload, a future route) cannot make the
 * server read an arbitrary file.
 */
export function captureNodeFiles(input: {
  nodeId: string;
  runId: string;
  paths: readonly string[];
  source?: "agent" | "user";
  created?: number;
  /** Task workspace every path must stay inside; omit to skip the check. */
  root?: string;
}): number {
  const root = input.root ? path.resolve(input.root) : undefined;
  let captured = 0;
  for (const raw of input.paths) {
    if (typeof raw !== "string" || raw.trim().length === 0) continue;
    const target = path.resolve(raw.trim());
    if (root && !isInside(root, target)) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(target);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (!TEXT_EXTENSIONS.has(path.extname(target).toLowerCase())) continue;
    try {
      const content = fs.readFileSync(target, "utf8");
      if (!content.trim()) continue;
      const stored = getVersionStore().put({
        nodeId: input.nodeId,
        runId: input.runId,
        version: nextFileVersion(input.nodeId, target),
        type: "file",
        // A file row records which node revision asked for it, so a later canvas
        // capture of the same file is a new snapshot rather than a repeat.
        nodeVersion: readNode(input.nodeId)?.version ?? 1,
        title: path.basename(target),
        content,
        source: input.source ?? "agent",
        ...(input.created !== undefined ? { created: input.created } : {}),
      });
      captured += 1;
      void stored;
    } catch {
      // An unreadable file is skipped: capture must never break the run.
    }
  }
  return captured;
}

/** Next version number for one (node, file) pair, starting at 1. */
function nextFileVersion(nodeId: string, file: string): number {
  const rows = listVersionsForNode(nodeId);
  const prefix = `${file}@`;
  const existing = rows.filter((row) => row.title === path.basename(file) || row.id.startsWith(prefix)).length;
  return existing + 1;
}

/** Versions of one node, oldest first (thin re-export for callers). */
export function listVersionsForNode(nodeId: string): Array<Omit<NodeVersion, "seq">> {
  return getVersionStore().list(nodeId);
}

/**
 * Read one node's current row, or undefined when it does not exist in this run.
 *
 * The routes read nodes through this rather than a bare table scan, so a capture
 * taken from an HTTP request sees exactly the node the canvas is looking at.
 */
export function readNode(nodeId: string, runId?: string): RunNodeRow | undefined {
  const index = nodeIndex;
  if (!index) return undefined;
  const row = index.getRow(nodeId);
  if (!row) return undefined;
  if (runId && row.run_id !== runId) return undefined;
  return row;
}

/** The document text a node holds right now; "" when it is not a document. */
export function nodeCurrentText(node: { data?: unknown; type: string }): string {
  return nodeDocument(node)?.content ?? "";
}

/**
 * Read the *files* a node names, resolved against the task workspace.
 *
 * Only readable text files are returned, and a path is dropped when it escapes
 * the workspace, so a hand-edited node payload can never make the server open an
 * arbitrary file.
 */
export function nodeFiles(node: { data?: unknown }, taskRoot: string): string[] {
  const raw = readPaths(node.data);
  const root = path.resolve(taskRoot);
  const out: string[] = [];
  for (const item of raw) {
    const candidate = path.isAbsolute(item) ? path.resolve(item) : path.resolve(root, item);
    if (!isInside(root, candidate)) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(candidate);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (!TEXT_EXTENSIONS.has(path.extname(candidate).toLowerCase())) continue;
    out.push(candidate);
  }
  return out;
}

/** Every path-like string in a payload (top level, plus `files`/`assets` lists). */
function readPaths(data: unknown): string[] {
  if (typeof data !== "object" || data === null) return [];
  const record = data as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ["path", "dir", "directory", "root", "outDir", "projectDir", "file", "url"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) out.push(value.trim());
  }
  for (const key of ["files", "assets", "outputs", "paths"]) {
    const value = record[key];
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string" && entry.trim()) out.push(entry.trim());
      }
    }
  }
  return out;
}

/** Versions of every document node of a run, keyed by node id. */
export function listVersionsForRun(runId: string): Record<string, Array<Omit<NodeVersion, "seq">>> {
  return getVersionStore().listForRun(runId);
}

/** Every stored version of a run, flattened and ordered (for export/debug). */
export function listRunVersionRows(runId: string): Array<Omit<NodeVersion, "seq">> {
  return Object.values(getVersionStore().listForRun(runId)).flat().sort((a, b) => a.version - b.version);
}

/** Reset hook: a swapped database drops the in-memory version store. */
export function resetNodeVersionsForTests(): void {
  resetNodeVersions();
}
