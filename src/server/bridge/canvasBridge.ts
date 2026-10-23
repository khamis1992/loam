/**
 * Neo N17: the external-agent canvas bridge core.
 *
 * Loam's canvas is built by the agent inside the app (N1) and rendered by the web
 * client (N2). This module is the third surface: a **local** HTTP/WS API that lets
 * an *external* agent session (OpenCode, Claude Code, Orca, ...) drive the very
 * same canvas. It is our own protocol, informed by the public MIT
 * `canvas-cowork` reference (`conversation` / `flow_node` / `p_id`, status
 * `init -> running -> finished`) but shaped to Loam's existing run graph so an
 * external session and the in-app agent share one graph per Loam task.
 *
 * Everything here is deliberately throwaway-safe: a bridge failure must never take
 * down the app or the Loam canvas, so callers log and swallow.
 *
 * The data model:
 *   canvas = one Loam task (run id == task id)
 *   node   = one `run_node` row authored by the external session
 *   cursor = `bridge_<canvasId>_<agentId>`, the agent's own node
 *            (`parallel` uses `..._parallel<N>` so several agents get separate
 *            cursors on the same canvas)
 *
 * Node statuses follow N1's lifecycle rules, so a canvas node can never go
 * backwards (finished stays finished) and the same rules the in-app agent obeys
 * apply to the bridge.
 */
import { isRunNodeStatus, type RunNode, type RunNodeStatus } from "../../graph/store.js";
import { log } from "../../log.js";
import { createAgent, getAgent, listAgents } from "../agents.js";
import { createTask, getTask, newId } from "../db.js";
import { executionQueue } from "../executionQueue.js";
import { publishRunGraph } from "../../agent/runGraphAdapter.js";
import { publishTaskEvent } from "../streams.js";

/** Kind stamped on every node the bridge authors. */
export const CANVAS_BRIDGE_NODE_TYPE = "canvas_bridge" as const;

const MAX_ID = 120;
const MAX_TITLE = 200;
const MAX_LABEL = 120;
const MAX_AGENT_NAME = 80;
const MAX_PROMPT = 12_000;
const MAX_PARENTS = 64;
const MAX_BATCH = 64;
const MAX_PATCH = 64;

/** The run engine, exposed on globalThis by `src/index.ts` (routes get no deps). */
export interface CanvasBridgeRunTask {
  (opts: {
    prompt: string;
    emit: (event: unknown) => void;
    taskId?: string;
    title?: string;
    model?: string;
    agentId?: string;
    mode?: string;
    effort?: string;
  }): Promise<{ taskId: string; text: string }>;
}

/** One request of a batch submit. */
export interface CanvasBridgeRequest {
  prompt: string;
  /** Stable per-agent cursor id (default: `bridge_<canvasId>_<agentId>`). */
  cursorId?: string;
  /** Parent node ids; defaults to the cursor itself. */
  parentIds?: string[];
  /** Independent arm number, so two parallel agents never share a cursor. */
  parallel?: number;
  title?: string;
  model?: string;
  mode?: string;
  effort?: string;
}

/** A raw request as an external agent may send it (aliases accepted). */
export interface CanvasBridgeRequestInput extends CanvasBridgeRequest {
  agentId?: string;
  agentRef?: string;
  parentNodeId?: string;
  parentId?: string;
  text?: string;
  task?: string;
  message?: string;
}

/** The subset of the run graph the bridge writes through. */
export interface CanvasBridgeGraph {
  addExternalNode(
    runId: string,
    spec: { id: string; parentIds: string[]; type?: "canvas_bridge" | "note"; status?: RunNodeStatus; data?: unknown },
  ): RunNode;
  setStatus(nodeId: string, status: RunNodeStatus, runId?: string): RunNode;
  setData(nodeId: string, data: unknown, runId?: string): RunNode;
  list(runId: string): RunNode[];
  children(parentId: string, runId: string): RunNode[];
  subscribe(runId: string, listener: (change: { runId: string; nodeIds: string[]; seq: number }) => void): () => void;
  invalidate(runId: string): void;
}

export interface CanvasBridgeSubmitOptions {
  /** Called for every node the bridge writes, so the HTTP route can publish. */
  onNode?: (runId: string, node: RunNode) => void;
}

export interface CanvasBridgeSubmitResult {
  canvasId: string;
  cursorId: string;
  taskId: string;
  status: RunNodeStatus;
  nodeId?: string;
  error?: string;
}

