import type { Config } from "../config.js";
import type { ChatMessage, ChatResult, OllamaClient } from "../ollama.js";
import type { PlanStepInfo, Usage } from "./events.js";
import { log } from "../log.js";
import { chatWithFallback } from "./model.js";
import { isCancelledError } from "../server/runControl.js";

export interface Plan {
  goal: string;
  trivial: boolean;
  steps: PlanStepInfo[];
  source: "model" | "fallback";
}

export interface PlanResult {
  plan: Plan;
  model: string;
  usage: Usage;
}

export interface PlannerOptions {
  cfg: Config;
  ollama: OllamaClient;
  prompt: string;
  history?: ChatMessage[];
  availableTools?: string[];
  maxPlanSteps: number;
  /** Planner model override ("" = main model). */
  model?: string;
  memories?: Array<{ text: string; score: number }>;
  signal?: AbortSignal;
}

export const PLANNER_SYSTEM = [
  "You are the planner role in a planner/executor/verifier agent system running on the user's computer.",
  "Turn the user's request into a short ordered execution plan: atomic steps an executor agent can carry out with tools, each checkable by a verifier.",
  "",
  "Output rules:",
  "- Reply with JSON only, no markdown fences, no commentary.",
  '- Schema: {"goal": "<one sentence>", "trivial": <true|false>, "steps": [{"id": "s1", "title": "<short>", "instruction": "<what the executor must do>", "success_criteria": "<observable evidence of completion>"}]}',
  "- Use 2 to 6 steps for real tasks; never more than needed.",
  "- Plan only operations possible with AVAILABLE TOOLS. Do not require shell, grep, browser actions, or external services when those tools are absent.",
  "- Source files and app-verification.json belong in the TASK WORKSPACE. File tools resolve relative paths there. Do not invent another project root or write source files to a container path on the host.",
  "- For isolated Node application verification, /app is the readonly copy of workspace source INSIDE Docker; /tmp is writable runtime data INSIDE Docker, not the host project directory. A requested /tmp database path belongs in generated server code, not in file_write paths. Use workspace-relative index.html, server.mjs and app-verification.json for creation.",
  "- Generated browser apps receive mandatory independent runtime and visual checks from app-verification.json after execution. Include an acceptance contract covering the requested workflows; do not substitute exhaustive line-by-line source narration for these checks.",
  "- The LAST step must produce the complete final answer for the user (result, files, paths).",
  '- A loam_mobile request limited to the supported screen schema (text, inputs, toggles, navigation) is one coherent studio edit: set trivial=true and use one step that reads the current revision, replaces the project once, and checks the returned project. Preserve the requested display language. Do not split each screen or each read/write into separate steps. Requests for native builds, backend services or advanced application logic still need a normal implementation and verification plan.',
  '- Set "trivial": true and use exactly ONE step only when the request is a simple single-action task (a greeting, one quick answer, reading one value) OR when the request invokes a self-contained studio/builder tool (super_swarm, office_craft, rork_build, lovable_studio, metagpt_company, studio_blender, game_build, presentation_build, mirofish_chat) to generate a new package/app from scratch.',
  '- When calling a studio/builder tool (like office_craft, super_swarm, rork_build, lovable_studio), do NOT add preliminary steps to search the disk or inspect files first — call the studio tool directly in step s1.',
  '- Instructions must be concrete: files, commands, sources. No meta-work like "understand the task".',
  "- Write goal, titles, instructions and success criteria in the user's language.",
].join("\n");

/** Extract the first JSON value from model output: raw JSON, fenced block, or balanced braces. */
export function extractJson(text: string): unknown | null {
  const t = text.trim();
  const tryParse = (s: string): unknown | null => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  const direct = tryParse(t);
  if (direct !== null) return direct;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence && fence[1]) {
    const inner = tryParse(fence[1].trim());
    if (inner !== null) return inner;
  }
  const start = t.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < t.length; i++) {
      const ch = t[i]!;
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const candidate = tryParse(t.slice(start, i + 1));
          if (candidate !== null) return candidate;
        }
      }
    }
  }
  return null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Normalize a parsed plan object; returns null when no usable step exists. */
