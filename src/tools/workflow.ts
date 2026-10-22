/**
 * D13 — Resumable deterministic workflows.
 *
 * A workflow is a TS/JSON-defined DAG of stages. A `map` stage fans out over the
 * run's items (one agent call per item); a `single` stage runs exactly one agent
 * call (e.g. a combine/reduce step). Every agent call is keyed by a hash of its
 * inputs and recorded in a durable run journal. On resume, completed calls replay
 * from the journal and only unfinished work executes.
 *
 * The bounded fan-out primitive is shared with map_reduce (see runBounded).
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { OllamaClient } from "../ollama.js";
import { runAgent } from "../agent/loop.js";
import type { Emit } from "../agent/events.js";
import type { Tool, ToolContext, ToolResult, ToolRegistry } from "./registry.js";
import { num, str, strs } from "./registry.js";
import { runBounded } from "./mapReduce.js";

const DEFAULT_WORKFLOW_TOOLS = [
  "file_read",
  "file_list",
  "file_search",
  "file_stat",
  "web_search",
  "web_fetch",
  "file_write",
  "file_edit",
  "shell_run",
];

const MAX_CONCURRENCY = 10;

// ---------------------------------------------------------------------------
// Workflow definition
// ---------------------------------------------------------------------------

export interface WorkflowStageDefinition {
  id: string;
  /** `map` fans out over the run items; `single` runs one call. */
  kind: "map" | "single";
  /** Prompt template. `{item}` is the current item, `{results}` is the prior stages' output. */
  prompt: string;
  /** Stage ids that must complete before this one runs. */
  dependsOn?: string[];
  /** Optional tool allowlist for this stage's child agents. */
  allowTools?: string[];
  /** Optional subagent profile name. */
  subagent?: string;
  /** Optional per-stage step budget override. */
  maxSteps?: number;
}

export interface WorkflowDefinition {
  name?: string;
  stages: WorkflowStageDefinition[];
}

export interface WorkflowAgentCall {
  stageId: string;
  /** Item index for `map` calls, -1 for `single` calls. */
  index: number;
  item?: string;
  prompt: string;
  systemSuffix?: string;
  allowTools?: string[];
  subagent?: string;
  maxSteps?: number;
}

export interface WorkflowAgentResult {
  text: string;
  steps: number;
}

/** Injected agent executor, so tests can mock the model without any network. */
export type WorkflowAgent = (call: WorkflowAgentCall) => Promise<WorkflowAgentResult>;

// ---------------------------------------------------------------------------
// Run journal
// ---------------------------------------------------------------------------

export interface WorkflowCallRecord {
  key: string;
  stageId: string;
  index: number;
  item?: string;
  prompt: string;
  status: "completed" | "failed";
  result?: WorkflowAgentResult;
  error?: string;
  completedAt: string;
}

export interface WorkflowRunState {
  version: 1;
  runId: string;
  workflow: WorkflowDefinition;
  items: string[];
  status: "running" | "completed" | "interrupted";
  calls: Record<string, WorkflowCallRecord>;
  output?: string;
  updatedAt: string;
}

export interface WorkflowJournal {
  load(runId: string): Promise<WorkflowRunState | null>;
  save(state: WorkflowRunState): Promise<void>;
}

/** In-memory journal (tests). */
export class MemoryWorkflowJournal implements WorkflowJournal {
  private readonly states = new Map<string, WorkflowRunState>();

  async load(runId: string): Promise<WorkflowRunState | null> {
    const state = this.states.get(runId);
    return state ? structuredClone(state) : null;
  }

  async save(state: WorkflowRunState): Promise<void> {
    this.states.set(state.runId, structuredClone(state));
  }
}

/** Durable journal on disk; survives process restarts. Writes are atomic. */
export class FileWorkflowJournal implements WorkflowJournal {
  constructor(private readonly dir: string) {}

  private fileFor(runId: string): string {
    const safe = runId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "run";
    return path.join(this.dir, `${safe}.json`);
  }

