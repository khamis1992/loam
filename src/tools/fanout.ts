/**
 * Neo N7: the `fanout` tool.
 *
 * The agent-facing door onto `runFanout`. It decomposes the caller's request
 * into N independent branches (N prompts, or N models over one prompt), runs them
 * as child subagents in parallel under the process-wide child semaphore, and
 * merges their results into one answer.
 *
 * The core is model-free and testable; this file only binds it to the live
 * runtime (the agent loop for the branch runs, the model for the merge) and to
 * the run graph.
 */

import type { Emit } from "../agent/events.js";
import { runAgent } from "../agent/loop.js";
import {
  FANOUT_DEFAULT_BRANCHES,
  FANOUT_MAX_BRANCHES,
  normalizeBranches,
  runFanout,
  type FanoutBranchSpec,
} from "../agent/fanout.js";
import type { OllamaClient } from "../ollama.js";
import type { Tool, ToolContext, ToolResult, ToolRegistry } from "./registry.js";
import { num, str } from "./registry.js";

/** Tools a fan-out branch may use. Deliberately narrow and never wider than the
 *  run that called `fanout` (the parent run's own allowlist is intersected). */
export const FANOUT_CHILD_TOOLS: readonly string[] = [
  "file_read",
  "file_list",
  "file_search",
  "file_stat",
  "file_write",
  "file_edit",
  "shell_run",
  "web_search",
  "web_fetch",
];

const MIN_BRANCHES = 2;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

/** Build the branch specs for the N-prompts variant. */
export function branchesFromPrompts(prompts: string[]): FanoutBranchSpec[] {
  return prompts.map((prompt, index) => ({ index, prompt, label: prompt }));
}

/** Build the branch specs for the N-models variant (one prompt, N models). */
export function branchesFromModels(prompt: string, models: string[]): FanoutBranchSpec[] {
  return models.map((model, index) => ({ index, prompt, model, label: model }));
}