export function normalizePlan(value: unknown, prompt: string, maxPlanSteps: number): Plan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const rawSteps = Array.isArray(obj["steps"]) ? obj["steps"] : [];
  const steps: PlanStepInfo[] = [];
  for (const item of rawSteps) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const s = item as Record<string, unknown>;
    const instruction = str(s["instruction"]) || str(s["task"]) || str(s["description"]);
    if (!instruction) continue;
    steps.push({
      id: str(s["id"]) || `s${steps.length + 1}`,
      title: str(s["title"]) || instruction.slice(0, 60),
      instruction,
      successCriteria:
        str(s["success_criteria"]) || str(s["successCriteria"]) || str(s["criteria"]) || str(s["success"]),
    });
  }
  if (steps.length === 0) return null;
  const capped = steps.slice(0, Math.max(1, maxPlanSteps));
  for (const s of capped) {
    if (!s.successCriteria) s.successCriteria = "the step's result is present and consistent with the instruction";
  }
  const goal = str(obj["goal"]) || (prompt.split(/\r?\n/)[0] ?? "").slice(0, 120) || prompt.slice(0, 120);
  const trivial = obj["trivial"] === true && capped.length === 1;
  return { goal, trivial, steps: capped, source: "model" };
}

/** Single-step fallback plan; subject to the same mandatory verification. */
export function fallbackPlan(prompt: string): Plan {
  return {
    goal: (prompt.split(/\r?\n/)[0] ?? "").slice(0, 120) || prompt.slice(0, 120),
    trivial: true,
    source: "fallback",
    steps: [
      {
        id: "s1",
        title: "Direct execution",
        instruction: prompt,
        successCriteria: "the user's request is fulfilled as described",
      },
    ],
  };
}

/** Plan a task with one model call; degrades to a single-step fallback plan on any failure. */
export async function planTask(o: PlannerOptions): Promise<PlanResult> {
  const user = [
    "TASK WORKSPACE (host source files):",
    o.cfg.workspace,
    "",
    "USER REQUEST:",
    o.prompt,
    ...(o.availableTools ? ["", "AVAILABLE TOOLS:", o.availableTools.join(", ")] : []),
    ...(o.memories && o.memories.length > 0
      ? ["", "USEFUL MEMORIES:", ...o.memories.map((m) => `- ${m.text.slice(0, 300)}`)]
      : []),
    "",
    "Return the JSON plan now.",
  ].join("\n");

  let res: ChatResult | null = null;
  try {
    res = await chatWithFallback({
      cfg: o.cfg,
      ollama: o.ollama,
      messages: [
        { role: "system", content: PLANNER_SYSTEM },
        ...(o.history ?? []),
        { role: "user", content: user },
      ],
      temperature: 0.1,
      ...(o.model ? { model: o.model } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
    });
  } catch (err) {
    // Cancellation must stop the whole run — never fall back to a plan and keep going.
    if (o.signal?.aborted || isCancelledError(err)) throw err instanceof Error ? err : new Error(String(err));
    log.warn(`planner failed: ${err instanceof Error ? err.message : String(err)}; using single-step fallback plan`);
  }

  if (res) {
    const normalized = normalizePlan(extractJson(res.content), o.prompt, o.maxPlanSteps);
    if (normalized) return { plan: normalized, model: res.model, usage: res.usage };
    log.warn("planner: unparseable output; using single-step fallback plan");
    return { plan: fallbackPlan(o.prompt), model: res.model, usage: res.usage };
  }
  return {
    plan: fallbackPlan(o.prompt),
    model: o.cfg.model,
    usage: { promptTokens: 0, completionTokens: 0, durationMs: 0 },
  };
}
