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

/** The process-wide live graph. One instance serves every task in this process. */
let graph: RunGraph | undefined;

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
    return liveGraph().applyEvent(runId, event);
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
  return liveGraph().setStatus(nodeId, status, runId);
}

/** Edit a node's payload in place (canvas "edit by hand"). */
export function setRunNodeData(nodeId: string, data: unknown, runId?: string): RunNode {
  return liveGraph().setData(nodeId, data, runId);
}

/** Re-point a node's parents (edge cut / reconnect on the canvas). */
export function setRunNodeParents(nodeId: string, parentIds: string[], runId?: string): RunNode {
  return liveGraph().setParents(nodeId, parentIds, runId);
}

/** Drop every node of a run (used when a task is deleted). */
export function clearRun(runId: string): void {
  liveGraph().getStore().clearRun(runId);
}