export interface CanvasBridgeBatchResult {
  canvasId: string;
  accepted: CanvasBridgeSubmitResult[];
  rejected: Array<{ index: number; reason: string }>;
}

export interface CanvasBridgeIdentity {
  canvasId: string;
  canvasUrl: string;
  agentId?: string;
  agentName?: string;
  /** Cursors the bridge has seen on this canvas. */
  cursors: string[];
  created: boolean;
}

export interface CanvasBridgeStatus {
  canvasId: string;
  status: string;
  title: string;
  agentId?: string;
  running: boolean;
  messages: number;
  nodes: number;
  cursors: string[];
}

/** The prompt handed to the Loam run for one bridge request. */
export function bridgeRunPrompt(prompt: string, agentId?: string): string {
  const who = agentId ? ` (external agent ${agentId})` : "";
  return `[canvas bridge${who}]\n${prompt}`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const out = text(value);
    if (out) return out;
  }
  return "";
}

/** Clamp an id to the node-id budget, dropping characters a renderer might use. */
function cleanId(value: string): string {
  return value.replace(/[^\w.:-]/g, "_").slice(0, MAX_ID);
}

/** `bridge_<canvasId>_<agentId>`; `parallel<N>` gives each agent its own cursor. */
export function bridgeCursorId(canvasId: string, agentId: string, parallel?: number): string {
  const base = `bridge_${cleanId(canvasId)}_${cleanId(agentId)}`;
  const arm = Number.isInteger(parallel) && (parallel as number) > 0 ? `_parallel${parallel}` : "";
  return (base + arm).slice(0, MAX_ID);
}

/** The canvas is the Loam task: an existing task id, or a fresh bridge canvas. */
export function ensureCanvas(canvasId?: string): { canvasId: string; created: boolean } {
  const existing = text(canvasId);
  if (existing) {
    if (getTask(existing)) return { canvasId: existing, created: false };
    throw new Error(`canvas not found: ${existing}`);
  }
  const task = createTask("External agent canvas", "External agent canvas");
  return { canvasId: task.id, created: true };
}

/**
 * Resolve an agent reference (Loam agent id or name) to a Loam agent.
 *
 * `--parallel` means the agent is a fresh peer on the canvas rather than an
 * existing companion, so an unknown reference becomes a new `canvasBridge` agent
 * instead of a 404. That is what gives each parallel agent its own node.
 */
export function resolveBridgeAgent(
  agentRef: string,
  options: { parallel?: number; create?: boolean } = {},
): { agentId?: string; agentName?: string } {
  const ref = text(agentRef);
  if (!ref) return {};
  const known = getAgent(ref) ?? listAgents(true).find((agent) => agent.name.trim().toLowerCase() === ref.toLowerCase());
  if (known) return { agentId: known.id, agentName: known.name };
  if (options.parallel === undefined && options.create !== true) return {};
  const arm = Number.isInteger(options.parallel) && (options.parallel as number) > 0 ? ` ${options.parallel}` : "";
  const agent = createAgent({
    name: `${ref.slice(0, MAX_AGENT_NAME)}${arm}`.trim(),
    description: "External agent session driving the Loam canvas",
    source: "canvasBridge",
  });
  log.info(`canvas bridge: created bridge agent ${agent.name} (${agent.id})`);
  return { agentId: agent.id, agentName: agent.name };
}

function nodePayload(cursorId: string, agentId?: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { source: "bridge", cursorId, ...(agentId ? { agentId } : {}), ...extra };
}

/** The `cursorId` a bridge node carries (it is the node id by design). */
export function nodeCursorId(node: RunNode): string {
  const data = node.data as { cursorId?: unknown } | undefined;
  return typeof data?.cursorId === "string" ? data.cursorId : node.id;
}

/** Parent candidates for a new node: explicit parents, else the cursor itself. */
export function bridgeParents(input: CanvasBridgeRequestInput, cursorId: string): string[] {
  const raw: unknown[] = [];
  if (Array.isArray(input.parentIds)) raw.push(...input.parentIds);
  if (typeof input.parentNodeId === "string") raw.push(input.parentNodeId);
  if (typeof input.parentId === "string") raw.push(input.parentId);
  const ids = [...new Set(raw.filter((id): id is string => typeof id === "string" && id.trim().length > 0))].slice(0, MAX_PARENTS);
  return ids.length > 0 ? ids : [cursorId];
}