  async load(runId: string): Promise<WorkflowRunState | null> {
    try {
      const raw = fs.readFileSync(this.fileFor(runId), "utf8");
      return JSON.parse(raw) as WorkflowRunState;
    } catch {
      return null;
    }
  }

  async save(state: WorkflowRunState): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.fileFor(state.runId);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, file);
  }
}

// ---------------------------------------------------------------------------
// DAG helpers
// ---------------------------------------------------------------------------

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Stable fingerprint of a workflow definition, used to namespace journal keys. */
export function workflowFingerprint(workflow: WorkflowDefinition): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(workflow))).digest("hex").slice(0, 16);
}

/** Deterministic key for one agent call: identical inputs hash to the same key. */
export function callKey(fingerprint: string, stageId: string, index: number, prompt: string, systemSuffix: string): string {
  return createHash("sha256").update(JSON.stringify({ fingerprint, stageId, index, prompt, systemSuffix })).digest("hex").slice(0, 24);
}

/** Returns an error message for an invalid workflow, or null when it is valid. */
export function validateWorkflow(workflow: WorkflowDefinition): string | null {
  if (!workflow || !Array.isArray(workflow.stages) || workflow.stages.length === 0) {
    return "workflow must define at least one stage";
  }
  const ids = new Set<string>();
  for (const stage of workflow.stages) {
    if (!stage || typeof stage.id !== "string" || stage.id.trim() === "") return "every stage needs a non-empty id";
    if (ids.has(stage.id)) return `duplicate stage id: ${stage.id}`;
    ids.add(stage.id);
    if (stage.kind !== "map" && stage.kind !== "single") return `stage ${stage.id}: kind must be "map" or "single"`;
    if (typeof stage.prompt !== "string" || stage.prompt.trim() === "") return `stage ${stage.id} needs a prompt`;
    for (const dep of stage.dependsOn ?? []) {
      if (!workflow.stages.some((s) => s.id === dep)) return `stage ${stage.id} depends on unknown stage: ${dep}`;
    }
  }
  try {
    orderStages(workflow);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return null;
}

/** Deterministic topological order (definition order breaks ties). Throws on cycles. */
export function orderStages(workflow: WorkflowDefinition): WorkflowStageDefinition[] {
  const stages = workflow.stages;
  const byId = new Map(stages.map((s) => [s.id, s]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const stage of stages) {
    indegree.set(stage.id, 0);
    dependents.set(stage.id, []);
  }
  for (const stage of stages) {
    for (const dep of stage.dependsOn ?? []) {
      indegree.set(stage.id, indegree.get(stage.id)! + 1);
      dependents.get(dep)!.push(stage.id);
    }
  }
  const position = new Map(stages.map((s, i) => [s.id, i]));
  const ready = stages.filter((s) => indegree.get(s.id) === 0).map((s) => s.id);
  const ordered: string[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => position.get(a)! - position.get(b)!);
    const id = ready.shift()!;
    ordered.push(id);
    for (const next of dependents.get(id)!) {
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) ready.push(next);
    }
  }
  if (ordered.length !== stages.length) throw new Error("workflow has a cycle");
  return ordered.map((id) => byId.get(id)!);
}

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

export interface CompletedStage {
  id: string;
  kind: WorkflowStageDefinition["kind"];
  outputs: WorkflowAgentResult[];
}

/** Deterministic text block of every completed stage, in stage order. */
export function renderResultsBlock(stages: readonly CompletedStage[]): string {
  const lines: string[] = [];
  for (const stage of stages) {
    lines.push(`Stage "${stage.id}":`);
    stage.outputs.forEach((output, index) => {
      const text = output.text.replace(/\s+/g, " ").trim();
      lines.push(`  [${index}] ${text}`);
    });
  }
  return lines.join("\n");
}

/** Expand `{item}` and `{results}` in a stage prompt. */
export function renderPrompt(template: string, item: string | undefined, completedStages: readonly CompletedStage[]): string {
  return template.replace(/\{item\}/g, item ?? "").replace(/\{results\}/g, renderResultsBlock(completedStages));
}

