/**
 * Neo N11: canvas editing semantics.
 *
 * N1 builds the run graph from agent events and N2 renders it. This module is the
 * other half: what the user does *to* the graph, and what the agent must then
 * know. Every operation follows the same shape, because the canvas can only ever
 * express one of them:
 *
 *   1. The graph is updated (a version is appended, an edge is re-pointed, a
 *      branch or a merged group is created). The update is durable and visible
 *      on the canvas immediately.
 *   2. A directive is filed for the run, so the *next* step's model input
 *      contains the edit. The agent is never interrupted; an edit is a fact it
 *      reads at the next step boundary.
 *
 * The distinction matters. An edit made while the run is idle must still reach
 * the model, and an edit made while the run is mid-step must not be lost: the
 * directive log is persisted with the graph, so both cases are the same write.
 *
 * Everything here is throwaway-safe at the edges (`src/agent/opsAdapter.ts` logs
 * and swallows), because an editing failure must never break the task.
 */
import { recallText } from "./recall.js";
import type { RunNode } from "./store.js";
import { excerpt, nodeLocation, nodeText, withEditedText } from "./nodeText.js";
import {
  addDirective,
  type CanvasDirectiveMode,
  type CanvasDirectiveReason,
} from "./directives.js";

/**
 * The slice of the live run graph (`src/graph/runGraph.ts`) these operations
 * need. Declared here rather than imported so this module has no cycle with the
 * graph it edits, and so a test can drive the ops with a real `RunGraph`.
 */
export interface CanvasGraph {
  getNode(nodeId: string, runId?: string): RunNode | undefined;
  getRunNodes(runId: string): RunNode[];
  setData(nodeId: string, data: unknown, runId?: string): RunNode;
  setParents(nodeId: string, parentIds: string[], runId?: string): RunNode;
  createBranch(runId: string, fanoutId: string, index: number, label?: string, parentNodeId?: string): RunNode;
  createMerge(
    runId: string,
    fanoutId: string,
    branchNodeIds: string[],
    summary: string,
    parentNodeId?: string,
  ): RunNode;
}

/** The outcome of one canvas operation. */
export interface CanvasOpResult {
  /** What the user did, so the route and the tests can name it. */
  op: CanvasOpName;
  /** The node the operation acted on (the edited node, the branch root, ...). */
  nodeId: string;
  /** Every node the operation created or rewrote. */
  touched: string[];
  /** Nodes that stopped being current (superseded by the edit or the cut). */
  stale: string[];
  /** The directive filed for the next step, when the op has something to say. */
  directive?: string;
}

export type CanvasOpName = "edit" | "cut" | "reconnect" | "duplicate" | "group" | "quote" | "follow-up";

/** The two ways a node's content can be handed to the model. */
export type CanvasEditMode = CanvasDirectiveMode;

/** One entry of a node's edit history, newest last. */
export interface NodeEditRecord {
  /** The text before this edit. */
  previous: string;
  /** The text after this edit (what the model must see). */
  text: string;
  /** When the edit happened. */
  at: number;
}

/** The run-scoped context the ops need, resolved once per operation. */
export interface CanvasOpContext {
  /** The live run graph (owned by the N1 adapter). */
  graph: CanvasGraph;
  /** Run id the operation belongs to. */
  runId: string;
}

/** A canvas operation as the client sends it. */
export type CanvasOpRequest =
  | { op: "edit"; nodeId: string; text: string; mode?: CanvasEditMode }
  | { op: "cut" | "reconnect"; nodeId: string; parentIds: string[]; mode?: CanvasEditMode }
  | { op: "duplicate"; nodeId: string; label?: string }
  | { op: "group"; nodeIds: string[]; title?: string }
  | { op: "quote" | "follow-up"; nodeId: string; note?: string };

/**
 * Validate a client payload into a canvas operation.
 *
 * Returns `undefined` rather than throwing: the route turns that into a 400, and
 * a malformed edit must never reach the graph. Text is capped here as well as by
 * the body guard, so a client cannot smuggle a file-sized payload into a node.
 */
