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
  branchNodeId,
  mergeNodeId,
  siblingNodeId,
  type RunGraphExport,
  type RunNode,
  type RunNodeStatus,
  type RunNodeType,
} from "./store.js";
import { assertTransition, canTransition } from "./status.js";
import { transaction } from "../server/sqliteStore.js";
import { RecallIndex, type RecallResolver, type RecallSource } from "./recall.js";
import type { OllamaEmbedder } from "../memory/embeddings.js";

/** The embedder's model name, for the shelf's `model` column. */
function embedderModel(embedder?: OllamaEmbedder | null): string {
  if (!embedder) return "";
  return (embedder as unknown as { model?: string }).model ?? "";
}

/** Tools that produce a search node on the canvas. */
const SEARCH_TOOLS = new Set(["web_search", "kb_search"]);
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
  /** Fan-out id -> the branch count it was opened with (labels the branches). */
  fanouts: Map<string, { total: number }>;
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
  /** Neo N16: the derived cross-run shelf for this graph (optional by design). */
  private recall?: RecallIndex;

  constructor(options: RunGraphOptions = {}) {
    this.store = options.store ?? new RunGraphStore();
  }

  getStore(): RunGraphStore {
    return this.store;
  }

  /** Neo N16: the cross-run shelf this graph indexes into (if attached). */
  getRecall(): RecallIndex | undefined {
    return this.recall;
  }

  /**
   * Neo N16: give this graph a cross-run recall shelf.
   *
   * Attaching is optional so the graph stays usable on its own (and in tests);
   * without it the graph simply does not maintain a shelf.
   */
  attachRecall(index?: RecallIndex, embedder?: OllamaEmbedder | null): void {
    this.recall = index ?? new RecallIndex({ embedder, model: embedderModel(embedder) });
  }

  /** True when a cross-run shelf is attached to this graph. */
  get recallAttached(): boolean {
    return this.recall !== undefined;
  }

  /**
   * Neo N16: file a recalled node into the current run as a linked node.
   *
   * The recalled node is *not* copied: a `note` node is created whose payload names
   * the original node id, run id, type and the query that surfaced it, so the
   * canvas shows a real edge back to the run the asset came from. When the origin
   * still exists, its text/path/url are carried over too, so the current run can
   * reopen the artifact instead of only hearing about it.
   */
  attachRecallNode(runId: string, source: RecallSource, query: string, resolve?: RecallResolver): RunNode | undefined {
    const state = this.stateFor(runId);
    const parent = state.lastId || state.rootId;
    if (!parent) return undefined;
    const origin = resolve?.(source);
    const node = this.addNode(runId, state, {
      type: "note",
      // Deterministic: attaching the same hit twice must not create two nodes.
      seed: `recall:${source.nodeId}:${source.runId}`,
      status: "finished",
      data: {
        recalled: true,
        query: oneLine(query, 200),
        sourceNodeId: source.nodeId,
        sourceRunId: source.runId,
        sourceType: source.type,
        // Provenance: the origin's own text and location when it still exists.
        ...(origin
          ? {
              text: recallTextOf(origin),
              title: dataTitleOf(origin),
              path: dataPathOf(origin),
              url: dataUrlOf(origin),
              mime: dataMimeOf(origin),
            }
          : {}),
      },
      parent,
    });
    return node;
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
      state = { runId, rootId: "", lastId: "", seq: 0, pending: [], steps: new Map(), fanouts: new Map() };
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
    this.scheduleRecallSync(updated.run_id);
    return updated;
  }

  /** Edit a node's payload in place (canvas "edit the AI's memory"). */
  setData(nodeId: string, data: unknown, runId?: string): RunNode {
    const node = this.store.getNode(nodeId, runId);
    if (!node) throw new Error(`run node not found: ${nodeId}`);
    const updated = this.store.update(nodeId, { data });
    if (!updated) throw new Error(`run node disappeared: ${nodeId}`);
    this.scheduleRecallSync(updated.run_id);
    return updated;
  }

  /** Re-point a node's parents (edge cut / reconnect). */
  setParents(nodeId: string, parentIds: string[], runId?: string): RunNode {
    const node = this.store.getNode(nodeId, runId);
    if (!node) throw new Error(`run node not found: ${nodeId}`);
    const unique = [...new Set(parentIds)].filter((id) => id !== nodeId);
    const updated = this.store.update(nodeId, { parent_ids: unique });
    if (!updated) throw new Error(`run node disappeared: ${nodeId}`);
    this.scheduleRecallSync(updated.run_id);
    return updated;
  }

  /**
   * Neo N10 multi-model A/B: the same prompt handed to several models.
   *
   * Every arm becomes a `sibling` node hanging off the same parent and carries
   * the model it was dispatched to, so the canvas renders one branch per model
   * with its model label. Arm ids are deterministic, so re-rendering the same
   * A/B run never duplicates nodes.
   */
  addSiblings(runId: string, parentNodeId: string, models: string[]): RunNode[] {
    const parent = this.store.getNode(parentNodeId, runId);
    if (!parent) throw new Error(`run node not found: ${parentNodeId}`);
    const state = this.stateFor(runId);
    const created: RunNode[] = [];
    transaction(() => {
      models.forEach((model, arm) => {
        const id = siblingNodeId(runId, arm, model);
        const now = Date.now();
        const node: RunNode = {
          id,
          run_id: runId,
          parent_ids: [parent.id],
          type: "sibling",
          status: "init",
          data: { model, arm, label: model },
          position: state.seq,
          version: 1,
          created: now,
          updated: now,
        };
        const stored = this.store.upsert(node, state.seq);
        state.seq = this.nextSeq(state);
        created.push(stored);
      });
    });
    this.invalidate(runId);
    return created;
  }

  /**
   * N7 branch fan-out: open one branch of a fan-out as its own canvas subtree.
   *
   * The branch root hangs off the step that fanned out (or the last node when
   * no step is running) and carries the branch index and label, so the canvas
   * renders N parallel branch roots instead of flattening every child tool call
   * into one column. Node ids are deterministic, so re-rendering the same
   * fan-out never duplicates branch roots.
   */
  createBranch(
    runId: string,
    fanoutId: string,
    index: number,
    label = "",
    parentNodeId?: string,
  ): RunNode {
    const state = this.stateFor(runId);
    if (!state.rootId) this.ensureRoot(runId, "");
    // Branches are opened lazily, one per concurrent worker, so `state.lastId`
    // is whatever the previously-scheduled branch happened to set: without an
    // explicit anchor they chain onto each other instead of fanning out. The
    // fan-out's own parent is captured once, when the first branch is opened,
    // and every later branch reuses it.
    const parent = parentNodeId ?? this.fanoutAnchors.get(`${runId}:${fanoutId}`) ?? state.stepId ?? state.lastId;
    this.fanoutAnchors.set(`${runId}:${fanoutId}`, parent);
    if (!parent) throw new Error(`run node not found: ${parentNodeId ?? ""}`);
    const node = this.addNode(runId, state, {
      type: "branch",
      seed: `fanout:${fanoutId}:${index}`,
      id: branchNodeId(runId, fanoutId, index),
      status: "running",
      data: {
        fanoutId,
        index,
        ...(label ? { label: oneLine(label, 200) } : {}),
        total: state.fanouts.get(fanoutId)?.total,
      },
      parent,
    });
    return node;
  }

  /**
   * N7 branch fan-out: the merge step that consumes every branch of a fan-out.
   *
   * One node with one parent per branch, so the canvas shows the fan-in edge and
   * the node data names every branch node id it merged.
   */
  createMerge(
    runId: string,
    fanoutId: string,
    branchNodeIds: string[],
    summary: string,
    parentNodeId?: string,
  ): RunNode {
    const state = this.stateFor(runId);
    if (!state.rootId) this.ensureRoot(runId, "");
    const parents = [...new Set(branchNodeIds)].filter((id) => this.store.getNode(id, runId));
    const parent = parentNodeId ?? state.lastId;
    const node = this.addNode(runId, state, {
      type: "merge",
      seed: `fanout-merge:${fanoutId}`,
      id: mergeNodeId(runId, fanoutId),
      status: "finished",
      data: {
        fanoutId,
        branchNodeIds: parents,
        summary: oneLine(summary, 1000),
      },
      parent: parents[0] ?? parent,
    });
    // A merge is a fan-in: every branch is a parent, not just the first.
    if (parents.length > 1) {
      this.store.update(node.id, { parent_ids: parents });
      this.invalidate(runId);
    }
    return this.store.getNode(node.id, runId) ?? node;
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
  /**
   * N7 branch fan-out: the parent each fan-out's branch roots hang off.
   *
   * Captured on the first branch a fan-out opens and reused by the rest, so the
   * branches of one fan-out all share a parent even though `runFanout` opens
   * them lazily from concurrent workers.
   */
  private fanoutAnchors = new Map<string, string>();

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
    this.scheduleRecallSync(runId);
  }

  /**
   * Neo N16: queue a shelf refresh after a write.
   *
   * The refresh is coalesced and never throws, because a recall miss must not
   * break the task that produced the node.
   */
  private scheduleRecallSync(runId: string): void {
    const recall = this.recall;
    if (!recall) return;
    recall.scheduleSync(runId, (id) => this.store.list({ runId: id }));
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
        return this.onToolResult(runId, state, event.name, event.ok, event.summary, event.kbSeedIds, event.kbSeeds);
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
      case "recipe_update":
      case "recipe_restart":
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
      // Neo N5: the selector re-shapes the transcript every step, so it is a
      // per-step diagnostic like cache_usage rather than a canvas node (a node
      // per step would bury the run graph's real structure).
      case "context_selected":
      // Neo N11: a canvas edit is already recorded in the graph by the operation
      // that made it (the new version, the re-pointed edge, the branch or the
      // merged node), so the event itself carries no node of its own.
      case "canvas_edit":
      case "workspace_command":
      case "video_studio_command":
      case "video_studio_export":
      case "workspace_open_request":
      case "simulation_progress":
        // Live-only signals with no canvas node of their own.
        return [];
      case "fanout_branch":
        return this.onFanoutBranch(
          runId,
          state,
          event.fanoutId,
          event.index,
          event.phase,
          event.label,
          event.summary,
          event.nodeId,
          event.ok,
        );
      case "fanout_merge":
        return this.onFanoutMerge(runId, state, event.fanoutId, event.branchNodeIds, event.summary);
      default: {
        const _exhaustive: never = event;
        return _exhaustive;
      }
    }
  }

  /**
   * N7 branch fan-out: one branch started (a new `branch` node) or finished
   * (the same node moves to its terminal status). The fan-out total is recorded
   * on the first branch so the canvas can label "branch 2 of 4".
   */
  private onFanoutBranch(
    runId: string,
    state: RunState,
    fanoutId: string,
    index: number,
    phase: "start" | "done",
    label?: string,
    summary?: string,
    nodeId?: string,
    ok?: boolean,
  ): string[] {
    if (phase === "start") {
      // A recorded log may begin with a branch when no earlier event created the
      // root (a live run always has one, because `beginRun` runs first). Creating
      // it here is what gives a replayed branch the same parent as a live one.
      if (!state.rootId) this.ensureRoot(runId, "");
      // Record the fan-out's anchor the first time a replay sees a branch, so the
      // rest of the replayed branches share it instead of chaining off each other.
      const anchorKey = `${runId}:${fanoutId}`;
      if (!this.fanoutAnchors.has(anchorKey)) this.fanoutAnchors.set(anchorKey, state.stepId ?? state.lastId);
      if (!state.fanouts.has(fanoutId)) state.fanouts.set(fanoutId, { total: index + 1 });
      // Branches arrive in flight order, so the label's "of N" grows to the
      // highest index seen rather than freezing at the first branch.
      const known = state.fanouts.get(fanoutId)!;
      if (index + 1 > known.total) known.total = index + 1;
      // Branches already on the canvas were opened before this one was counted,
      // so they still show the old "of N". Bumping them here is what keeps every
      // branch of a fan-out agreeing on the size, live or replayed.
      for (let earlier = 0; earlier < index; earlier += 1) {
        const sibling = this.store.getNode(branchNodeId(runId, fanoutId, earlier), runId);
        if (!sibling || (sibling.data as { total?: number }).total === known.total) continue;
        this.store.update(sibling.id, {
          status: sibling.status,
          data: { ...(sibling.data as Record<string, unknown>), total: known.total },
        });
      }
      const existing = nodeId ? this.store.getNode(nodeId, runId) : undefined;
      if (existing) {
        // A live run already opened this branch through `createBranch`, which could
        // not know the fan-out total yet. Writing it here is what makes the live
        // node identical to the one a replay builds from the same event.
        const data = { ...(existing.data as Record<string, unknown>), fanoutId, index, total: known.total, ...(label ? { label: oneLine(label, 200) } : {}) };
        this.store.update(existing.id, { status: "running", data });
        return [existing.id];
      }
      const created = this.addNode(runId, state, {
        type: "branch",
        seed: `fanout:${fanoutId}:${index}`,
        // Live runs open the branch through `createBranch` and the event carries
        // that id; a replay sees only the event, so it must derive the same id or
        // the branch would not be the node the `done` event and the merge refer to.
        id: nodeId ?? branchNodeId(runId, fanoutId, index),
        status: "running",
        data: {
          fanoutId,
          index,
          ...(label ? { label: oneLine(label, 200) } : {}),
          total: known.total,
        },
        // Same anchor the live path uses, so a replayed fan-out has the same
        // branch roots as the run that produced the log.
        parent: this.fanoutAnchors.get(`${runId}:${fanoutId}`) ?? state.stepId ?? state.lastId,
      });
      return [created.id];
    }

    // `done`: the branch root is terminal. The caller supplies the node id it
    // opened, which keeps the branch subtree on the canvas intact.
    const target = nodeId ? this.store.getNode(nodeId, runId) : undefined;
    if (!target) return [];
    // The caller's explicit flag is authoritative; the prose regex is only a
    // fallback for event logs recorded before the flag existed.
    const branchOk = ok ?? (!summary || !/^failed\b/i.test(summary));
    const nextStatus: RunNodeStatus = branchOk ? "finished" : "failed";
    if (canTransition(target.status, nextStatus)) {
      this.store.update(target.id, {
        status: nextStatus,
        data: { ...(target.data as Record<string, unknown>), ...(summary ? { summary: oneLine(summary, 600) } : {}), ...(!branchOk ? { failReason: oneLine(summary || "branch failed", 600) } : {}) },
      });
    }
    return [target.id];
  }

  /** N7 branch fan-out: the merge node that consumes every branch of a fan-out. */
  private onFanoutMerge(
    runId: string,
    state: RunState,
    fanoutId: string,
    branchNodeIds: string[],
    summary: string,
  ): string[] {
    const node = this.createMerge(runId, fanoutId, branchNodeIds, summary, state.stepId);
    return [node.id];
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

  private onToolResult(
    runId: string,
    state: RunState,
    name: string,
    ok: boolean,
    summary: string,
    kbSeedIds?: string[],
    kbSeeds?: Array<{ id: string; title: string; tags: string[]; preview: string }>,
  ): string[] {
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
    // N3 Knowledge Garden: a `kb_search` result carries the seeds it actually read
    // (`kbSeedIds` + `kbSeeds`). Each becomes a child node hanging off the tool
    // node, so "where did this answer come from?" is a real edge on the run graph
    // rather than prose. Nothing is invented: the ids come from the tool.
    if (!kbSeedIds || kbSeedIds.length === 0) return [node.id];
    const created: string[] = [];
    for (const seedId of kbSeedIds) {
      const meta = kbSeeds?.find((seed) => seed.id === seedId);
      const seedNode = this.addNode(runId, state, {
        type: "kb_seed",
        seed: `kb_seed:${name}:${seedId}:${state.seq}`,
        status: "finished",
        data: {
          seedId,
          tool: name,
          ...(meta ? { title: meta.title, tags: meta.tags, preview: meta.preview } : {}),
        },
        parent: node.id,
      });
      created.push(seedNode.id);
    }
    return [node.id, ...created];
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
    spec: { type: RunNodeType; seed: string; status: RunNodeStatus; data?: unknown; parent: string; id?: string },
  ): RunNode {
    // The event seed makes the id deterministic across replays; the occurrence
    // counter keeps two calls to the same tool inside one step from colliding.
    // Nodes with a stable identity of their own (a fan-out branch, a merge) pass
    // the id explicitly so live and replayed runs agree on it.
    const id = spec.id ?? eventNodeId(spec.type, spec.seed + "#" + String(state.seq));
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

/* --------------------------- Neo N16 recall metadata --------------------------- */

/** Read one string field off a node payload without assuming its shape. */
function dataField(node: RunNode, key: string): string | undefined {
  if (typeof node.data !== "object" || node.data === null) return undefined;
  const value = (node.data as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function dataTitleOf(node: RunNode): string | undefined {
  return dataField(node, "title") ?? dataField(node, "label");
}

function dataPathOf(node: RunNode): string | undefined {
  return dataField(node, "path");
}

function dataUrlOf(node: RunNode): string | undefined {
  return dataField(node, "url");
}

function dataMimeOf(node: RunNode): string | undefined {
  return dataField(node, "mime");
}

/**
 * The text a recalled node carries into its new run.
 *
 * Reuses the same field order as the recall index, so what the shelf matched on
 * is exactly what the attached node shows.
 */
function recallTextOf(node: RunNode): string {
  const parts: string[] = [];
  for (const key of ["title", "label", "query", "url", "path", "summary", "text", "reason", "message", "verdict", "tool"]) {
    const value = dataField(node, key);
    if (value && !parts.includes(value)) parts.push(value);
  }
  return parts.length === 0 ? `${node.type} ${node.run_id}` : oneLine(parts.join(" — "), 8000);
}

export { assertTransition, canTransition, RUN_NODE_ENTITY };
