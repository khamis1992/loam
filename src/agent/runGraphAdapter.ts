/**
 * Neo N1: the seam between the live agent and the run graph.
 *
 * `src/index.ts` calls `beginRun()` once per task and then feeds every emitted
 * `AgentEvent` through `applyRunEvent()` from its `wrappedEmit`. This module is a
 * thin, throwaway-safe wrapper: a failure to record a node must never break the
 * task, so recording errors are logged and swallowed, never thrown.
 *
 * Nothing here decides what a node looks like; `RunGraph` owns the event -> node
 * mapping and `RunGraphStore` owns persistence.
 */
import type { AgentEvent } from "./events.js";
import { RunGraph, type RunGraphLayout, type RunGraphStats } from "../graph/runGraph.js";
import type { RunGraphExport, RunNode, RunNodeStatus, RunNodeType } from "../graph/store.js";
import type { NodeIndex } from "../graph/nodeVersions.js";
import { setNodeIndex } from "../graph/nodeVersions.js";
import { recallIndex, resetRecallIndex } from "../graph/recall.js";
import { applyCanvasOp, parseCanvasOpRequest, type CanvasOpResult, type CanvasOpRequest } from "../graph/ops.js";
import { clearDirectives, consumeDirectives, readDirectives, type CanvasDirective } from "../graph/directives.js";

/** One graph change the live canvas cares about. */
export interface RunGraphChange {
  runId: string;
  /** Node ids created or updated by this change. */
  nodeIds: string[];
  /** Highest event sequence the run has reached so far. */
  seq: number;
}

type RunGraphListener = (change: RunGraphChange) => void;

/**
 * Neo N2: the live graph bus.
 *
 * The canvas needs to know when a node appears while the run is in flight. This
 * is a plain in-process pub/sub (Loam is a local, single-process app, so there is
 * no broker to wire up); the SSE route in `routes/graph.ts` subscribes to it.
 */
const listeners = new Map<string, Set<RunGraphListener>>();

function publish(runId: string, nodeIds: string[]): void {
  const subscribers = listeners.get(runId);
  if (!subscribers || subscribers.size === 0) return;
  const seq = liveGraph()
    .getRunNodes(runId)
    .reduce((max, node) => Math.max(max, node.position ?? 0), 0);
  const change: RunGraphChange = { runId, nodeIds, seq };
  for (const listener of subscribers) {
    try {
      listener(change);
    } catch (err) {
      console.warn(`[runGraph] subscriber failed for run ${runId}: ${String(err)}`);
    }
  }
}