export function parseCanvasOpRequest(value: unknown): CanvasOpRequest | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const op = raw.op;
  const nodeId = typeof raw.nodeId === "string" && raw.nodeId.trim() ? raw.nodeId.trim() : undefined;
  const mode = raw.mode === "quote" || raw.mode === "follow-up" ? raw.mode : undefined;
  switch (op) {
    case "edit": {
      if (!nodeId) return undefined;
      if (typeof raw.text !== "string" || !raw.text.trim()) return undefined;
      if (raw.text.length > MAX_OP_TEXT_CHARS) return undefined;
      return { op: "edit", nodeId, text: raw.text, ...(mode ? { mode } : {}) };
    }
    case "cut":
    case "reconnect": {
      if (!nodeId) return undefined;
      const parentIds = stringList(raw.parentIds);
      if (!parentIds) return undefined;
      return { op, nodeId, parentIds, ...(mode ? { mode } : {}) };
    }
    case "duplicate": {
      if (!nodeId) return undefined;
      const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim().slice(0, MAX_OP_LABEL_CHARS) : undefined;
      return { op: "duplicate", nodeId, ...(label ? { label } : {}) };
    }
    case "group": {
      const nodeIds = stringList(raw.nodeIds);
      if (!nodeIds || nodeIds.length < 2) return undefined;
      const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim().slice(0, MAX_OP_LABEL_CHARS) : undefined;
      return { op: "group", nodeIds, ...(title ? { title } : {}) };
    }
    case "quote":
    case "follow-up": {
      if (!nodeId) return undefined;
      const note = typeof raw.note === "string" && raw.note.trim() ? raw.note.trim().slice(0, MAX_OP_TEXT_CHARS) : undefined;
      return { op, nodeId, ...(note ? { note } : {}) };
    }
    default:
      return undefined;
  }
}

/** A node payload edit is user-authored, so it is capped below a file upload. */
export const MAX_OP_TEXT_CHARS = 64_000;

/** Titles and labels are one line of UI text, never a document. */
export const MAX_OP_LABEL_CHARS = 400;

/** A node-id list, or `undefined` when any entry is not a usable id. */
function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) return undefined;
    out.push(entry.trim());
  }
  return [...new Set(out)];
}

/** Run one parsed operation against a graph. The single dispatch point. */
export function applyCanvasOp(ctx: CanvasOpContext, request: CanvasOpRequest): CanvasOpResult {
  switch (request.op) {
    case "edit":
      return editNode({ graph: ctx.graph, runId: ctx.runId, nodeId: request.nodeId, text: request.text, ...(request.mode ? { mode: request.mode } : {}) });
    case "cut":
    case "reconnect":
      return reconnectNode({
        graph: ctx.graph,
        runId: ctx.runId,
        nodeId: request.nodeId,
        parentIds: request.parentIds,
        ...(request.mode ? { mode: request.mode } : {}),
      });
    case "duplicate":
      return duplicateNode({ graph: ctx.graph, runId: ctx.runId, nodeId: request.nodeId, ...(request.label ? { label: request.label } : {}) });
    case "group":
      return groupNodes({ graph: ctx.graph, runId: ctx.runId, nodeIds: request.nodeIds, ...(request.title ? { title: request.title } : {}) });
    case "quote":
    case "follow-up":
      return setContextMode({
        graph: ctx.graph,
        runId: ctx.runId,
        nodeId: request.nodeId,
        mode: request.op,
        ...(request.note ? { note: request.note } : {}),
      });
  }
}

/* ------------------------------- plumbing ------------------------------- */

/** The payload of a node, as a writable record (never assume a shape). */
function payload(node: RunNode): Record<string, unknown> {
  return typeof node.data === "object" && node.data !== null ? { ...(node.data as Record<string, unknown>) } : {};
}

/** File one directive for the next step, returning its id. */
function fileDirective(
  runId: string,
  node: RunNode,
  text: string,
  mode: CanvasDirectiveMode,
  reason: CanvasDirectiveReason,
  detail?: string,
): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const stored = addDirective(runId, {
    run_id: runId,
    nodeId: node.id,
    title: excerpt(nodeText(node), 200),
    text: trimmed,
    mode,
    reason,
    ...(detail ? { detail: excerpt(detail, 600) } : {}),
    version: node.version,
  });
  return stored.id;
}

/** Index every node by its parents, so a subtree walk is one pass. */
function childIndex(nodes: RunNode[]): Map<string, RunNode[]> {
  const children = new Map<string, RunNode[]>();
  for (const node of nodes) {
    for (const parent of node.parent_ids) {
      const list = children.get(parent) ?? [];
      list.push(node);
      children.set(parent, list);
    }
  }
  return children;
}

