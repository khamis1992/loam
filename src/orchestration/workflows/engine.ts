/**
 * C7: superstep engine. Each superstep runs every ready node (up to
 * maxParallelNodes at once), merges outputs into run state, routes along
 * edges, then checkpoints the run (store.saveRun). Human nodes pause the run
 * on a durable interrupt; resumeWorkflow() continues from the checkpoint.
 */
import type { SelectResult, Candidate } from "../selection/selectBest.js";
import { newId } from "../durable/ids.js";
import type { OrchestrationEvent } from "../events.js";
import type { Condition, WorkflowDef, WorkflowNode, WorkflowRunState } from "./types.js";
import { recordStep, saveRun } from "./store.js";

export interface NodeContext {
  runId: string;
  taskId: string;
  signal?: AbortSignal;
}

export interface WorkflowPorts {
  runAgent(node: WorkflowNode, prompt: string, ctx: NodeContext): Promise<{ ok: boolean; text: string; output?: unknown }>;
  runTool(name: string, args: Record<string, unknown>, ctx: NodeContext): Promise<{ ok: boolean; content: string }>;
  /** Creates a workflow_human interrupt and returns its id (durable/interrupts.ts). */
  askHuman(node: WorkflowNode, ctx: NodeContext): string;
  select(goal: string, candidates: Candidate[]): Promise<SelectResult>;
  loadWorkflow(id: string): WorkflowDef | undefined;
  emit?(ev: OrchestrationEvent): void;
}

export interface EngineLimits {
  maxSupersteps: number;
  maxParallelNodes: number;
  maxSubworkflowDepth: number;
}

export function getPath(root: Record<string, unknown>, p: string): unknown {
  let cur: unknown = root;
  for (const part of p.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** `{{inputs.a}}` / `{{state.b.c}}`; non-strings are JSON-encoded; unknown paths become "". */
export function renderTemplate(tpl: string, scope: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*((?:inputs|state)(?:\.[A-Za-z0-9_]+)+)\s*\}\}/g, (_m, p: string) => {
    const v = getPath(scope, p);
    if (v === undefined || v === null) return "";
    return typeof v === "string" ? v : JSON.stringify(v);
  });
}

function renderArgs(v: unknown, scope: Record<string, unknown>): unknown {
  if (typeof v === "string") return renderTemplate(v, scope);
  if (Array.isArray(v)) return v.map((x) => renderArgs(x, scope));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, renderArgs(x, scope)]));
  return v;
}

export function evalCondition(c: Condition, scope: Record<string, unknown>): boolean {
  if ("all" in c) return c.all.every((x) => evalCondition(x, scope));
  if ("any" in c) return c.any.some((x) => evalCondition(x, scope));
  if ("not" in c) return !evalCondition(c.not, scope);
  const v = getPath(scope, c.path);
  if (c.op === "exists") return v !== undefined && v !== null && v !== "";
  if (c.op === "eq") return v === c.value;
  if (c.op === "neq") return v !== c.value;
  if (c.op === "contains") return typeof v === "string" ? v.includes(String(c.value)) : Array.isArray(v) && v.includes(c.value);
  if (c.op === "gt") return typeof v === "number" && v > Number(c.value);
  return typeof v === "number" && v < Number(c.value);
}

export function startWorkflow(def: WorkflowDef, taskId: string, inputs: Record<string, unknown>): WorkflowRunState {
  return { runId: newId("wfr"), workflowId: def.id, taskId, status: "running", inputs, state: {}, frontier: [def.start], visits: {}, done: [], superstep: 0 };
}

type NodeOutcome = { status: "succeeded"; output: unknown; branch?: "true" | "false" } | { status: "failed"; error: string } | { status: "waiting"; interruptId: string };