function buildSystemSuffix(stage: WorkflowStageDefinition): string {
  const parts = [`[Workflow stage: ${stage.id}]`];
  if (stage.subagent) parts.push(`[Subagent: ${stage.subagent}]`);
  return parts.join("\n");
}

function buildCall(stage: WorkflowStageDefinition, index: number, item: string | undefined): WorkflowAgentCall {
  return {
    stageId: stage.id,
    index,
    ...(item !== undefined ? { item } : {}),
    prompt: stage.prompt,
    systemSuffix: buildSystemSuffix(stage),
    ...(stage.allowTools ? { allowTools: stage.allowTools } : {}),
    ...(stage.subagent ? { subagent: stage.subagent } : {}),
    ...(stage.maxSteps ? { maxSteps: stage.maxSteps } : {}),
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface RunWorkflowOptions {
  runId: string;
  workflow: WorkflowDefinition;
  items: string[];
  agent: WorkflowAgent;
  journal: WorkflowJournal;
  emit?: Emit;
  signal?: AbortSignal;
  concurrency?: number;
}

export interface WorkflowRunResult {
  runId: string;
  status: "completed" | "interrupted";
  output: string;
  /** Keys executed (run or attempted) during this invocation. */
  executed: string[];
  /** Keys replayed from the journal during this invocation. */
  replayed: string[];
  stages: CompletedStage[];
}

/**
 * Execute a workflow, replaying completed calls from the journal. Stages run in
 * deterministic topological order and calls within a stage are assembled by
 * index, so output ordering never depends on completion order.
 */
export async function runWorkflow(opts: RunWorkflowOptions): Promise<WorkflowRunResult> {
  const { runId, journal, agent, signal } = opts;
  const workflow = opts.workflow;
  const validationError = validateWorkflow(workflow);
  if (validationError) throw new Error(validationError);
  const fingerprint = workflowFingerprint(workflow);

  let state = await journal.load(runId);
  if (state && workflowFingerprint(state.workflow) !== fingerprint) {
    throw new Error(`workflow run "${runId}" was created for a different workflow definition`);
  }
  if (!state) {
    state = {
      version: 1,
      runId,
      workflow,
      items: opts.items,
      status: "running",
      calls: {},
      updatedAt: new Date().toISOString(),
    };
  }
  const items = state.items;
  const order = orderStages(workflow);
  const executed: string[] = [];
  const replayed: string[] = [];
  const completedStages: CompletedStage[] = [];
  let interrupted = false;

  for (const stage of order) {
    if (signal?.aborted) {
      interrupted = true;
      break;
    }
    const calls: WorkflowAgentCall[] =
      stage.kind === "map"
        ? items.map((item, index) => buildCall(stage, index, item))
        : [buildCall(stage, -1, undefined)];

    const records = await runBounded(
      calls,
      opts.concurrency ?? 1,
      async (call) => {
        const prompt = renderPrompt(call.prompt, call.item, completedStages);
        const systemSuffix = call.systemSuffix ?? buildSystemSuffix(stage);
        const key = callKey(fingerprint, stage.id, call.index, prompt, systemSuffix);
        const existing = state.calls[key];
        if (existing?.status === "completed") {
          replayed.push(key);
          return existing;
        }
        if (signal?.aborted) return null;
        const started = Date.now();
        opts.emit?.({
          type: "tool_call",
          name: "workflow_call",
          args: { runId, stageId: stage.id, index: call.index, ...(call.item !== undefined ? { item: call.item } : {}) },
        });
        try {
          const result = await agent({ ...call, prompt, systemSuffix });
          const record: WorkflowCallRecord = {
            key,
            stageId: stage.id,
            index: call.index,
            ...(call.item !== undefined ? { item: call.item } : {}),
            prompt,
            status: "completed",
            result,
            completedAt: new Date().toISOString(),
          };
          state.calls[key] = record;
          executed.push(key);
          opts.emit?.({
            type: "tool_result",
            name: "workflow_call",
            ok: true,
            summary: `${stage.id}[${call.index}] completed in ${Date.now() - started}ms`,
          });
          await journal.save(state);
          return record;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const record: WorkflowCallRecord = {
            key,
            stageId: stage.id,
            index: call.index,
            ...(call.item !== undefined ? { item: call.item } : {}),
            prompt,
            status: "failed",
            error: message,
            completedAt: new Date().toISOString(),
          };
          state.calls[key] = record;
          executed.push(key);
          opts.emit?.({
            type: "tool_result",
            name: "workflow_call",
            ok: false,
            summary: `${stage.id}[${call.index}] failed: ${message}`,
          });
          await journal.save(state);
          return record;
        }
      },
      signal,
    );

    const outputs = records
      .filter((record): record is WorkflowCallRecord => record !== null)
      .sort((a, b) => a.index - b.index)
      .map((record) => record.result ?? { text: record.error ?? "failed", steps: 0 });
    completedStages.push({ id: stage.id, kind: stage.kind, outputs });

    if (signal?.aborted) {
      interrupted = true;
      break;
    }
  }

  const lastStage = completedStages[completedStages.length - 1];
  state.status = interrupted ? "interrupted" : "completed";
  state.output = lastStage ? lastStage.outputs.map((output) => output.text).join("\n") : state.output ?? "";
  state.updatedAt = new Date().toISOString();
  await journal.save(state);

  return {
    runId,
    status: state.status,
    output: state.output,
    executed,
    replayed,
    stages: completedStages,
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface WorkflowToolOptions {
  ollama: OllamaClient;
  registry: ToolRegistry;
  /** Directory for run journals. Defaults to <workspace>/.loam/workflows. */
  journalDir?: string;
  defaultSubagent?: string;
  childAllowTools?: string[];
  maxSteps?: number;
  concurrency?: number;
}

const WORKFLOW_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["stages"],
  properties: {
    name: { type: "string", description: "Optional human-readable workflow name." },
    stages: {
      type: "array",
      minItems: 1,
      description: "Ordered DAG of stages. `map` fans out over the run items; `single` runs one call.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "prompt"],
        properties: {
          id: { type: "string", minLength: 1, description: "Unique stage id." },
          kind: { type: "string", enum: ["map", "single"], description: "map = fan-out over items, single = one call." },
          prompt: {
            type: "string",
            minLength: 1,
            description: "Prompt template. {item} is the current item; {results} is the prior stages' output.",
          },
          dependsOn: { type: "array", items: { type: "string" }, description: "Stage ids that must complete first." },
          allowTools: { type: "array", items: { type: "string" }, description: "Tool allowlist for this stage's children." },
          subagent: { type: "string", description: "Subagent profile name." },
          maxSteps: { type: "integer", minimum: 1, description: "Per-stage step budget override." },
        },
      },
    },
  },
};

function defaultRunId(): string {
  return `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** Build the real agent executor from the run context. */
function buildWorkflowAgent(options: WorkflowToolOptions, ctx: ToolContext): WorkflowAgent {
  const { ollama, registry, childAllowTools, maxSteps } = options;
  return async (call) => {
    const allow = call.allowTools ?? childAllowTools ?? DEFAULT_WORKFLOW_TOOLS;
    const childRegistry = registry.forAllowlist(allow);
    const res = await runAgent({
      cfg: ctx.cfg,
      ollama,
      tools: childRegistry,
      emit: (event) => {
        if (event.type === "tool_call") ctx.emit(event);
      },
      prompt: call.prompt,
      systemSuffix: call.systemSuffix,
      maxSteps: call.maxSteps ?? maxSteps,
      signal: ctx.signal,
      taskId: ctx.taskId,
      suppressFinal: true,
    });
    return { text: res.text, steps: res.steps };
  };
}

export function createWorkflowTools(options: WorkflowToolOptions): Tool[] {
  const journalDir = (ctx: ToolContext): string => options.journalDir ?? path.join(ctx.workspace, ".loam", "workflows");

  const run: Tool = {
    name: "workflow_run",
    description:
      "Run a resumable deterministic workflow (a DAG of stages). `map` stages fan out over the given items with one child agent per item; a `single` stage (e.g. combine/reduce) runs once after its dependencies. Every agent call is journaled, so an interrupted run resumes without repeating finished work. Use {item} in a map prompt and {results} in a combine prompt.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["workflow", "items"],
      properties: {
        workflow: WORKFLOW_SCHEMA,
        items: { type: "array", items: { type: "string", minLength: 1 }, description: "Items a `map` stage fans out over." },
        runId: { type: "string", description: "Optional stable id; pass it to workflow_resume." },
        concurrency: { type: "integer", minimum: 1, maximum: MAX_CONCURRENCY, default: 1, description: "Max parallel child agents per stage." },
      },
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const workflow = args.workflow as WorkflowDefinition | undefined;
      if (!workflow) return { ok: false, content: "workflow_run requires a workflow definition" };
      const items = strs(args, "items");
      if (items.length === 0) return { ok: false, content: "workflow_run requires at least one item" };
      const runId = str(args, "runId").trim() || defaultRunId();
      const concurrency = clamp(num(args, "concurrency", options.concurrency ?? 1), 1, MAX_CONCURRENCY);
      ctx.emit({ type: "tool_call", name: "workflow_run", args: { runId, stages: workflow.stages.length, items: items.length, concurrency } });
      try {
        const result = await runWorkflow({
          runId,
          workflow,
          items,
          agent: buildWorkflowAgent(options, ctx),
          journal: new FileWorkflowJournal(journalDir(ctx)),
          emit: ctx.emit,
          signal: ctx.signal,
          concurrency,
        });
        ctx.emit({ type: "tool_result", name: "workflow_run", ok: true, summary: `workflow ${runId} ${result.status}` });
        return { ok: true, content: JSON.stringify(result, null, 2) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.emit({ type: "tool_result", name: "workflow_run", ok: false, summary: message });
        return { ok: false, content: message };
      }
    },
  };

  const resume: Tool = {
    name: "workflow_resume",
    description:
      "Resume an interrupted workflow run by runId. Completed agent calls replay from the durable journal; only unfinished calls execute. Returns the same summary as workflow_run.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["runId"],
      properties: { runId: { type: "string", description: "The runId returned by workflow_run." } },
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const runId = str(args, "runId").trim();
      if (!runId) return { ok: false, content: "workflow_resume requires runId" };
      const journal = new FileWorkflowJournal(journalDir(ctx));
      const state = await journal.load(runId);
      if (!state) return { ok: false, content: `no workflow run found for "${runId}"` };
      try {
        const result = await runWorkflow({
          runId,
          workflow: state.workflow,
          items: state.items,
          agent: buildWorkflowAgent(options, ctx),
          journal,
          emit: ctx.emit,
          signal: ctx.signal,
          concurrency: options.concurrency ?? 1,
        });
        return { ok: true, content: JSON.stringify(result, null, 2) };
      } catch (err) {
        return { ok: false, content: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const status: Tool = {
    name: "workflow_status",
    description: "Report the status and journal progress of a workflow run by runId.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["runId"],
      properties: { runId: { type: "string", description: "The runId returned by workflow_run." } },
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const runId = str(args, "runId").trim();
      if (!runId) return { ok: false, content: "workflow_status requires runId" };
      const state = await new FileWorkflowJournal(journalDir(ctx)).load(runId);
      if (!state) return { ok: false, content: `no workflow run found for "${runId}"` };
      const calls = Object.values(state.calls);
      return {
        ok: true,
        content: JSON.stringify(
          {
            runId: state.runId,
            status: state.status,
            completedCalls: calls.filter((call) => call.status === "completed").length,
            failedCalls: calls.filter((call) => call.status === "failed").length,
            totalCalls: calls.length,
            output: state.output ?? null,
            updatedAt: state.updatedAt,
          },
          null,
          2,
        ),
      };
    },
  };

  return [run, resume, status];
}