/** Add every node under `rootId` (excluding `rootId`) to `out`. */
function subtreeOf(rootId: string, children: Map<string, RunNode[]>, out: Set<string>): void {
  const queue = [...(children.get(rootId) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (out.has(next.id)) continue;
    out.add(next.id);
    for (const child of children.get(next.id) ?? []) queue.push(child);
  }
}

/** A node's ancestors, nearest first. */
function ancestorsOf(node: RunNode, byId: Map<string, RunNode>): RunNode[] {
  const out: RunNode[] = [];
  const seen = new Set<string>([node.id]);
  const queue = node.parent_ids.map((id) => byId.get(id)).filter((parent): parent is RunNode => parent !== undefined);
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next.id)) continue;
    seen.add(next.id);
    out.push(next);
    for (const id of next.parent_ids) {
      const parent = byId.get(id);
      if (parent) queue.push(parent);
    }
  }
  return out;
}

/** Every node that depends on `nodeId`, directly or through other nodes. */
export function descendantsOf(graph: CanvasGraph, runId: string, nodeId: string): RunNode[] {
  const nodes = graph.getRunNodes(runId);
  const ids = new Set<string>();
  subtreeOf(nodeId, childIndex(nodes), ids);
  return nodes.filter((node) => ids.has(node.id));
}

/**
 * Everything a corrected node invalidates.
 *
 * The run graph is not a linear chain: a `recipe_step` owns the tool nodes it
 * produced, and the run's `complete` node is their *sibling* rather than their
 * child. A structural walk alone would therefore find nothing downstream of a
 * tool result, even though the final answer was written from it.
 *
 * So "downstream" is defined by execution order within the same branch: a node is
 * downstream when it descends from the edited node, or when it comes *after* the
 * edited node in the subtree of one of the edited node's ancestors. For a linear
 * chain this reduces to the structural descendants; for the real projection it
 * correctly reaches the later tool calls and the completion node.
 *
 * Over-marking is deliberate. A stale flag means "re-check this before trusting
 * it", and a node that ran after a corrected input may have consumed it. Missing
 * a genuinely affected node would be the worse error.
 */
export function downstreamOf(graph: CanvasGraph, runId: string, nodeId: string): RunNode[] {
  const nodes = graph.getRunNodes(runId);
  const node = nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return [];
  const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]));
  const children = childIndex(nodes);
  const ids = new Set<string>();
  // 1. Structural dependents, whatever their position.
  subtreeOf(nodeId, children, ids);
  // 2. Later work in the same branch, reached through an ancestor's subtree.
  const position = node.position ?? 0;
  for (const scope of [node, ...ancestorsOf(node, byId)]) {
    const within = new Set<string>();
    subtreeOf(scope.id, children, within);
    for (const id of within) {
      const candidate = byId.get(id);
      if (candidate && (candidate.position ?? 0) > position) ids.add(id);
    }
  }
  ids.delete(nodeId);
  return nodes.filter((candidate) => ids.has(candidate.id)).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

/* --------------------------------- edit --------------------------------- */

export interface EditNodeOptions {
  /** The corrected output text. */
  text: string;
  /** How the edit enters the next prompt (default `follow-up`). */
  mode?: CanvasEditMode;
  /** The graph the node belongs to. */
  graph: CanvasGraph;
  runId: string;
  nodeId: string;
}

/**
 * Edit a node's output by hand.
 *
 * The old text is never discarded: it is appended to the node's edit history, so
 * the canvas (and N13's version diff) can show what changed. Everything that
 * depended on the old text is marked stale rather than deleted, because the
 * agent's own history still references it; a stale node says "re-check this",
 * which is exactly what a corrected input means downstream.
 */
export function editNode(options: EditNodeOptions): CanvasOpResult {
  const { graph, runId, nodeId } = options;
  const mode = options.mode ?? "follow-up";
  const node = graph.getNode(nodeId, runId);
  if (!node) throw new Error(`run node not found: ${nodeId}`);

  const before = nodeText(node);
  const previousEdits = readEditHistory(node);
  // One write: the corrected text, the preserved fields, and the edit history
  // that records what changed. A second write would bump the version twice for
  // one edit and make N13's diff read as two revisions.
  const nextData = {
    ...withEditedText(node.data, options.text),
    edits: [...previousEdits, { previous: before, text: options.text.trim(), at: Date.now() }],
  };
  const target = graph.setData(nodeId, nextData, runId) ?? node;

  // Everything downstream of a corrected input is no longer trustworthy. The
  // mark is a payload flag, never a status change: a terminal node is absorbing
  // by design (`src/graph/status.ts`), and "superseded by an edit" is a fact
  // about the node's input, not a new lifecycle state. The canvas renders the
  // flag as stale; a re-run replaces the node through the normal path.
  const stale: string[] = [];
  for (const child of downstreamOf(graph, runId, nodeId)) {
    if (payload(child).stale === true && payload(child).staleAfter === nodeId) continue;
    graph.setData(child.id, { ...payload(child), stale: true, staleAfter: nodeId }, runId);
    stale.push(child.id);
  }

  const detail = stale.length > 0 ? `This edit superseded ${stale.length} downstream node(s); treat them as unverified until re-run.` : undefined;
  const directive = fileDirective(runId, target, options.text, mode, "edited", detail);
  return { op: options.mode === "quote" ? "quote" : "edit", nodeId, touched: [nodeId, ...stale], stale, ...(directive ? { directive } : {}) };
}