async function runNode(def: WorkflowDef, node: WorkflowNode, run: WorkflowRunState, ports: WorkflowPorts, lim: EngineLimits, depth: number, ctx: NodeContext): Promise<NodeOutcome> {
  const scope = { inputs: run.inputs, state: run.state };
  switch (node.kind) {
    case "agent": {
      const r = await ports.runAgent(node, renderTemplate(node.agent?.prompt ?? "", scope), ctx);
      return r.ok ? { status: "succeeded", output: r.output ?? r.text } : { status: "failed", error: r.text.slice(0, 500) || "agent failed" };
    }
    case "tool": {
      const r = await ports.runTool(node.tool?.name ?? "", renderArgs(node.tool?.args ?? {}, scope) as Record<string, unknown>, ctx);
      return r.ok ? { status: "succeeded", output: r.content } : { status: "failed", error: r.content.slice(0, 500) };
    }
    case "human":
      return { status: "waiting", interruptId: ports.askHuman(node, ctx) };
    case "vote": {
      const cands: Candidate[] = (node.vote?.from ?? []).map((id) => {
        const src = def.nodes.find((n) => n.id === id);
        const val = src?.outputKey ? run.state[src.outputKey] : undefined;
        return { id, ok: val !== undefined, text: typeof val === "string" ? val : JSON.stringify(val ?? "") };
      });
      const sel = await ports.select(renderTemplate(node.vote?.goal ?? "", scope), cands);
      if (!sel.winnerId) return { status: "failed", error: sel.reason };
      const winner = cands.find((c) => c.id === sel.winnerId);
      return { status: "succeeded", output: { winner: sel.winnerId, text: winner?.text ?? "", method: sel.method } };
    }
    case "condition":
      return { status: "succeeded", output: null, branch: node.condition && evalCondition(node.condition, scope) ? "true" : "false" };
    case "transform": {
      const out: Record<string, string> = {};
      for (const [k, t] of Object.entries(node.transform?.set ?? {})) out[k] = renderTemplate(t, scope);
      return { status: "succeeded", output: out };
    }
    case "subworkflow": {
      if (depth >= lim.maxSubworkflowDepth) return { status: "failed", error: `subworkflow depth limit ${lim.maxSubworkflowDepth}` };
      const child = ports.loadWorkflow(node.subworkflow?.workflowId ?? "");
      if (!child) return { status: "failed", error: `workflow ${node.subworkflow?.workflowId} not found` };
      const childInputs = Object.fromEntries(Object.entries(node.subworkflow?.inputs ?? {}).map(([k, t]) => [k, renderTemplate(t, scope)]));
      const childRun = startWorkflow(child, run.taskId, childInputs);
      const res = await advanceWorkflow(child, childRun, ports, lim, ctx.signal, depth + 1);
      if (res.status === "waiting") return { status: "failed", error: "human nodes are not allowed inside a subworkflow" };
      return res.status === "succeeded" ? { status: "succeeded", output: res.state } : { status: "failed", error: res.error ?? "subworkflow failed" };
    }
  }
}

function nextNodes(def: WorkflowDef, node: WorkflowNode, outcome: NodeOutcome): string[] {
  const out = def.edges.filter((e) => e.from === node.id);
  if (node.kind === "condition" && outcome.status === "succeeded") return out.filter((e) => e.when === outcome.branch).map((e) => e.to);
  return out.map((e) => e.to);
}