/** True when a `nodes`/`tasks` array was supplied instead of a single request. */
export function isBatchPayload(body: Record<string, unknown>): boolean {
  return Array.isArray(body.nodes) || Array.isArray(body.tasks);
}

/** Coerce a raw array entry into one bridge request; `undefined` when unusable. */
export function coerceBridgeRequest(value: unknown): CanvasBridgeRequestInput | undefined {
  if (typeof value === "string") return value.trim() ? { prompt: value } : undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const prompt = firstText(raw.prompt, raw.text, raw.task, raw.message);
  if (!prompt) return undefined;
  return {
    prompt,
    ...(typeof raw.cursorId === "string" ? { cursorId: raw.cursorId } : {}),
    ...(Array.isArray(raw.parentIds) ? { parentIds: raw.parentIds } : {}),
    ...(typeof raw.parentNodeId === "string" ? { parentNodeId: raw.parentNodeId } : {}),
    ...(typeof raw.parentId === "string" ? { parentId: raw.parentId } : {}),
    ...(typeof raw.parallel === "number" && Number.isFinite(raw.parallel) ? { parallel: raw.parallel } : {}),
    ...(typeof raw.title === "string" ? { title: raw.title } : {}),
    ...(typeof raw.model === "string" ? { model: raw.model } : {}),
    ...(typeof raw.mode === "string" ? { mode: raw.mode } : {}),
    ...(typeof raw.effort === "string" ? { effort: raw.effort } : {}),
    ...(typeof raw.agentId === "string" ? { agentId: raw.agentId } : {}),
    ...(typeof raw.agentRef === "string" ? { agentRef: raw.agentRef } : {}),
  };
}

/** Validate one request; throws with a client-safe reason when it is unusable. */
export function assertBridgeRequest(input: CanvasBridgeRequestInput, index?: number): CanvasBridgeRequest {
  const where = index === undefined ? "" : ` at index ${index}`;
  const prompt = firstText(input.prompt, input.text, input.task, input.message);
  if (!prompt) throw new Error(`request${where} needs a prompt`);
  if (prompt.length > MAX_PROMPT) throw new Error(`request${where} prompt is too long`);
  const parallel = input.parallel;
  if (parallel !== undefined && (!Number.isInteger(parallel) || (parallel as number) < 0)) {
    throw new Error(`request${where} parallel must be a non-negative integer`);
  }
  const request: CanvasBridgeRequest = { prompt, parallel: parallel as number | undefined };
  if (typeof input.cursorId === "string" && input.cursorId.trim()) request.cursorId = input.cursorId.trim().slice(0, MAX_ID);
  if (Array.isArray(input.parentIds)) {
    request.parentIds = input.parentIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0).slice(0, MAX_PARENTS);
  }
  if (typeof input.title === "string" && input.title.trim()) request.title = input.title.trim().slice(0, MAX_TITLE);
  if (typeof input.model === "string" && input.model.trim()) request.model = input.model.trim().slice(0, 200);
  if (typeof input.mode === "string" && input.mode.trim()) request.mode = input.mode.trim().slice(0, 80);
  if (typeof input.effort === "string" && input.effort.trim()) request.effort = input.effort.trim().slice(0, 20);
  return request;
}

function emit(canvasId: string, cursorId: string, status: RunNodeStatus, extra: Record<string, unknown> = {}): void {
  // The agent event union has no bridge kind: an external agent's cursor is a
  // canvas concern, not an agent-loop event. Publish the run's own lifecycle
  // event so subscribers (the web canvas) keep a coherent stream, and carry the
  // bridge payload in the node's `data`, which is what the canvas actually reads.
  if (status === "running") {
    publishTaskEvent(canvasId, { type: "task-status", status: "running" });
  } else if (status === "failed") {
    publishTaskEvent(canvasId, { type: "error", message: String(extra.error ?? "bridge request failed") });
  } else {
    publishTaskEvent(canvasId, { type: "done", text: String(extra.text ?? ""), steps: 1, model: "" });
  }
  // Bridge listeners (the WS/SSE bridge surface) get their own change on the
  // graph bus, which is the channel the external agent actually reads.
  publishRunGraph(canvasId, [cursorId]);
}

/** True while the canvas (a Loam task) has a run in flight. */
function canvasBusy(canvasId: string, status: string): boolean {
  return executionQueue.has(canvasId) || status === "queued" || status === "running";
}

