/**
 * Neo N1: the run-graph node store.
 *
 * A "run" is one Loam task (task id == run id). Every node on the graph is a
 * row in the `run_node` entity family, keyed by a deterministic id derived from
 * the event that produced it, so replaying the same event log rebuilds the very
 * same graph instead of duplicating nodes.
 *
 * Storage is the existing `entities` table (see src/server/sqliteStore.ts): one
 * JSON payload per node. Reads are served from an in-process row index, and
 * rebuilding a graph from a JSON export never touches the database at all.
 */
import crypto from "node:crypto";
import { allEntities, onDatabaseReset, putEntity, removeEntity, transaction } from "../server/sqliteStore.js";

/** Every node kind the graph can render. */
export const RUN_NODE_TYPES = [
  "question",
  "recipe_step",
  "search",
  "document",
  "webpage",
  "media",
  "ask_user",
  "complete",
  /** Multi-model A/B arm: one sibling run of the same prompt under one model. */
  "sibling",
  "note",
  "failed",
  "kb_seed",
] as const;
export type RunNodeType = (typeof RUN_NODE_TYPES)[number];

/** Lifecycle of one node. `init` is "created, not started yet". */
export const RUN_NODE_STATUSES = ["init", "running", "finished", "failed", "skipped"] as const;
export type RunNodeStatus = (typeof RUN_NODE_STATUSES)[number];

export function isRunNodeType(value: unknown): value is RunNodeType {
  return typeof value === "string" && (RUN_NODE_TYPES as readonly string[]).includes(value);
}

export function isRunNodeStatus(value: unknown): value is RunNodeStatus {
  return typeof value === "string" && (RUN_NODE_STATUSES as readonly string[]).includes(value);
}

/** One node of a run graph. */
export interface RunNode {
  id: string;
  /** Owning run (Loam task id). */
  run_id: string;
  /** Nodes this node consumes context from. Multiple parents = merged context. */
  parent_ids: string[];
  type: RunNodeType;
  status: RunNodeStatus;
  data?: unknown;
  /** Ordering hint within the run; stable across replay. */
  position?: number;
  /** Bumped on every write so a stale replay cannot overwrite newer state. */
  version: number;
  created: number;
  updated: number;
}

/** A node plus the columns the store indexes. */
export interface RunNodeRow extends RunNode {
  /** Agent event type that produced this node (`plan`, `tool_call`, ...). */
  event_type: string;
  /** Deterministic node id derived from the event, so replay is idempotent. */
  event_id: string;
  /** Wall-clock ordering of the emitting event, for stable replay. */
  seq: number;
}

export const RUN_NODE_ENTITY = "run_node";

/** Hard ceiling per run, so a runaway mission cannot exhaust the database. */
export const MAX_NODES_PER_RUN = 100_000;

export class RunGraphStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunGraphStoreError";
  }
}

/** Deterministic node id for one event. Stable across processes and replays. */
export function eventNodeId(eventType: string, seed: string): string {
  const digest = crypto.createHash("sha256").update(`${eventType}:${seed}`).digest("hex").slice(0, 16);
  return `${eventType}-${digest}`;
}

/** Strip the storage-only columns, leaving the public node shape. */
function nodeFromRow(row: RunNodeRow): RunNode {
  const { event_type: _eventType, event_id: _eventId, seq: _seq, ...node } = row;
  return node;
}

/** Coerce an unknown payload into a valid row; returns undefined when unusable. */
function coerceRow(value: unknown): RunNodeRow | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.run_id !== "string") return undefined;
  if (!isRunNodeType(row.type) || !isRunNodeStatus(row.status)) return undefined;
  const node: RunNode = {
    id: row.id,
    run_id: row.run_id,
    parent_ids: Array.isArray(row.parent_ids) ? row.parent_ids.filter((p): p is string => typeof p === "string") : [],
    type: row.type,
    status: row.status,
    ...(row.data !== undefined ? { data: row.data } : {}),
    ...(typeof row.position === "number" && Number.isFinite(row.position) ? { position: row.position } : {}),
    version: typeof row.version === "number" && Number.isFinite(row.version) ? row.version : 1,
    created: typeof row.created === "number" && Number.isFinite(row.created) ? row.created : 0,
    updated: typeof row.updated === "number" && Number.isFinite(row.updated) ? row.updated : 0,
  };
  return {
    ...node,
    event_type: typeof row.event_type === "string" ? row.event_type : "",
    event_id: typeof row.event_id === "string" ? row.event_id : node.id,
    seq: typeof row.seq === "number" && Number.isFinite(row.seq) ? row.seq : 0,
  };
}

