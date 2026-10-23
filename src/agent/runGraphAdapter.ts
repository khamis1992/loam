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
 * Forget the process-wide graph. A test that swaps the data directory must also
 * drop the in-memory `runs` cursors, or the next `applyRunEvent` resumes a stale
 * cursor and writes into the old database file.
 */
export function resetRunGraph(): void {
  graph = undefined;
  listeners.clear();
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
    return instance.beginRun(runId, goal);
  } catch (err) {
    console.warn(`[runGraph] failed to begin run ${runId}: ${String(err)}`);
    return undefined;
  }
}

/** Feed one agent event into the run graph. Returns the ids of the nodes it touched. */
export function applyRunEvent(runId: string, event: AgentEvent): string[] {
  try {
    const ids = liveGraph().applyEvent(runId, event);
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
  return liveGraph().replay(runId, events);
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

/** Drop every node of a run (used when a task is deleted). */
export function clearRun(runId: string): void {
  liveGraph().getStore().clearRun(runId);
}
