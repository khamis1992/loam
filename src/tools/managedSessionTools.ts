import type { OllamaClient } from "../ollama.js";
import type { Emit } from "../agent/events.js";
import { runAgent } from "../agent/loop.js";
import { agentSystemSuffix, getAgent } from "../server/agents.js";
import { getTask } from "../server/db.js";
import { isChildOf } from "../server/agentSpawn.js";
import {
  BudgetExceededError,
  managedSessions,
  type ChildRunContext,
  type ManagedChildBudget,
  type ManagedChildEvent,
  type ManagedChildRunner,
} from "../server/managedSessions.js";
import type { Tool, ToolContext, ToolResult, ToolRegistry } from "./registry.js";
import { num, str } from "./registry.js";

export interface ManagedSessionToolDeps {
  ollama: OllamaClient;
  parentRegistry: ToolRegistry;
}

/** The agent that owns the running task; managed sessions are parent-scoped. */
function parentAgentId(ctx: ToolContext): string {
  if (ctx.agentId && ctx.agentId.trim()) return ctx.agentId.trim();
  if (!ctx.taskId) return "";
  return getTask(ctx.taskId)?.agentId ?? "";
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseBudget(args: Record<string, unknown>): ManagedChildBudget {
  const budget: ManagedChildBudget = {};
  const maxSteps = num(args, "maxSteps", 0);
  if (maxSteps > 0) budget.maxSteps = Math.min(Math.floor(maxSteps), 1000);
  const maxTokens = num(args, "maxTokens", 0);
  if (maxTokens > 0) budget.maxTokens = Math.min(Math.floor(maxTokens), 10_000_000);
  const timeoutMs = num(args, "timeoutMs", 0);
  if (timeoutMs > 0) budget.timeoutMs = Math.min(Math.floor(timeoutMs), 3_600_000);
  return budget;
}

/** Build a runner that executes the child under its own identity with a budget. */
function buildRunner(deps: ManagedSessionToolDeps, ctx: ToolContext, childAgentId: string, prompt: string, budget: ManagedChildBudget): ManagedChildRunner {
  return async (c: ChildRunContext): Promise<string> => {
    const childAgent = getAgent(childAgentId);
    const effectiveCfg = childAgent?.model && childAgent.model !== "inherit" ? { ...ctx.cfg, model: childAgent.model } : ctx.cfg;
    const deny = new Set([
      "delegate_subagent",
      "managed_child_start",
      "managed_child_message",
      "managed_child_sleep",
      "managed_child_wake",
      "managed_child_terminate",
      "managed_child_answer",
    ]);
    const subRegistry = deps.parentRegistry.cloneFiltered({ deny: [...deny] });
    const maxSteps = budget.maxSteps ?? 12;
    const emit: Emit = (ev) => {
      if (ev.type === "step") c.reportStep();
      ctx.emit(ev);
    };
    try {
      const res = await runAgent({
        cfg: effectiveCfg,
        ollama: deps.ollama,
        tools: subRegistry,
        emit,
        prompt,
        ...(childAgent ? { systemSuffix: agentSystemSuffix(childAgent) } : {}),
        maxSteps,
        signal: c.signal,
        taskId: ctx.taskId,
        suppressFinal: true,
      });
      c.reportTokens(res.usage.promptTokens + res.usage.completionTokens);
      return res.text;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/stopped after \d+ steps/.test(message)) throw new BudgetExceededError("steps");
      throw err;
    }
  };
}

/** Record the latest wake events so a coordinator can inspect what woke it. */
const wakeLog = new Map<string, ManagedChildEvent[]>();
let wakeRecording = false;
function recordWake(event: ManagedChildEvent): void {
  if (event.type !== "finish" && event.type !== "needs_input") return;
  const list = wakeLog.get(event.parentAgentId) ?? [];
  list.push(event);
  wakeLog.set(event.parentAgentId, list);
}

function ensureWakeRecording(): void {
  if (wakeRecording) return;
  wakeRecording = true;
  managedSessions.onAnyCoordinatorWake(recordWake);
}