export interface RunNodePatch {
  status?: RunNodeStatus;
  data?: unknown;
  parent_ids?: string[];
  position?: number;
  /** Event sequence; used by `nodesAfter` for live canvas polling. */
  seq?: number;
}

export interface RunNodeQuery {
  runId: string;
  type?: RunNodeType;
  status?: RunNodeStatus;
  /** Only nodes whose event sequence is greater than this (exclusive). */
  afterSeq?: number;
}

/** Append/update/delete access to the persisted run graph. */
export class RunGraphStore {
  /** Every row by id. A replay burst is not tens of thousands of point reads. */
  private readonly rows = new Map<string, RunNodeRow>();
  private loaded = false;

  constructor() {
    // A test that swaps the database file must also drop this cache.
    onDatabaseReset(() => this.reset());
  }

  /** Load the table once; writes then update this map so reads never hit disk. */
  private ensureLoaded(): void {
    if (this.loaded) return;
    for (const row of allEntities<RunNodeRow>(RUN_NODE_ENTITY)) this.rows.set(row.id, row);
    this.loaded = true;
  }

  /** Write one row to SQLite plus the in-process index. */
  private write(row: RunNodeRow): void {
    putEntity(RUN_NODE_ENTITY, row);
    this.rows.set(row.id, row);
  }

  /** Forget the cached rows; called when the database connection is reset. */
  reset(): void {
    this.rows.clear();
    this.loaded = false;
  }

  private runRows(runId: string): RunNodeRow[] {
    this.ensureLoaded();
    const out: RunNodeRow[] = [];
    for (const row of this.rows.values()) if (row.run_id === runId) out.push(row);
    return out;
  }

  /** Write one node, bumping its version and stamping `updated`.
   *  `seq` is the event order; it is preserved across later writes. */
  upsert(node: RunNode, seq?: number): RunNode {
    const existing = this.getRow(node.id);
    const next: RunNodeRow = {
      ...node,
      parent_ids: [...node.parent_ids],
      version: existing ? existing.version + 1 : node.version,
      created: existing ? existing.created : node.created,
      updated: Date.now(),
      event_type: existing?.event_type ?? "",
      event_id: existing?.event_id ?? node.id,
      seq: seq ?? existing?.seq ?? 0,
    };
    this.write(next);
    return nodeFromRow(next);
  }

  /**
   * Write several nodes, bumping versions and preserving their sequences. Used
   * by `replaceRun`, where a whole run is swapped in one pass.
   */
  upsertMany(nodes: RunNode[]): void {
    const next: RunNodeRow[] = nodes.map((node) => {
      const existing = this.getRow(node.id);
      return {
        ...node,
        parent_ids: [...node.parent_ids],
        version: existing ? existing.version + 1 : node.version,
        created: existing ? existing.created : node.created,
        updated: Date.now(),
        event_type: existing?.event_type ?? "",
        event_id: existing?.event_id ?? node.id,
        seq: existing?.seq ?? node.position ?? 0,
      };
    });
    transaction(() => {
      for (const row of next) {
        putEntity(RUN_NODE_ENTITY, row);
        this.rows.set(row.id, row);
      }
    });
  }

  /** Insert only when absent; returns false when the node already exists. */
  insertIfAbsent(node: RunNode): boolean {
    if (this.getRow(node.id)) return false;
    this.upsert(node);
    return true;
  }

