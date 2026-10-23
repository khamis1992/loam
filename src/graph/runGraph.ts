/**
 * Neo N1: turn the agent's existing event stream into a run graph.
 *
 * Nothing here invents new agent events. Every node is derived from an event the
 * agent already emits (plan, plan_step, critique, verify, tool_call, ...), and
 * every node id is a deterministic hash of that event, so replaying a recorded
 * event log rebuilds the same graph byte for byte.
 */
import type { AgentEvent } from "../agent/events.js";
import {
  RUN_NODE_ENTITY,
  RUN_NODE_STATUSES,
  RUN_NODE_TYPES,
  RunGraphStore,
  eventNodeId,
  type RunGraphExport,
  type RunNode,
  type RunNodeStatus,
  type RunNodeType,
} from "./store.js";
import { assertTransition, canTransition } from "./status.js";
import { transaction } from "../server/sqliteStore.js";

/** Tools that produce a search node on the canvas. */
const SEARCH_TOOLS = new Set(["web_search"]);
/** Tools that produce a webpage node on the canvas. */
const WEBPAGE_TOOLS = new Set(["web_fetch", "browser_open", "browser_goto", "browser_snapshot", "browser_act", "browser_pages"]);
/** Tools that produce a document node on the canvas. */
const DOCUMENT_TOOLS = new Set([
  "file_write",
  "file_edit",
  "loam_document",
  "loam_studio",
  "office_export",
  "office_edit",
  "artifact_publish",
  "code_session",
  "web_scaffold",
]);
/** Tools that produce a media node on the canvas. */
const MEDIA_TOOLS = new Set(["loam_creative", "loam_canvas", "gen_image", "gen_video", "video_export", "auto_video"]);

function artifactNodeType(kind: string): RunNodeType {
  if (kind === "page") return "webpage";
  if (kind === "image" || kind === "video") return "media";
  return "document";
}

function toolNodeType(name: string): RunNodeType | undefined {
  if (SEARCH_TOOLS.has(name)) return "search";
  if (WEBPAGE_TOOLS.has(name)) return "webpage";
  if (DOCUMENT_TOOLS.has(name)) return "document";
  if (MEDIA_TOOLS.has(name)) return "media";
  return undefined;
}