/** Subscribe to graph changes of one run. Returns an unsubscribe function. */
export function subscribeRunGraph(runId: string, listener: RunGraphListener): () => void {
  let subscribers = listeners.get(runId);
  if (!subscribers) {
    subscribers = new Set();
    listeners.set(runId, subscribers);
  }
  subscribers.add(listener);
  return () => {
    const current = listeners.get(runId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(runId);
  };
}

/** The process-wide live graph. One instance serves every task in this process. */
let graph: RunGraph | undefined;

/**
 * N13: the row index the live graph writes through.
 *
 * Version capture (`src/graph/nodeVersions.ts`) reads run nodes to snapshot their
 * text. It must read the *same* store instance, not a second `RunGraphStore`:
 * a store snapshots its rows on first read, so a separate instance created
 * before the run existed would never see the nodes this graph writes, and every
 * capture would miss. Handing the graph's own store over keeps the two in step.
 */
export function liveNodeIndex(): NodeIndex | undefined {
  const store = liveGraph().getStore();
  return {
    getRow: (id) => store.getRow(id),
    listRows: (query) => store.listRows(query),
  };
}

/**
 * Forget the process-wide graph. A test that swaps the data directory must also
 * drop the in-memory `runs` cursors, or the next `applyRunEvent` resumes a stale
 * cursor and writes into the old database file.
 */
export function resetRunGraph(): void {
  graph = undefined;
  listeners.clear();
  resetRecallIndex();
}

function liveGraph(): RunGraph {
  if (!graph) graph = new RunGraph();
  return graph;
}

/**
 * Attach the run graph to a task. Safe to call more than once for the same run:
 * an existing graph is resumed from the store instead of starting over.
 */
export function beginRun(runId: string, goal = ""): RunNode | undefined {
  try {
    const instance = liveGraph();
    instance.resume(runId);
    // Neo N16: keep a cross-run shelf of this graph's finished nodes. Attaching
    // is idempotent per instance and never throws, so a recall failure cannot
    // take down the run it is recording.
    if (!instance.recallAttached) instance.attachRecall(recallIndex());
    return instance.beginRun(runId, goal);
  } catch (err) {
    console.warn(`[runGraph] failed to begin run ${runId}: ${String(err)}`);
    return undefined;
  }
}

/** Feed one agent event into the run graph. Returns the ids of the nodes it touched. */
export function applyRunEvent(runId: string, event: AgentEvent): string[] {
  try {
    const instance = liveGraph();
    // The row index must be the graph's own store, or capture reads a snapshot
    // taken before this run existed and silently snapshots nothing.
    setNodeIndex(liveNodeIndex());
    const ids = instance.applyEvent(runId, event);
    // The canvas listens for this: a node appears on the graph as the agent
    // emits the event that created it, without a polling round-trip.
    if (ids.length > 0) publish(runId, ids);
    return ids;
  } catch (err) {
    console.warn(`[runGraph] failed to apply event ${event.type}: ${String(err)}`);
    return [];
  }
}

/** Rebuild a run from a recorded event log (the "replay" entry point). */
export function replayRun(runId: string, events: AgentEvent[]): string[] {
  const instance = liveGraph();
  setNodeIndex(liveNodeIndex());
  return instance.replay(runId, events);
}

export function getRunGraphLayout(runId: string): RunGraphLayout {
  return liveGraph().getGraphLayout(runId);
}

export function getGraphStats(runId: string): RunGraphStats {
  return liveGraph().getGraphStats(runId);
}

export function exportRunGraph(runId: string): RunGraphExport {
  return liveGraph().exportRun(runId);
}

/** Import a JSON projection. Returns the number of nodes written. */
export function importRunGraph(data: unknown): number {
  return liveGraph().importRun(data);
}

export function getRunNodes(runId: string): RunNode[] {
  return liveGraph().getRunNodes(runId);
}

export function getRunNode(nodeId: string, runId?: string): RunNode | undefined {
  return liveGraph().getNode(nodeId, runId);
}

export function getRunChildren(parentId: string, runId: string): RunNode[] {
  return liveGraph().getChildren(parentId, runId);
}

export function getRunTypeNodes(type: RunNodeType, runId: string): RunNode[] {
  return liveGraph().getTypeNodes(type, runId);
}

/** Move a node's status, rejecting illegal transitions (finished stays finished). */
export function setRunNodeStatus(nodeId: string, status: RunNodeStatus, runId?: string): RunNode {
  const updated = liveGraph().setStatus(nodeId, status, runId);
  publish(updated.run_id, [updated.id]);
  return updated;
}

/** Edit a node's payload in place (canvas "edit by hand"). */
export function setRunNodeData(nodeId: string, data: unknown, runId?: string): RunNode {
  const updated = liveGraph().setData(nodeId, data, runId);
  publish(updated.run_id, [updated.id]);
  return updated;
}

/** Re-point a node's parents (edge cut / reconnect on the canvas). */
export function setRunNodeParents(nodeId: string, parentIds: string[], runId?: string): RunNode {
  const updated = liveGraph().setParents(nodeId, parentIds, runId);
  publish(updated.run_id, [updated.id]);
  return updated;
}

/** Neo N10 multi-model A/B: create one sibling arm per model off a parent node. */
export function addRunSiblings(runId: string, parentNodeId: string, models: string[]): RunNode[] {
  return liveGraph().addSiblings(runId, parentNodeId, models);
}

/** N7 branch fan-out: open one branch of a fan-out as its own canvas subtree. */
export function createFanoutBranch(
  runId: string,
  fanoutId: string,
  index: number,
  label = "",
  parentNodeId?: string,
): RunNode {
  return liveGraph().createBranch(runId, fanoutId, index, label, parentNodeId);
}

/** N7 branch fan-out: the merge node that consumes every branch of a fan-out. */
export function createFanoutMerge(
  runId: string,
  fanoutId: string,
  branchNodeIds: string[],
  summary: string,
  parentNodeId?: string,
): RunNode {
  return liveGraph().createMerge(runId, fanoutId, branchNodeIds, summary, parentNodeId);
}

/** Drop every node of a run (used when a task is deleted). */
export function clearRun(runId: string): void {
  const instance = liveGraph();
  const removed = instance.getRunNodes(runId).map((node) => node.id);
  instance.getStore().clearRun(runId);
  // The shelf is derived, so a deleted run must leave the shelf too.
  const shelf = instance.getRecall();
  if (shelf) for (const nodeId of removed) void shelf.forget(nodeId);
  // Directives describe edits to nodes that no longer exist.
  clearDirectives(runId);
}

/* ------------------------ Neo N11: canvas editing ------------------------ */

/**
 * Run one canvas editing operation (N11) against the live graph.
 *
 * Returns `undefined` for a malformed request so the route can answer 400. An
 * operation that fails to apply throws: the route turns that into a status the
 * panel can show, and nothing is half-written because the ops own their writes.
 * The touched nodes are published to the canvas bus, so the panel re-renders the
 * moment an edit lands rather than on the next poll.
 */
export function applyCanvasRequest(runId: string, payload: unknown): CanvasOpResult | undefined {
  const request = parseCanvasOpRequest(payload);
  if (!request) return undefined;
  return applyCanvasOpRequest(runId, request);
}

/** Apply an already-parsed canvas operation (the loop and tests use this). */
export function applyCanvasOpRequest(runId: string, request: CanvasOpRequest): CanvasOpResult {
  try {
    const result = applyCanvasOp({ graph: liveGraph(), runId }, request);
    publish(runId, result.touched);
    return result;
  } catch (err) {
    console.warn(`[runGraph] canvas op ${request.op} failed for run ${runId}: ${String(err)}`);
    throw err;
  }
}

/** The canvas edits this run has not yet shown the model. */
export function pendingCanvasDirectives(runId: string): CanvasDirective[] {
  return readDirectives(runId);
}

/**
 * Take the pending canvas edits for a run (the loop's once-per-step pull).
 *
 * Read-and-clear in one call, so an edit is handed to the model exactly once and
 * then lives in the run's artefact store like any other context. A storage
 * failure returns an empty list: an unreadable directive log must not stop the
 * run it belongs to.
 */
export function takeCanvasDirectives(runId: string): CanvasDirective[] {
  try {
    return consumeDirectives(runId);
  } catch (err) {
    console.warn(`[runGraph] failed to consume canvas directives for ${runId}: ${String(err)}`);
    return [];
  }
}

/**
 * The live graph handle, for callers that need run-scoped recall behaviour
 * (attaching a recalled hit into the current run). It is the same instance
 * `beginRun` attaches the shelf to, so the shelf and the graph never diverge.
 */
export function recallGraphHandle(): RunGraph {
  return liveGraph();
}