export function createManagedSessionTools(deps: ManagedSessionToolDeps): Tool[] {
  ensureWakeRecording();
  return [
    {
      name: "managed_child_start",
      description:
        "Start a managed child session for one of this agent's child agents, with an optional budget (maxSteps/maxTokens/timeoutMs). The child runs in the background under its own identity; you are woken by an event when it finishes or asks for input. Use managed_child_message/sleep/terminate to control it.",
      parameters: {
        type: "object",
        properties: {
          childId: { type: "string", description: "Id of the child agent (see list_children)." },
          prompt: { type: "string", description: "Complete, self-contained request for the child agent." },
          maxSteps: { type: "number", description: "Max tool steps for the child (default 12)." },
          maxTokens: { type: "number", description: "Max total tokens for the child (optional)." },
          timeoutMs: { type: "number", description: "Max wall-clock time for the child in milliseconds (optional)." },
        },
        required: ["childId", "prompt"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const parentId = parentAgentId(ctx);
        if (!parentId) return { ok: false, content: "managed_child_start requires a parent agent - this run has no agent identity" };
        const childId = str(args, "childId").trim();
        const prompt = str(args, "prompt").trim();
        if (!childId || !prompt) return { ok: false, content: "managed_child_start requires both childId and prompt" };
        if (!getAgent(childId)) return { ok: false, content: `child agent not found: ${childId}` };
        if (!isChildOf(parentId, childId)) return { ok: false, content: `agent ${childId} is not a child of ${parentId}` };
        try {
          const budget = parseBudget(args);
          const child = managedSessions.start({
            parentAgentId: parentId,
            childAgentId: childId,
            prompt,
            budget,
            runner: buildRunner(deps, ctx, childId, prompt, budget),
          });
          return {
            ok: true,
            content: `started managed child ${child.id} for agent ${childId} (status ${child.status}, budget ${JSON.stringify(child.budget)})`,
          };
        } catch (err) {
          return { ok: false, content: `managed_child_start failed: ${errorText(err)}` };
        }
      },
    },
    {
      name: "managed_child_message",
      description: "Deliver a message to a running (or sleeping) managed child session. The child picks it up on its next step via its run context.",
      parameters: {
        type: "object",
        properties: {
          childId: { type: "string", description: "Managed child session id (from managed_child_start)." },
          message: { type: "string", description: "Message to deliver to the child." },
        },
        required: ["childId", "message"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const parentId = parentAgentId(ctx);
        if (!parentId) return { ok: false, content: "managed_child_message requires a parent agent - this run has no agent identity" };
        const childId = str(args, "childId").trim();
        const message = str(args, "message");
        const child = managedSessions.get(childId);
        if (!child || child.parentAgentId !== parentId) return { ok: false, content: `unknown managed child: ${childId}` };
        const ok = managedSessions.message(childId, message);
        if (!ok) return { ok: false, content: `child ${childId} is not accepting messages (status ${child.status})` };
        return { ok: true, content: `delivered message to managed child ${childId}` };
      },
    },
    {
      name: "managed_child_sleep",
      description: "Put a running managed child session to sleep. It stops consuming steps until managed_child_wake resumes it.",
      parameters: {
        type: "object",
        properties: { childId: { type: "string", description: "Managed child session id." } },
        required: ["childId"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const parentId = parentAgentId(ctx);
        if (!parentId) return { ok: false, content: "managed_child_sleep requires a parent agent - this run has no agent identity" };
        const childId = str(args, "childId").trim();
        if (!managedSessions.sleep(childId)) return { ok: false, content: `managed child ${childId} is not running` };
        return { ok: true, content: `managed child ${childId} is now sleeping` };
      },
    },
    {
      name: "managed_child_wake",
      description: "Wake a sleeping managed child session so it resumes its work.",
      parameters: {
        type: "object",
        properties: { childId: { type: "string", description: "Managed child session id." } },
        required: ["childId"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const parentId = parentAgentId(ctx);
        if (!parentId) return { ok: false, content: "managed_child_wake requires a parent agent - this run has no agent identity" };
        const childId = str(args, "childId").trim();
        if (!managedSessions.wake(childId)) return { ok: false, content: `managed child ${childId} is not sleeping` };
        return { ok: true, content: `managed child ${childId} is now running` };
      },
    },
    {
      name: "managed_child_terminate",
      description: "Terminate a managed child session immediately. The child stops and you are woken by a finish event with status terminated.",
      parameters: {
        type: "object",
        properties: { childId: { type: "string", description: "Managed child session id." } },
        required: ["childId"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const parentId = parentAgentId(ctx);
        if (!parentId) return { ok: false, content: "managed_child_terminate requires a parent agent - this run has no agent identity" };
        const childId = str(args, "childId").trim();
        if (!managedSessions.terminate(childId)) return { ok: false, content: `managed child ${childId} is not active` };
        return { ok: true, content: `terminated managed child ${childId}` };
      },
    },
    {
      name: "managed_child_answer",
      description: "Answer a managed child session that asked for input (a needs_input wake event). The child resumes with your answer.",
      parameters: {
        type: "object",
        properties: {
          childId: { type: "string", description: "Managed child session id." },
          answer: { type: "string", description: "Answer to the child's question." },
        },
        required: ["childId", "answer"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const parentId = parentAgentId(ctx);
        if (!parentId) return { ok: false, content: "managed_child_answer requires a parent agent - this run has no agent identity" };
        const childId = str(args, "childId").trim();
        const answer = str(args, "answer");
        if (!managedSessions.answerInput(childId, answer)) return { ok: false, content: `managed child ${childId} is not waiting for input` };
        return { ok: true, content: `answered managed child ${childId}` };
      },
    },
    {
      name: "managed_child_status",
      description: "List this agent's managed child sessions with their status, budget usage and pending questions.",
      parameters: { type: "object", properties: {} },
      async run(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const parentId = parentAgentId(ctx);
        if (!parentId) return { ok: false, content: "managed_child_status requires a parent agent - this run has no agent identity" };
        const children = managedSessions.list(parentId);
        if (children.length === 0) return { ok: true, content: "(no managed child sessions)" };
        const lines = children.map((c) => {
          const budget = c.budget;
          const parts = [`- ${c.id} agent=${c.childAgentId} status=${c.status} steps=${c.steps}${budget.maxSteps ? `/${budget.maxSteps}` : ""} tokens=${c.tokens}${budget.maxTokens ? `/${budget.maxTokens}` : ""}`];
          if (c.output) parts.push(`output=${c.output.slice(0, 200)}`);
          if (c.error) parts.push(`error=${c.error}`);
          const question = managedSessions.pendingQuestion(c.id);
          if (question) parts.push(`question=${question}`);
          return parts.join(" ");
        });
        return { ok: true, content: lines.join("\n") };
      },
    },
    {
      name: "managed_child_events",
      description: "Return and clear the wake events for this agent (child finished or asked for input). Use it after being woken to learn what happened.",
      parameters: { type: "object", properties: {} },
      async run(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const parentId = parentAgentId(ctx);
        if (!parentId) return { ok: false, content: "managed_child_events requires a parent agent - this run has no agent identity" };
        const events = wakeLog.get(parentId) ?? [];
        wakeLog.delete(parentId);
        if (events.length === 0) return { ok: true, content: "(no pending wake events)" };
        const lines = events.map((e) => {
          if (e.type === "needs_input") return `- needs_input child=${e.childId} question=${e.question ?? ""}`;
          return `- finish child=${e.childId} status=${e.status ?? ""}${e.output ? ` output=${e.output.slice(0, 200)}` : ""}${e.error ? ` error=${e.error}` : ""}`;
        });
        return { ok: true, content: lines.join("\n") };
      },
    },
    {
      name: "schedule_self_reminder",
      description:
        "Schedule a one-shot reminder for this coordinator agent. When the time arrives the scheduler starts a fresh run for this agent with the reminder prompt, waking it without polling.",
      parameters: {
        type: "object",
        properties: {
          at: { type: "string", description: "ISO time for the reminder (e.g. 2026-10-22T09:00)." },
          prompt: { type: "string", description: "What the coordinator should do when reminded." },
        },
        required: ["at", "prompt"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const parentId = parentAgentId(ctx);
        if (!parentId) return { ok: false, content: "schedule_self_reminder requires a parent agent - this run has no agent identity" };
        const at = str(args, "at").trim();
        const prompt = str(args, "prompt").trim();
        if (!at || !prompt) return { ok: false, content: "schedule_self_reminder requires both at and prompt" };
        try {
          const { id } = managedSessions.scheduleSelfReminder(parentId, at, prompt);
          return { ok: true, content: `scheduled self reminder ${id} for ${at}` };
        } catch (err) {
          return { ok: false, content: `schedule_self_reminder failed: ${errorText(err)}` };
        }
      },
    },
  ];
}