function oneLine(text: string, max = 200): string {
  const clean = text.trim().replace(/\s+/g, " ");
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

interface RunState {
  runId: string;
  /** Root "question" node: the user's request. */
  rootId: string;
  /** Node every new node hangs off, unless a more specific parent applies. */
  lastId: string;
  /** Recipe step currently executing (tool nodes attach to it). */
  stepId?: string;
  /** Event sequence counter; also the replay cursor. */
  seq: number;
  /** In-flight tool calls awaiting their result, in emission order. */
  pending: Array<{ name: string; nodeId: string }>;
  /** Plan step id -> the node created for it, so a later event updates it. */
  steps: Map<string, string>;
}

/** Graph projection returned to the canvas and the stats panel. */
export interface RunGraphLayout {
  nodes: Array<RunNode & { x: number; y: number; depth: number }>;
  edges: Array<{ from: string; to: string }>;
  stats: RunGraphStats;
}

export interface RunGraphStats {
  totalNodes: number;
  nodesByType: Record<string, number>;
  nodesByStatus: Record<string, number>;
  depth: number;
  edges: number;
}

export interface RunGraphOptions {
  store?: RunGraphStore;
}

export class RunGraph {
  private readonly store: RunGraphStore;
  private readonly runs = new Map<string, RunState>();

  constructor(options: RunGraphOptions = {}) {
    this.store = options.store ?? new RunGraphStore();
  }

  getStore(): RunGraphStore {
    return this.store;
  }

  /** Prepare a run so events can be applied without a `task` event first.
   *  An existing run is resumed, so its cursor is recovered before appending. */
  beginRun(runId: string, goal = ""): RunNode {
    const state = this.stateFor(runId);
    if (state.rootId) return this.store.getNode(state.rootId, runId)!;
    if (this.resume(runId)) return this.store.getNode(state.rootId, runId)!;
    return this.ensureRoot(runId, goal);
  }

  private stateFor(runId: string): RunState {
    let state = this.runs.get(runId);
    if (!state) {
      state = { runId, rootId: "", lastId: "", seq: 0, pending: [], steps: new Map() };
      this.runs.set(runId, state);
    }
    return state;
  }

  /** Recover the in-memory cursor from persisted nodes (server restart). */
  resume(runId: string): RunNode | undefined {
    const existing = this.store.list({ runId });
    if (existing.length === 0) return undefined;
    const state = this.stateFor(runId);
    const root = existing.find((node) => node.type === "question");
    state.rootId = root?.id ?? existing[0]!.id;
    state.lastId = existing[existing.length - 1]!.id;
    // The next event gets the highest sequence already recorded, so a resumed
    // run keeps appending instead of colliding with earlier ids.
    state.seq = this.store.listRows({ runId }).reduce((max, row) => Math.max(max, row.seq), 0) + 1;
    for (const node of existing) {
      const stepId = (node.data as { stepId?: unknown } | undefined)?.stepId;
      if (typeof stepId === "string" && node.type === "recipe_step") state.steps.set(stepId, node.id);
    }
    const step = [...existing].reverse().find((node) => node.type === "recipe_step");
    state.stepId = step?.id;
    return root ?? existing[0];
  }

  private ensureRoot(runId: string, goal: string): RunNode {
    const state = this.stateFor(runId);
    if (state.rootId) return this.store.getNode(state.rootId, runId)!;
    const id = eventNodeId("run", runId);
    const now = Date.now();
    const root: RunNode = {
      id,
      run_id: runId,
      parent_ids: [],
      type: "question",
      status: "finished",
      data: { title: oneLine(goal || runId, 200), source: "user" },
      position: 0,
      version: 1,
      created: now,
      updated: now,
    };
    this.store.upsert(root);
    state.rootId = root.id;
    state.lastId = root.id;
    state.seq = this.nextSeq(state);
    return root;
  }

  private nextSeq(state: RunState): number {
    return ++state.seq;
  }

  /** Apply one agent event; returns the ids of the nodes it created or updated. */
  applyEvent(runId: string, event: AgentEvent): string[] {
    const state = this.stateFor(runId);
    if (!state.rootId) this.ensureRoot(runId, event.type === "plan" ? event.goal : "");
    // One journal commit per event, so a live run does not fsync per node.
    return transaction(() => this.apply(runId, state, event));
  }

  /** Replay a recorded event log into a run, rebuilding the graph. */
  replay(runId: string, events: AgentEvent[]): string[] {
    this.store.clearRun(runId);
    this.runs.delete(runId);
    const state = this.stateFor(runId);
    const created: string[] = [];
    // One journal commit for the whole log: a 10k-node replay is a single fsync
    // instead of twenty thousand, which is what keeps it under the budget.
    transaction(() => {
      for (const event of events) created.push(...this.apply(runId, state, event));
    });
    return created;
  }

  /** Rebuild a run from a JSON export (share/replay import). */
  importRun(data: unknown): number {
    return this.store.importRun(data);
  }

  exportRun(runId: string): RunGraphExport {
    return this.store.exportRun(runId);
  }

  getRunNodes(runId: string): RunNode[] {
    return this.store.list({ runId });
  }

  getNode(nodeId: string, runId?: string): RunNode | undefined {
    return this.store.getNode(nodeId, runId);
  }

  getChildren(parentId: string, runId: string): RunNode[] {
    return this.store.children(parentId, runId);
  }

  getTypeNodes(type: RunNodeType, runId: string): RunNode[] {
    return this.store.list({ runId, type });
  }

  /** Nodes whose event sequence is after `afterSeq` (live canvas polling). */
  nodesAfter(runId: string, afterSeq: number): RunNode[] {
    return this.store.list({ runId, afterSeq });
  }

  /** Move a node to a new status, rejecting illegal transitions. */
  setStatus(nodeId: string, status: RunNodeStatus, runId?: string): RunNode {
    const node = this.store.getNode(nodeId, runId);
    if (!node) throw new Error(`run node not found: ${nodeId}`);
    if (!canTransition(node.status, status)) {
      throw new Error(`illegal run node transition: ${node.status} -> ${status}`);
    }
    const updated = this.store.update(nodeId, { status });
    if (!updated) throw new Error(`run node disappeared: ${nodeId}`);
    return updated;
  }

  /** Edit a node's payload in place (canvas "edit the AI's memory"). */
  setData(nodeId: string, data: unknown, runId?: string): RunNode {
    const node = this.store.getNode(nodeId, runId);
    if (!node) throw new Error(`run node not found: ${nodeId}`);
    const updated = this.store.update(nodeId, { data });
    if (!updated) throw new Error(`run node disappeared: ${nodeId}`);
    return updated;
  }

  /** Re-point a node's parents (edge cut / reconnect). */
  setParents(nodeId: string, parentIds: string[], runId?: string): RunNode {
    const node = this.store.getNode(nodeId, runId);
    if (!node) throw new Error(`run node not found: ${nodeId}`);
    const unique = [...new Set(parentIds)].filter((id) => id !== nodeId);
    const updated = this.store.update(nodeId, { parent_ids: unique });
    if (!updated) throw new Error(`run node disappeared: ${nodeId}`);
    return updated;
  }

  /** Layered layout plus aggregate stats. Deterministic, no dependencies. */
  getGraphLayout(runId: string): RunGraphLayout {
    const nodes = this.store.list({ runId });
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const depth = this.depthMap(runId);
    const nodesByType = this.graphStats(runId);
    // Group by layer, then place each layer's nodes in event order.
    const perLayer = new Map<number, number>();
    const laid = nodes.map((node) => {
      const layer = depth.get(node.id) ?? 0;
      // Each layer is walked in event order, so a node's index within its layer
      // is just how many siblings were emitted before it. No search.
      const index = perLayer.get(layer) ?? 0;
      perLayer.set(layer, index + 1);
      return { ...node, depth: layer, x: index * 280, y: layer * 200 };
    });
    const edges: Array<{ from: string; to: string }> = [];
    for (const node of nodes) {
      for (const parent of node.parent_ids) {
        if (byId.has(parent)) edges.push({ from: parent, to: node.id });
      }
    }
    return { nodes: laid, edges, stats: nodesByType };
  }

  getGraphStats(runId: string): RunGraphStats {
    return this.graphStats(runId);
  }

  private graphStats(runId: string): RunGraphStats {
    const cached = this.statsCache.get(runId);
    if (cached) return cached;
    const nodes = this.store.list({ runId });
    const nodesByType: Record<string, number> = {};
    const nodesByStatus: Record<string, number> = {};
    for (const type of RUN_NODE_TYPES) nodesByType[type] = 0;
    for (const status of RUN_NODE_STATUSES) nodesByStatus[status] = 0;
    for (const node of nodes) {
      nodesByType[node.type] = (nodesByType[node.type] ?? 0) + 1;
      nodesByStatus[node.status] = (nodesByStatus[node.status] ?? 0) + 1;
    }
    const depth = this.depthMap(runId);
    const stats: RunGraphStats = {
      totalNodes: nodes.length,
      nodesByType,
      nodesByStatus,
      depth: depth.size === 0 ? 0 : Math.max(...depth.values()) + 1,
      edges: nodes.reduce((sum, node) => sum + node.parent_ids.length, 0),
    };
    this.statsCache.set(runId, stats);
    return stats;
  }

  private depthCache = new Map<string, Map<string, number>>();
  private statsCache = new Map<string, RunGraphStats>();

  private depthMap(runId: string): Map<string, number> {
    const cached = this.depthCache.get(runId);
    if (cached) return cached;
    const nodes = this.store.list({ runId });
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const depth = new Map<string, number>();
    const visit = (node: RunNode): number => {
      const known = depth.get(node.id);
      if (known !== undefined) return known;
      const parents = node.parent_ids.filter((id) => byId.has(id));
      const value = parents.length === 0 ? 0 : Math.max(...parents.map((id) => visit(byId.get(id)!))) + 1;
      depth.set(node.id, value);
      return value;
    };
    for (const node of nodes) visit(node);
    this.depthCache.set(runId, depth);
    return depth;
  }

  /** Drop cached projections after a write. */
  invalidate(runId: string): void {
    this.depthCache.delete(runId);
    this.statsCache.delete(runId);
  }

  private apply(runId: string, state: RunState, event: AgentEvent): string[] {
    switch (event.type) {
      case "plan":
        return this.onPlan(runId, state, event.goal, event.steps.map((step) => step.id), event.steps.length);
      case "plan_step":
        return this.onPlanStep(runId, state, event.id, event.title, event.phase);
      case "critique":
        return [this.addNode(runId, state, {
          type: "note",
          seed: "critique:" + event.id,
          status: event.verdict === "fail" ? "failed" : "finished",
          data: { verdict: event.verdict, reason: oneLine(event.reason, 400), parsed: event.parsed ?? false },
          parent: state.stepId ?? state.lastId,
        }).id];
      case "revise":
        return [this.addNode(runId, state, {
          type: "recipe_step",
          seed: `revise:${event.id}:${event.attempt}`,
          status: "running",
          data: { attempt: event.attempt, fixes: event.fixes ?? [] },
          parent: state.lastId,
        }).id];
      case "replan":
        return [this.addNode(runId, state, {
          type: "note",
          seed: `replan:${event.round}`,
          status: "finished",
          data: { round: event.round, reason: oneLine(event.reason, 300) },
          parent: state.lastId,
        }).id];
      case "verify":
        return [this.addNode(runId, state, {
          type: event.verdict === "pass" ? "complete" : "failed",
          seed: `verify:${state.seq}`,
          status: event.verdict === "pass" ? "finished" : "failed",
          data: { verdict: event.verdict, reason: oneLine(event.reason, 400), parsed: event.parsed ?? false },
          parent: state.lastId,
        }).id];
      case "approval_required":
        return [this.addNode(runId, state, {
          type: "ask_user",
          seed: `approval:${event.approvalId}`,
          status: "running",
          data: { approvalId: event.approvalId, tool: event.tool, summary: oneLine(event.summary, 300) },
          parent: state.lastId,
        }).id];
      case "plan_approval_required":
        // D4 suggest_plan: the plan waits for the user's decision, so it is an
        // ask_user node just like the plan-mode approval card.
        return [this.addNode(runId, state, {
          type: "ask_user",
          seed: `plan-approval:${event.planApprovalId}`,
          status: "running",
          data: {
            approvalId: event.planApprovalId,
            tool: event.tool,
            summary: oneLine(event.summary, 300),
            steps: event.steps,
            filesToEdit: event.filesToEdit,
            trivial: event.trivial,
          },
          parent: state.lastId,
        }).id];
      case "ask_user_required":
        // N9 ask_user: the run pauses for the user's clarification, so it is an
        // ask_user node just like the plan-mode approval card. It is a question
        // node (not a note): the run genuinely waits on the answer.
        return [this.addNode(runId, state, {
          type: "ask_user",
          seed: `ask-user:${event.askUserId}`,
          status: "running",
          data: {
            askUserId: event.askUserId,
            tool: event.tool,
            title: oneLine(event.title, 300),
            reason: oneLine(event.reason, 400),
            questions: event.questions,
          },
          parent: state.lastId,
        }).id];
      case "environment_issue":
        // D17 report_environment_issue: a step cannot run because of the local
        // environment. It is a terminal note, not a question: the agent records
        // it and continues (rely on CI / skip the step).
        return [this.addNode(runId, state, {
          type: "note",
          seed: `environment-issue:${state.seq}`,
          status: "finished",
          data: { message: oneLine(event.message, 400), ...(event.details ? { details: oneLine(event.details, 800) } : {}) },
          parent: state.lastId,
        }).id];
      case "compaction":
        return [this.addNode(runId, state, {
          type: "note",
          seed: `compaction:${state.seq}`,
          status: "finished",
          data: {
            step: event.step,
            originalTokens: event.originalTokens,
            afterPruneTokens: event.afterPruneTokens,
            finalTokens: event.finalTokens,
            ...(event.summaryChars !== undefined ? { summaryChars: event.summaryChars } : {}),
            ...(event.fallback !== undefined ? { fallback: event.fallback } : {}),
          },
          parent: state.lastId,
        }).id];
      case "artifact_published":
        return [this.onArtifact(runId, state, event.path, event.kind, event.title, event.mime, event.sizeBytes, event.sha256)];
      case "tool_call":
        return this.onToolCall(runId, state, event.name, event.args);
      case "tool_result":
        return this.onToolResult(runId, state, event.name, event.ok, event.summary);
      case "error":
        return [this.addNode(runId, state, {
          type: "failed",
          seed: `error:${state.seq}`,
          status: "failed",
          data: { message: oneLine(event.message, 400) },
          parent: state.lastId,
        }).id];
      case "cancelled":
        return [this.addNode(runId, state, {
          type: "note",
          seed: `cancelled:${state.seq}`,
          status: "finished",
          data: { stopped: true },
          parent: state.lastId,
        }).id];
      case "done":
        return [this.addNode(runId, state, {
          type: "complete",
          seed: `done:${state.seq}`,
          status: "finished",
          data: { text: oneLine(event.text, 1000), steps: event.steps, model: event.model },
          parent: state.lastId,
        }).id];
      case "mode":
        return [this.addNode(runId, state, {
          type: "note",
          seed: `mode:${event.mode}`,
          status: "finished",
          data: { mode: event.mode, label: event.label, labelAr: event.labelAr, reason: event.reason ?? "" },
          parent: state.lastId,
        }).id];
      case "todo":
      case "phase":
      case "task":
      case "task-status":
      case "step":
      case "workmode":
      case "assistant_token":
      case "assistant_message":
      case "verification_progress":
      case "permission_mode_changed":
      case "cache_usage":
      case "video_studio_command":
        // Live-only signals with no canvas node of their own.
        return [];
      default: {
        const _exhaustive: never = event;
        return _exhaustive;
      }
    }
  }

  private onPlan(runId: string, state: RunState, goal: string, stepIds: string[], total: number): string[] {
    this.ensureRoot(runId, goal);
    // The root may have been created by an earlier event that did not know the
    // goal; fill in the request text now that the plan carries it.
    const root = this.store.getNode(state.rootId, runId);
    if (root && !(root.data as { title?: unknown } | undefined)?.title) {
      this.store.update(root.id, { data: { ...(root.data as Record<string, unknown>), title: oneLine(goal || runId, 200) } });
    }
    const ids: string[] = [];
    for (const stepId of stepIds) {
      const node = this.addNode(runId, state, {
        type: "recipe_step",
        seed: "plan:" + stepId,
        status: "init",
        data: { stepId, total },
        parent: state.rootId,
      });
      state.steps.set(stepId, node.id);
      ids.push(node.id);
    }
    return ids;
  }

  private onPlanStep(runId: string, state: RunState, stepId: string, title: string, phase: "start" | "done"): string[] {
    const known = state.steps.get(stepId);
    const existing = known ? this.store.getNode(known, runId) : undefined;
    if (!existing) {
      const created = this.addNode(runId, state, {
        type: "recipe_step",
        seed: "plan:" + stepId,
        status: phase === "start" ? "running" : "finished",
        data: { stepId, title: oneLine(title, 200) },
        parent: state.rootId,
      });
      state.steps.set(stepId, created.id);
      if (phase === "start") state.stepId = created.id;
      return [created.id];
    }
    const nextStatus: RunNodeStatus = phase === "start" ? "running" : "finished";
    if (canTransition(existing.status, nextStatus)) this.store.update(existing.id, { status: nextStatus });
    if (phase === "start") state.stepId = existing.id;
    else if (state.stepId === existing.id) state.stepId = undefined;
    state.lastId = existing.id;
    return [existing.id];
  }

  private onToolCall(runId: string, state: RunState, name: string, args: unknown): string[] {
    const type = toolNodeType(name);
    if (!type) return [];
    const a = (args ?? {}) as Record<string, unknown>;
    const node = this.addNode(runId, state, {
      type,
      seed: `tool:${name}:${state.seq}`,
      status: "running",
      data: toolCallData(name, a),
      parent: state.stepId ?? state.lastId,
    });
    state.pending.push({ name, nodeId: node.id });
    return [node.id];
  }

  private onToolResult(runId: string, state: RunState, name: string, ok: boolean, summary: string): string[] {
    const index = state.pending.findIndex((entry) => entry.name === name);
    if (index === -1) return [];
    const [entry] = state.pending.splice(index, 1);
    if (!entry) return [];
    const node = this.store.getNode(entry.nodeId, runId);
    if (!node) return [];
    const status: RunNodeStatus = ok ? "finished" : "failed";
    if (canTransition(node.status, status)) {
      this.store.update(node.id, { status, data: { ...(node.data as Record<string, unknown>), summary: oneLine(summary, 600), ok } });
    }
    state.lastId = node.id;
    return [node.id];
  }

  private onArtifact(
    runId: string,
    state: RunState,
    path: string,
    kind: string,
    title: string,
    mime: string,
    sizeBytes: number,
    sha256: string,
  ): string {
    const type = artifactNodeType(kind);
    const data = { path, kind, title: oneLine(title, 200), mime, sizeBytes, sha256 };
    // A published artifact is its own canvas node: it carries the metadata the
    // tool call that produced it did not (title, mime, size, digest).
    const node = this.addNode(runId, state, { type, seed: `artifact:${path}`, status: "finished", data, parent: state.stepId ?? state.lastId });
    return node.id;
  }

  private addNode(
    runId: string,
    state: RunState,
    spec: { type: RunNodeType; seed: string; status: RunNodeStatus; data?: unknown; parent: string },
  ): RunNode {
    // The event seed makes the id deterministic across replays; the occurrence
    // counter keeps two calls to the same tool inside one step from colliding.
    const id = eventNodeId(spec.type, spec.seed + "#" + String(state.seq));
    const position = state.seq;
    const existing = this.store.getRow(id);
    state.seq = this.nextSeq(state);
    const now = Date.now();
    const node: RunNode = {
      id,
      run_id: runId,
      parent_ids: spec.parent ? [spec.parent] : [],
      type: spec.type,
      status: spec.status,
      ...(spec.data !== undefined ? { data: spec.data } : {}),
      position,
      version: 1,
      created: now,
      updated: now,
    };
    if (existing) {
      // Same event replayed: keep the newer status, never regress a finished node.
      const merged = this.mergeStatus(existing.status, spec.status);
      const updated = this.store.update(id, { status: merged, ...(spec.data !== undefined ? { data: spec.data } : {}) });
      state.lastId = id;
      this.invalidate(runId);
      return updated ?? node;
    }
    const stored = this.store.upsert(node, position);
    state.lastId = id;
    this.invalidate(runId);
    return stored;
  }

  /** A replayed event may not move a node backwards (finished stays finished). */
  private mergeStatus(current: RunNodeStatus, incoming: RunNodeStatus): RunNodeStatus {
    if (current === incoming) return current;
    if (current === "finished" || current === "failed") return current;
    if (incoming === "finished" || incoming === "failed") return incoming;
    return incoming;
  }
}

function toolCallData(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = { tool: name };
  if (typeof args.query === "string") data.query = args.query;
  if (typeof args.url === "string") data.url = args.url;
  if (typeof args.path === "string") data.path = args.path;
  if (typeof args.title === "string") data.title = args.title;
  if (typeof args.kind === "string") data.kind = args.kind;
  return data;
}

export { assertTransition, canTransition, RUN_NODE_ENTITY };