/** Runs supersteps until the run succeeds, fails, waits on a human, or is aborted. */
export async function advanceWorkflow(def: WorkflowDef, run: WorkflowRunState, ports: WorkflowPorts, lim: EngineLimits, signal?: AbortSignal, depth = 0): Promise<WorkflowRunState> {
  const persist = depth === 0;
  const ctx: NodeContext = { runId: run.runId, taskId: run.taskId, signal };
  // The run row must exist before its first workflow_steps row (foreign key).
  if (persist) saveRun(run);
  while (run.status === "running") {
    if (signal?.aborted) {
      run.status = "cancelled";
      break;
    }
    if (run.frontier.length === 0) {
      run.status = "succeeded";
      break;
    }
    if (run.superstep >= lim.maxSupersteps) {
      run.status = "failed";
      run.error = `stopped after ${lim.maxSupersteps} supersteps`;
      break;
    }
    run.superstep++;
    const ready = run.frontier.filter((id) => {
      const n = def.nodes.find((x) => x.id === id);
      return !!n && (n.waitFor ?? []).every((w) => run.done.includes(w));
    });
    const blocked = run.frontier.filter((id) => !ready.includes(id));
    if (ready.length === 0) {
      run.status = "failed";
      run.error = `deadlock: ${blocked.join(", ")} wait for nodes that will not run`;
      break;
    }
    const next = new Set<string>(blocked);
    for (let i = 0; i < ready.length; i += lim.maxParallelNodes) {
      const batch = ready.slice(i, i + lim.maxParallelNodes);
      const results = await Promise.all(
        batch.map(async (id) => {
          const node = def.nodes.find((n) => n.id === id) as WorkflowNode;
          const visits = (run.visits[id] ?? 0) + 1;
          run.visits[id] = visits;
          const started = Date.now();
          ports.emit?.({ type: "workflow_node", runId: run.runId, nodeId: id, status: "started", superstep: run.superstep });
          const outcome: NodeOutcome =
            visits > (node.maxVisits ?? 10)
              ? { status: "failed", error: `node ${id} exceeded maxVisits ${node.maxVisits ?? 10}` }
              : await runNode(def, node, run, ports, lim, depth, ctx).catch((e: unknown) => ({ status: "failed" as const, error: e instanceof Error ? e.message : String(e) }));
          return { node, outcome, started };
        }),
      );
      for (const { node, outcome, started } of results) {
        if (persist) {
          recordStep({
            runId: run.runId,
            superstep: run.superstep,
            nodeId: node.id,
            status: outcome.status,
            output: outcome.status === "succeeded" ? outcome.output : undefined,
            error: outcome.status === "failed" ? outcome.error : undefined,
            startedAt: started,
            endedAt: Date.now(),
          });
        }
        ports.emit?.({ type: "workflow_node", runId: run.runId, nodeId: node.id, status: outcome.status === "waiting" ? "waiting" : outcome.status, superstep: run.superstep });
        if (outcome.status === "failed") {
          run.status = "failed";
          run.error = `${node.id}: ${outcome.error}`;
          continue;
        }
        if (outcome.status === "waiting") {
          run.status = "waiting";
          run.waitingInterrupt = { interruptId: outcome.interruptId, nodeId: node.id };
          continue;
        }
        if (node.outputKey && node.kind !== "condition") run.state[node.outputKey] = outcome.output;
        if (node.kind === "transform" && outcome.output && typeof outcome.output === "object") Object.assign(run.state, outcome.output);
        if (!run.done.includes(node.id)) run.done.push(node.id);
        for (const n of nextNodes(def, node, outcome)) next.add(n);
      }
    }
    run.frontier = [...next];
    if (persist) saveRun(run);
  }
  if (persist) saveRun(run);
  return run;
}

/** Continues a run paused on a human node with the validated interrupt response. */
export async function resumeWorkflow(def: WorkflowDef, run: WorkflowRunState, response: unknown, ports: WorkflowPorts, lim: EngineLimits, signal?: AbortSignal): Promise<WorkflowRunState> {
  if (run.status !== "waiting" || !run.waitingInterrupt) throw new Error(`run ${run.runId} is not waiting`);
  const node = def.nodes.find((n) => n.id === run.waitingInterrupt?.nodeId) as WorkflowNode;
  if (node.outputKey) run.state[node.outputKey] = response;
  if (!run.done.includes(node.id)) run.done.push(node.id);
  const next = new Set(run.frontier.filter((id) => id !== node.id));
  for (const e of def.edges) if (e.from === node.id) next.add(e.to);
  run.frontier = [...next];
  run.waitingInterrupt = undefined;
  run.status = "running";
  return advanceWorkflow(def, run, ports, lim, signal);
}