  /** Status/data/parents update guarded by the current version. */
  update(id: string, patch: RunNodePatch, expectedVersion?: number): RunNode | undefined {
    const existing = this.getRow(id);
    if (!existing) return undefined;
    if (expectedVersion !== undefined && existing.version !== expectedVersion) return undefined;
    const next: RunNodeRow = {
      ...existing,
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.data !== undefined ? { data: patch.data } : {}),
      ...(patch.parent_ids ? { parent_ids: [...patch.parent_ids] } : {}),
      ...(patch.position !== undefined ? { position: patch.position } : {}),
      ...(patch.seq !== undefined ? { seq: patch.seq } : {}),
      version: existing.version + 1,
      updated: Date.now(),
    };
    this.write(next);
    return nodeFromRow(next);
  }

  getNode(id: string, runId?: string): RunNode | undefined {
    const row = this.getRow(id);
    if (!row) return undefined;
    if (runId && row.run_id !== runId) return undefined;
    return nodeFromRow(row);
  }

  getRow(id: string): RunNodeRow | undefined {
    this.ensureLoaded();
    return this.rows.get(id);
  }

  /** Nodes of one run, ordered by event order then position then id. */
  list(query: RunNodeQuery): RunNode[] {
    return this.listRows(query).map(nodeFromRow);
  }

  listRows(query: RunNodeQuery): RunNodeRow[] {
    const rows = this.runRows(query.runId)
      .filter((row) => (query.type ? row.type === query.type : true))
      .filter((row) => (query.status ? row.status === query.status : true))
      .filter((row) => (query.afterSeq !== undefined ? row.seq > query.afterSeq : true));
    return sortRows(rows);
  }

  /** Children of one node, in graph order. */
  children(parentId: string, runId: string): RunNode[] {
    return this.list({ runId }).filter((node) => node.parent_ids.includes(parentId));
  }

  /** Delete one node; returns false when it does not exist. */
  remove(id: string): boolean {
    const removed = removeEntity(RUN_NODE_ENTITY, id);
    if (removed) this.rows.delete(id);
    return removed;
  }

  /** Delete several nodes in one journal commit. */
  removeMany(ids: string[]): void {
    if (ids.length === 0) return;
    transaction(() => {
      for (const id of ids) {
        removeEntity(RUN_NODE_ENTITY, id);
        this.rows.delete(id);
      }
    });
  }

  /** Replace a whole run's nodes in one pass (used by import/replay replace). */
  replaceRun(runId: string, nodes: RunNode[]): void {
    const keep = new Set(nodes.map((node) => node.id));
    const stale: string[] = [];
    for (const row of this.listRows({ runId })) {
      if (!keep.has(row.id)) stale.push(row.id);
    }
    this.removeMany(stale);
    this.upsertMany(nodes);
  }

  /** Total stored nodes for a run. */
  count(runId: string): number {
    return this.listRows({ runId }).length;
  }

  /** Self-contained JSON projection: nodes plus their replay metadata. */
  exportRun(runId: string): RunGraphExport {
    const rows = this.listRows({ runId });
    return {
      run_id: runId,
      format: 1,
      nodes: rows.map((row) => ({ ...nodeFromRow(row), event_type: row.event_type, event_id: row.event_id, seq: row.seq })),
    };
  }

  /** Replace a run from a JSON projection. Returns the number of nodes written. */
  importRun(data: unknown): number {
    const parsed = parseExport(data);
    const runId = parsed.run_id;
    const seen = new Set<string>();
    transaction(() => {
      for (const raw of parsed.nodes) {
        const row = coerceRow(raw);
        if (!row || row.run_id !== runId) continue;
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        this.upsert({ ...nodeFromRow(row), version: row.version }, row.seq);
      }
    });
    return this.count(runId);
  }

  /** Drop every node of a run. */
  clearRun(runId: string): void {
    const ids: string[] = [];
    for (const row of this.listRows({ runId })) ids.push(row.id);
    this.removeMany(ids);
  }
}

export interface RunGraphExport {
  run_id: string;
  format: number;
  nodes: Array<RunNode & { event_type: string; event_id: string; seq: number }>;
}

/** Validate an unknown JSON export; returns undefined when it cannot be used. */
export function parseExport(data: unknown): RunGraphExport {
  if (typeof data !== "object" || data === null) throw new RunGraphStoreError("run graph export must be an object");
  const obj = data as Record<string, unknown>;
  if (typeof obj.run_id !== "string" || obj.run_id.length === 0) throw new RunGraphStoreError("run graph export has no run_id");
  if (!Array.isArray(obj.nodes)) throw new RunGraphStoreError("run graph export has no nodes array");
  for (const raw of obj.nodes) {
    const row = coerceRow(raw);
    if (!row) throw new RunGraphStoreError("run graph export contains an invalid node");
  }
  return { run_id: obj.run_id, format: typeof obj.format === "number" ? obj.format : 1, nodes: obj.nodes as RunGraphExport["nodes"] };
}

/**
 * Deterministic node id for one A/B sibling arm.
 *
 * A sibling is not derived from an agent event, so it needs its own seed: the
 * same arm index and model always produce the same id, which keeps a re-rendered
 * canvas stable instead of duplicating nodes.
 */
export function siblingNodeId(runId: string, arm: number, model: string): string {
  return eventNodeId("sibling", `${runId}:${arm}:${model}`);
}

/** Stable graph order: event order first, then position, then id. */
export function sortRows<T extends { seq: number; position?: number; id: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.seq !== b.seq) return a.seq - b.seq;
    const pa = a.position ?? Number.MAX_SAFE_INTEGER;
    const pb = b.position ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Node ordering used by layout and stats (position first, then id). */
export function compareNodes(a: RunNode, b: RunNode): number {
  const pa = a.position ?? Number.MAX_SAFE_INTEGER;
  const pb = b.position ?? Number.MAX_SAFE_INTEGER;
  if (pa !== pb) return pa - pb;
  if (a.created !== b.created) return a.created - b.created;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