/**
 * Submit one external-agent request onto a canvas.
 *
 * The canvas is the Loam task, so a submit is a real Loam run on that task. The
 * bridge node is written first as `running`, so the canvas shows the agent's
 * cursor the moment the request is accepted, then the run executes and the node
 * ends `finished` with the run's text, or `failed` with the reason.
 *
 * `runTask` is injected by the route: the core stays testable without a run engine
 * (a request without an engine is accepted and the cursor node stays `running`).
 */
export function submitCanvasBridgeRequest(
  graph: CanvasBridgeGraph,
  runTask: CanvasBridgeRunTask | undefined,
  body: Record<string, unknown>,
  options: CanvasBridgeSubmitOptions = {},
): CanvasBridgeSubmitResult {
  const canvasId = ensureCanvas(text(body.canvasId)).canvasId;
  const resolved = resolveBridgeAgent(firstText(body.agentId, body.agentRef), { parallel: body.parallel as number | undefined });
  const cursorId = firstText(body.cursorId) || bridgeCursorId(canvasId, resolved.agentId ?? "agent", body.parallel as number | undefined);
  const task = getTask(canvasId);
  if (!task) throw new Error(`canvas not found: ${canvasId}`);
  if (canvasBusy(canvasId, task.status)) throw new Error(`canvas ${canvasId} is already running`);
  const input = assertBridgeRequest(body as unknown as CanvasBridgeRequestInput);
  const parents = bridgeParents(body as unknown as CanvasBridgeRequestInput, cursorId);
  const title = input.title ?? input.prompt.slice(0, MAX_TITLE);
  const payload = nodePayload(cursorId, resolved.agentId, {
    title,
    label: firstText(body.label, resolved.agentName).slice(0, MAX_LABEL),
    prompt: input.prompt,
    status: "running",
  });
  const node = graph.addExternalNode(canvasId, { id: cursorId, parentIds: parents, type: CANVAS_BRIDGE_NODE_TYPE, status: "running", data: payload });
  options.onNode?.(canvasId, node);
  emit(canvasId, cursorId, "running");

  void (async (): Promise<void> => {
    if (!runTask) return;
    try {
      const result = await runTask({
        taskId: canvasId,
        prompt: bridgeRunPrompt(input.prompt, resolved.agentId),
        ...(title ? { title } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        ...(resolved.agentId ? { agentId: resolved.agentId } : {}),
        emit: () => {},
      });
      const text = result.text ?? "";
      graph.setStatus(cursorId, "finished", canvasId);
      graph.setData(cursorId, nodePayload(cursorId, resolved.agentId, { ...payload, text, status: "finished" }), canvasId);
      emit(canvasId, cursorId, "finished");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        graph.setStatus(cursorId, "failed", canvasId);
      } catch {
        // The node may already be terminal; the canvas keeps whatever it has.
      }
      graph.setData(cursorId, nodePayload(cursorId, resolved.agentId, { ...payload, error: message, status: "failed" }), canvasId);
      emit(canvasId, cursorId, "failed", { error: message });
    } finally {
      const current = graph.list(canvasId).find((candidate) => candidate.id === cursorId);
      if (current) options.onNode?.(canvasId, current);
      graph.invalidate(canvasId);
    }
  })();

  return { canvasId, cursorId, taskId: canvasId, status: "running", nodeId: cursorId };
}

/**
 * Batch submit. Every valid request gets its own cursor and its own Loam run, so
 * `--parallel`-style fan-out works in one call. Invalid requests are reported
 * instead of failing the whole batch.
 */