/** Prompt handed to one branch child. */
export function buildBranchPrompt(goal: string, branch: FanoutBranchSpec): string {
  const scope = branch.label && branch.label !== branch.prompt ? `BRANCH: ${branch.label}` : "";
  return [
    `GOAL: ${goal}`,
    "",
    scope,
    "You are one independent branch of a parallel fan-out. You never see the other branches' work. "
      + "Complete ONLY your assigned instruction, using the tools available to you.",
    "",
    "YOUR INSTRUCTION:",
    branch.prompt,
    "",
    "Reply with your result only: concrete, evidence-grounded, and complete enough that a "
      + "caller who never saw your conversation can use it directly.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** Prompt handed to the merge step. */
export function buildMergePrompt(goal: string, branches: readonly { index: number; ok: boolean; text: string; error?: string }[]): string {
  const lines = [
    `GOAL: ${goal}`,
    "",
    "You are the merge step of a parallel fan-out. Below are the independent results of every branch.",
    "Merge them into ONE coherent answer to the goal.",
    "",
    "Rules:",
    "- keep every distinct fact; do not add facts that are not in the branch results;",
    "- keep each branch's own wording where it is the clearest statement of a fact;",
    "- resolve disagreements explicitly instead of silently picking one;",
    "- if a branch failed, say so and continue with the branches that succeeded;",
    "- write in the language of the goal; reply with the merged answer only.",
    "",
    "BRANCH RESULTS:",
  ];
  for (const branch of branches) {
    lines.push(`--- branch ${branch.index + 1} (${branch.ok ? "ok" : "failed"}) ---`);
    lines.push(branch.ok ? branch.text.trim() : branch.error ?? "(no result)");
  }
  return lines.join("\n");
}

export interface FanoutToolOptions {
  ollama: OllamaClient;
  parentRegistry: ToolRegistry;
  /** Max steps per branch child. */
  maxSteps?: number;
  /** Tool allowlist for branch children. */
  childAllowTools?: string[];
}

function resolveChildAllowlist(parentRegistry: ToolRegistry, requested: readonly string[], runAllowed: readonly string[] | undefined): string[] {
  const registered = new Set(parentRegistry.names());
  const allowed = runAllowed ? new Set(runAllowed) : null;
  return requested.filter((name) => registered.has(name) && (!allowed || allowed.has(name)));
}

/** Build the `fanout` tool. */
export function createFanoutTool(options: FanoutToolOptions): Tool {
  const { ollama, parentRegistry } = options;
  const maxSteps = clamp(options.maxSteps ?? 12, 1, 30);
  const childAllowTools = options.childAllowTools ?? FANOUT_CHILD_TOOLS;

  return {
    name: "fanout",
    description:
      "Run N independent branches of work in parallel child agents and merge their results into one answer. "
      + "Each branch gets a fresh context and its own subtree on the canvas, so the work never floods your own context. "
      + "Use the `prompts` variant to decompose a task into N independent instructions (one branch each), or the `models` "
      + "variant to run the SAME instruction under several models and compare. "
      + "Prefer it when the work splits into independent streams that would each take many steps; use your own tools "
      + "directly for a single lookup.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["goal"],
      properties: {
        goal: {
          type: "string",
          minLength: 1,
          description: "The goal the merged answer must satisfy.",
        },
        prompts: {
          type: "array",
          minItems: MIN_BRANCHES,
          maxItems: FANOUT_MAX_BRANCHES,
          items: { type: "string", minLength: 1 },
          description: `Explicit branch instructions: one child agent per prompt (${MIN_BRANCHES}-${FANOUT_MAX_BRANCHES}). Use for a decomposition you already chose.`,
        },
        models: {
          type: "array",
          minItems: MIN_BRANCHES,
          maxItems: FANOUT_MAX_BRANCHES,
          items: { type: "string", minLength: 1 },
          description: `Model names to run the SAME ` + "`instruction`" + ` under, one branch each (${MIN_BRANCHES}-${FANOUT_MAX_BRANCHES}).`,
        },
        instruction: {
          type: "string",
          minLength: 1,
          description: "The single instruction every model branch runs (required with `models`).",
        },
        branches: {
          type: "integer",
          minimum: MIN_BRANCHES,
          maximum: FANOUT_MAX_BRANCHES,
          default: FANOUT_DEFAULT_BRANCHES,
          description: `How many branches to run when neither ` + "`prompts`" + ` nor ` + "`models`" + ` is given (the goal is decomposed for you).`,
        },
      },
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const goal = str(args, "goal").trim();
      if (!goal) return { ok: false, content: "fanout requires a goal" };

      const prompts = normalizeBranches(args.prompts);
      const models = normalizeBranches(args.models);
      const instruction = str(args, "instruction").trim();

      let specs: FanoutBranchSpec[];
      if (prompts.length > 0) {
        specs = branchesFromPrompts(prompts);
      } else if (models.length > 0) {
        if (!instruction) return { ok: false, content: "fanout with `models` requires an `instruction`" };
        specs = branchesFromModels(instruction, models);
      } else {
        // No decomposition given: the goal itself becomes one branch per requested
        // count, each asked to cover a distinct independent angle of the goal.
        const count = clamp(num(args, "branches", FANOUT_DEFAULT_BRANCHES), MIN_BRANCHES, FANOUT_MAX_BRANCHES);
        specs = Array.from({ length: count }, (_, index) => ({
          index,
          prompt: `Answer the goal from one independent angle and report your findings for it.\n\nGOAL: ${goal}\nANGLE: pass ${index + 1} of ${count}`,
          label: `angle ${index + 1}`,
        }));
      }

      const fanoutId = `fanout-${ctx.taskId ?? "anon"}-${specs.length}-${Date.now().toString(36)}`;
      ctx.emit({ type: "tool_call", name: "fanout", args: { goal, branches: specs.length } });

      const allow = resolveChildAllowlist(parentRegistry, childAllowTools, ctx.allowedTools);
      const childRegistry = parentRegistry.forAllowlist(allow);
      const emit: Emit = ctx.emit;

      const report = await runFanout({
        runId: ctx.taskId ?? "anon",
        fanoutId,
        goal,
        branches: specs,
        emit,
        signal: ctx.signal,
        ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
        runner: async (branch, bctx) => {
          let toolCalls = 0;
          const res = await runAgent({
            cfg: ctx.cfg,
            ollama,
            tools: childRegistry,
            emit: (ev) => {
              if (ev.type === "tool_call") toolCalls += 1;
              emit(ev);
            },
            prompt: buildBranchPrompt(goal, branch),
            ...(branch.model ? { model: branch.model } : {}),
            systemSuffix:
              "[Fan-out branch]\nYou are one independent branch of a parallel fan-out. You never see the other branches' work. "
              + "Do not delegate further subagents. Report your result concisely and completely.",
            maxSteps,
            signal: bctx.signal ?? ctx.signal,
            taskId: ctx.taskId,
            suppressFinal: true,
          });
          return { ok: true, text: res.text, steps: res.steps, toolCalls };
        },
        merger: async (input, bctx) => {
          const res = await runAgent({
            cfg: ctx.cfg,
            ollama,
            tools: parentRegistry.forAllowlist([]),
            emit: () => {
              /* the merge is silent */
            },
            prompt: buildMergePrompt(input.goal, input.branches),
            systemSuffix:
              "[Fan-out merge]\nYou merge independent branch results into one answer. You never invent facts.",
            maxSteps,
            signal: bctx.signal ?? ctx.signal,
            taskId: ctx.taskId,
            suppressFinal: true,
          });
          return res.text.trim();
        },
      });

      ctx.emit({
        type: "tool_result",
        name: "fanout",
        ok: report.ok,
        summary: `fan-out finished: ${report.branches.length - report.failedIndexes.length}/${report.branches.length} branch(es) merged`,
      });

      return {
        ok: report.ok,
        content: JSON.stringify(
          {
            goal,
            branches: report.branches.map((branch) => ({
              index: branch.index,
              ok: branch.ok,
              nodeId: branch.nodeId,
              steps: branch.steps,
              toolCalls: branch.toolCalls,
              result: branch.text,
              ...(branch.error ? { error: branch.error } : {}),
            })),
            failedIndexes: report.failedIndexes,
            mergeNodeId: report.mergeNodeId,
            summary: report.summary,
          },
          null,
          2,
        ),
      };
    },
  };
}