/** The edit history of a node, oldest last. */
export function readEditHistory(node: RunNode): NodeEditRecord[] {
  const raw = (node.data as { edits?: unknown } | undefined)?.edits;
  if (!Array.isArray(raw)) return [];
  const out: NodeEditRecord[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.text !== "string") continue;
    out.push({
      previous: typeof record.previous === "string" ? record.previous : "",
      text: record.text,
      at: typeof record.at === "number" ? record.at : 0,
    });
  }
  return out;
}

/* ------------------------------- cut/reconnect -------------------------- */

export interface EdgeOptions {
  graph: CanvasGraph;
  runId: string;
  /** The node whose parents are being changed. */
  nodeId: string;
  /** The full new parent set; an omitted parent is cut, a new one is connected. */
  parentIds: string[];
  mode?: CanvasEditMode;
}

/**
 * Re-point a node's parents (cut one edge, reconnect to another, or both).
 *
 * Context is derived from parents, so this is exactly "change what the next step
 * sees": a cut parent stops contributing, a new parent starts. The directive
 * records the change itself, because the model must not keep quoting a node the
 * user has detached.
 */
export function reconnectNode(options: EdgeOptions): CanvasOpResult {
  const { graph, runId, nodeId, parentIds } = options;
  const mode = options.mode ?? "follow-up";
  const node = graph.getNode(nodeId, runId);
  if (!node) throw new Error(`run node not found: ${nodeId}`);

  const before = new Set(node.parent_ids);
  const requested = [...new Set(parentIds)].filter((id) => id !== nodeId);
  // A parent that does not exist in this run is refused: silently dropping it
  // would leave the canvas showing an edge the graph does not have.
  const known = requested.filter((id) => graph.getNode(id, runId));
  if (known.length !== requested.length) throw new Error("parent node not found in this run");

  const updated = graph.setParents(nodeId, known, runId);
  const after = new Set(updated.parent_ids);
  const removed = [...before].filter((id) => !after.has(id));
  const added = [...after].filter((id) => !before.has(id));

  const detail = [
    removed.length > 0 ? `Cut from: ${removed.map((id) => nodeTitleOf(graph, runId, id)).join(", ")}` : "",
    added.length > 0 ? `Connected to: ${added.map((id) => nodeTitleOf(graph, runId, id)).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(". ");

  const directive = fileDirective(
    runId,
    updated,
    nodeText(updated),
    mode,
    // A move is both a cut and a reconnect; the connect is what the user was
    // trying to do, so that is what the operation is called. The detail names the
    // parent that was dropped too, so nothing is lost.
    added.length > 0 ? "reconnect" : "cut",
    detail || undefined,
  );
  return {
    op: added.length > 0 ? "reconnect" : "cut",
    nodeId,
    touched: [nodeId, ...added],
    // The node itself is unchanged; only which parents feed it. Nothing downstream
    // is superseded, so nothing is marked stale.
    stale: [],
    ...(directive ? { directive } : {}),
  };
}

/** A node's title, for a directive that must read well without a graph scan. */
function nodeTitleOf(graph: CanvasGraph, runId: string, nodeId: string): string {
  const node = graph.getNode(nodeId, runId);
  if (!node) return nodeId;
  const text = nodeText(node);
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/* ------------------------------- duplicate ------------------------------ */

export interface DuplicateOptions {
  graph: CanvasGraph;
  runId: string;
  /** The node to copy. */
  nodeId: string;
  /** The new branch's label; defaults to the node's own text. */
  label?: string;
}

/**
 * Duplicate a node as a branch.
 *
 * Duplicating is not copying a file: it starts an independent line of work from
 * the same content, so the result is a `branch` node carrying the copied payload
 * and a deterministic id. The original keeps its version and its edges, which is
 * what makes the duplicate a *branch* rather than a second copy of the same step.
 */
export function duplicateNode(options: DuplicateOptions): CanvasOpResult {
  const { graph, runId, nodeId } = options;
  const source = graph.getNode(nodeId, runId);
  if (!source) throw new Error(`run node not found: ${nodeId}`);
  const label = options.label?.trim() || nodeText(source);
  const branch = graph.createBranch(runId, `duplicate:${source.id}`, 0, excerpt(label, 200), source.id);
  // The branch inherits the source's payload so it can be continued from, but it
  // is its own node with its own version and its own future edits.
  graph.setData(
    branch.id,
    {
      ...payload(source),
      duplicatedFrom: source.id,
      sourceVersion: source.version,
      label: excerpt(label, 200),
    },
    runId,
  );
  const stored = graph.getNode(branch.id, runId) ?? branch;
  const directive = fileDirective(runId, stored, nodeText(stored), "follow-up", "duplicate", `Branched from "${excerpt(nodeText(source), 120)}". Work this copy independently; do not modify the original.`);
  return { op: "duplicate", nodeId: stored.id, touched: [stored.id], stale: [], ...(directive ? { directive } : {}) };
}

/* --------------------------------- group -------------------------------- */

export interface GroupOptions {
  graph: CanvasGraph;
  runId: string;
  /** The selected nodes, in selection order. */
  nodeIds: string[];
  /** Optional title for the merged node. */
  title?: string;
}

/**
 * Group several nodes into one merged context.
 *
 * A group is a fan-in: the merged node lists every member as a parent, so the
 * next step that consumes it receives all of their content in one bounded block
 * instead of several separate ones. Nothing is deleted; the members stay on the
 * canvas with their own versions.
 */
export function groupNodes(options: GroupOptions): CanvasOpResult {
  const { graph, runId, nodeIds } = options;
  const members = [...new Set(nodeIds)];
  if (members.length < 2) throw new Error("a group needs at least two nodes");
  for (const id of members) {
    if (!graph.getNode(id, runId)) throw new Error(`run node not found: ${id}`);
  }
  const texts = members.map((id) => nodeText(graph.getNode(id, runId)!));
  const title = options.title?.trim() || texts.map((text) => excerpt(text, 80)).join(" + ");
  const summary = texts.map((text, index) => `${index + 1}. ${text}`).join("\n");
  const merged = graph.createMerge(runId, `group:${members.join("+")}`, members, excerpt(summary, 1000), members[0]!);
  graph.setData(
    merged.id,
    {
      ...payload(merged),
      grouped: true,
      groupTitle: excerpt(title, 200),
      groupSize: members.length,
      groupNodeIds: members,
      title: excerpt(title, 200),
    },
    runId,
  );
  const stored = graph.getNode(merged.id, runId) ?? merged;
  const directive = fileDirective(
    runId,
    stored,
    summary,
    "follow-up",
    "group",
    `Grouped ${members.length} nodes into one context: ${members.map((id) => nodeTitleOf(graph, runId, id)).join(", ")}.`,
  );
  return { op: "group", nodeId: stored.id, touched: [stored.id, ...members], stale: [], ...(directive ? { directive } : {}) };
}

/* ---------------------------- follow-up / quote ------------------------- */

export interface ContextModeOptions {
  graph: CanvasGraph;
  runId: string;
  nodeId: string;
  /** `follow-up` (default) asks the agent to continue from the node; `quote` asks it to cite it verbatim. */
  mode: CanvasEditMode;
  /** Optional instruction the user typed alongside the mode. */
  note?: string;
}

/**
 * Attach a mode to a node without changing it.
 *
 * This is the "quote vs follow-up" control on the canvas: the same node can be
 * handed to the model as something to *build on* (follow-up) or as something to
 * *reproduce exactly* (quote), and the difference is only in how the directive
 * is phrased. The graph itself is unchanged, so the node keeps its version.
 */
export function setContextMode(options: ContextModeOptions): CanvasOpResult {
  const { graph, runId, nodeId, mode } = options;
  const node = graph.getNode(nodeId, runId);
  if (!node) throw new Error(`run node not found: ${nodeId}`);
  const text = [options.note?.trim(), nodeText(node)].filter(Boolean).join("\n");
  const directive = fileDirective(
    runId,
    node,
    text,
    mode,
    "mode",
    mode === "quote"
      ? "Quote this node's content exactly in your answer; do not paraphrase it."
      : "Continue from this node's content; treat it as the current state of the work.",
  );
  return {
    op: mode === "quote" ? "quote" : "follow-up",
    nodeId,
    touched: [nodeId],
    stale: [],
    ...(directive ? { directive } : {}),
  };
}

/* ------------------------------ text helpers ---------------------------- */

export { nodeText, nodeLocation, recallText };