export function submitCanvasBridgeBatch(
  graph: CanvasBridgeGraph,
  runTask: CanvasBridgeRunTask | undefined,
  body: Record<string, unknown>,
  options: CanvasBridgeSubmitOptions = {},
): CanvasBridgeBatchResult {
  const { canvasId } = ensureCanvas(text(body.canvasId));
  const raw = Array.isArray(body.nodes) ? body.nodes : Array.isArray(body.tasks) ? body.tasks : [];
  if (raw.length > MAX_BATCH) throw new Error(`batch accepts at most ${MAX_BATCH} requests`);
  const results: CanvasBridgeSubmitResult[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  raw.forEach((entry, index) => {
    const parsed = coerceBridgeRequest(entry);
    if (!parsed) {
      rejected.push({ index, reason: "request needs a prompt" });
      return;
    }
    // Each arm gets its own cursor, which is what makes a batch a fan-out.
    const request: CanvasBridgeRequestInput = { ...parsed, parallel: index + 1 };
    try {
      results.push(submitCanvasBridgeRequest(graph, runTask, request as unknown as Record<string, unknown>, options));
    } catch (error) {
      rejected.push({ index, reason: error instanceof Error ? error.message : String(error) });
    }
  });
  return { canvasId, accepted: results, rejected };
}

/**
 * Register an external agent on a canvas without running anything.
 *
 * The canvas is created on demand, so opening a canvas with a fresh id is not an
 * error: that is how `loam-canvas submit --follow <id>` starts a new canvas.
 */
export function registerCanvasBridgeIdentity(graph: CanvasBridgeGraph, body: Record<string, unknown>): CanvasBridgeIdentity {
  const { canvasId, created } = ensureCanvas(text(body.canvasId));
  const resolved = resolveBridgeAgent(firstText(body.agentId, body.agentRef), { parallel: body.parallel as number | undefined });
  const cursorId = firstText(body.cursorId) || bridgeCursorId(canvasId, resolved.agentId ?? "agent", body.parallel as number | undefined);
  const known = graph.list(canvasId).map(nodeCursorId);
  return {
    canvasId,
    canvasUrl: `canvas://${canvasId}`,
    ...(resolved.agentId ? { agentId: resolved.agentId } : {}),
    ...(resolved.agentName ? { agentName: resolved.agentName } : {}),
    cursors: [...new Set([cursorId, ...known])],
    created,
  };
}

/** Read the canvas state an external agent needs to continue a session. */
export function getCanvasBridgeStatus(graph: CanvasBridgeGraph, canvasId: string): CanvasBridgeStatus | undefined {
  const task = getTask(canvasId);
  if (!task) return undefined;
  const nodes = graph.list(canvasId);
  return {
    canvasId,
    status: task.status,
    title: task.title,
    ...(task.agentId ? { agentId: task.agentId } : {}),
    running: canvasBusy(canvasId, task.status),
    messages: task.messages?.length ?? 0,
    nodes: nodes.length,
    cursors: [...new Set(nodes.filter((node) => node.type === CANVAS_BRIDGE_NODE_TYPE).map(nodeCursorId))],
  };
}

/** Validate a `nodes` patch list; throws with a client-safe reason when unusable. */
export function coerceBridgeNodePatch(value: unknown): Array<{ id: string; status?: RunNodeStatus; data?: unknown }> {
  if (!Array.isArray(value)) throw new Error("nodes must be an array");
  if (value.length > MAX_PATCH) throw new Error(`at most ${MAX_PATCH} nodes per patch`);
  const out: Array<{ id: string; status?: RunNodeStatus; data?: unknown }> = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) throw new Error("each node needs an object body");
    const raw = entry as Record<string, unknown>;
    const id = text(raw.id);
    if (!id) throw new Error("each node needs an id");
    const patch: { id: string; status?: RunNodeStatus; data?: unknown } = { id };
    if (raw.status !== undefined) {
      if (!isRunNodeStatus(raw.status)) throw new Error(`unknown node status: ${String(raw.status)}`);
      patch.status = raw.status;
    }
    if (raw.data !== undefined) patch.data = raw.data;
    out.push(patch);
  }
  return out;
}

/** A public node shape: the canvas' own fields plus the bridge metadata. */
export function toPublicBridgeNode(node: RunNode): Record<string, unknown> {
  const data = (node.data ?? {}) as Record<string, unknown>;
  return {
    id: node.id,
    run_id: node.run_id,
    parent_ids: node.parent_ids,
    type: node.type,
    status: node.status,
    data: node.data,
    version: node.version,
    created: node.created,
    updated: node.updated,
    cursorId: nodeCursorId(node),
    agentId: typeof data.agentId === "string" ? data.agentId : undefined,
  };
}

/** Children of a node, in graph order (what `submit --follow <id>` reads). */
export function bridgeChildren(graph: CanvasBridgeGraph, canvasId: string, nodeId: string): RunNode[] {
  return graph.children(nodeId, canvasId);
}

/** Fresh id for a bridge-authored node that is not a cursor. */
export function newBridgeNodeId(prefix = "canvas"): string {
  return newId(prefix);
}
