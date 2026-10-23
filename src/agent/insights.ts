/**
 * Session insights (post-mortem) — D18.
 *
 * After a session ends (or on demand) turn its recorded event log into a short,
 * actionable report: exact metrics (steps, tokens, cost, user messages,
 * duration, category), an issue timeline (errors, failed tool calls, retries and
 * stalls in the order they happened), knowledge/memory usage, actionable
 * feedback and an improved prompt for the next run.
 *
 * Everything here is deterministic and model-free: `computeInsights` never calls
 * a model and is the exact source of truth for the metrics and the timeline.
 * `generateInsights` optionally asks a model to enrich the feedback and the
 * improved prompt, falling back to the deterministic result on any failure.
 */
import type { AgentEvent } from "./events.js";
import { detectModeFromText } from "../modes/detect.js";

/** One recorded event with the timestamp the recorder stored for it. */
export interface TimedAgentEvent {
  at: string;
  event: AgentEvent;
}

export type IssueKind = "error" | "failure" | "retry" | "stall";

export interface IssueEvent {
  kind: IssueKind;
  /** Position of the source event in the recorded log (0-based). */
  index: number;
  at: string;
  detail: string;
  /** Tool or step the issue belongs to, when known. */
  tool?: string;
}

export interface InsightsMetrics {
  steps: number;
  toolCalls: number;
  toolFailures: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Estimated cost in USD from the model pricing table (0 for unknown/local models). */
  costUsd: number;
  userMessages: number;
  assistantMessages: number;
  durationMs: number;
  category: string;
  model: string;
}

export interface KnowledgeUsage {
  /** Memory entries that were injected into the run's context. */
  memories: number;
  /** Skills that were available/used. */
  skills: number;
  memoryToolCalls: number;
  skillToolCalls: number;
}

export interface SessionInsights {
  taskId: string;
  generatedAt: string;
  metrics: InsightsMetrics;
  issueTimeline: IssueEvent[];
  knowledgeUsage: KnowledgeUsage;
  actionableFeedback: string[];
  improvedPrompt: string | null;
}

export interface InsightsInput {
  taskId: string;
  prompt: string;
  status: string;
  model?: string;
  /** Overrides the offline category detection (mode id). */
  category?: string;
  startedAt?: string;
  endedAt?: string;
  events: TimedAgentEvent[];
  messages?: Array<{ role: string; content: string }>;
  usage?: { promptTokens: number; completionTokens: number };
  /** Explicit step count; defaults to the `done` event, then `step` events. */
  steps?: number;
  /** Memory entries injected into the run. */
  memories?: number;
  /** Skills available to the run. */
  skills?: number;
  /** Idle gap (ms) between two recorded events that counts as a stall. */
  stallThresholdMs?: number;
}

/** Default idle gap that counts as a stall (90s). */
export const DEFAULT_STALL_THRESHOLD_MS = 90_000;

const MEMORY_TOOLS = new Set(["memory_store", "memory_search", "memory_list", "memory_forget", "memory_update", "recall"]);
const SKILL_TOOLS = new Set(["skill_list", "skill_view", "skill_create", "skill_patch", "skill_search", "skill_install"]);

interface ModelPrice {
  match: RegExp;
  /** USD per 1M input (prompt) tokens. */
  inputPerMtok: number;
  /** USD per 1M output (completion) tokens. */
  outputPerMtok: number;
}

/**
 * Small, explicit pricing table for the models users actually run through the
 * cloud/flex boundary. Unknown or local Ollama models cost 0 — Loam never
 * guesses a price it cannot defend, it reports 0 instead.
 */
export const MODEL_PRICING: ModelPrice[] = [
  { match: /^gpt-4o$/i, inputPerMtok: 2.5, outputPerMtok: 10 },
  { match: /^gpt-4o-mini$/i, inputPerMtok: 0.15, outputPerMtok: 0.6 },
  { match: /^gpt-4\.1$/i, inputPerMtok: 2, outputPerMtok: 8 },
  { match: /^gpt-4\.1-mini$/i, inputPerMtok: 0.4, outputPerMtok: 1.6 },
  { match: /^o[34](-|$)/i, inputPerMtok: 2, outputPerMtok: 8 },
  { match: /^claude-3\.5-sonnet/i, inputPerMtok: 3, outputPerMtok: 15 },
  { match: /^claude-3\.5-haiku/i, inputPerMtok: 0.8, outputPerMtok: 4 },
  { match: /^claude-sonnet-4/i, inputPerMtok: 3, outputPerMtok: 15 },
  { match: /^gemini-2\.0-flash$/i, inputPerMtok: 0.1, outputPerMtok: 0.4 },
  { match: /^gemini-2\.5-pro$/i, inputPerMtok: 1.25, outputPerMtok: 10 },
  { match: /^deepseek-chat$/i, inputPerMtok: 0.27, outputPerMtok: 1.1 },
  { match: /^deepseek-reasoner$/i, inputPerMtok: 0.55, outputPerMtok: 2.19 },
];

/** Estimated USD cost for a model/token pair; 0 for unknown or local models. */
export function estimateCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const name = model.replace(/:cloud$/i, "").trim();
  const price = MODEL_PRICING.find((p) => p.match.test(name));
  if (!price) return 0;
  return (promptTokens / 1_000_000) * price.inputPerMtok + (completionTokens / 1_000_000) * price.outputPerMtok;
}

function parseTs(at: string | undefined): number | null {
  if (!at) return null;
  const t = Date.parse(at);
  return Number.isFinite(t) ? t : null;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** The deterministic core: metrics + issue timeline + knowledge usage. */
export function computeInsights(input: InsightsInput): SessionInsights {
  const events = input.events;
  const threshold = input.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;

  let toolCalls = 0;
  let toolFailures = 0;
  let retries = 0;
  let errorCount = 0;
  let memoryToolCalls = 0;
  let skillToolCalls = 0;
  let doneSteps: number | undefined;
  let doneModel: string | undefined;
  const issueTimeline: IssueEvent[] = [];

  for (let i = 0; i < events.length; i++) {
    const { at, event } = events[i]!;
    switch (event.type) {
      case "tool_call": {
        toolCalls += 1;
        if (MEMORY_TOOLS.has(event.name)) memoryToolCalls += 1;
        if (SKILL_TOOLS.has(event.name)) skillToolCalls += 1;
        break;
      }
      case "tool_result": {
        if (!event.ok) {
          toolFailures += 1;
          issueTimeline.push({
            kind: "failure",
            index: i,
            at,
            detail: `${event.name}: ${event.summary}`.slice(0, 240),
            tool: event.name,
          });
        }
        break;
      }
      case "error": {
        errorCount += 1;
        issueTimeline.push({ kind: "error", index: i, at, detail: event.message.slice(0, 240) });
        break;
      }
      case "revise": {
        retries += 1;
        issueTimeline.push({
          kind: "retry",
          index: i,
          at,
          detail: `step ${event.id} retry #${event.attempt}${event.fixes.length > 0 ? `: ${event.fixes.join("; ")}` : ""}`.slice(0, 240),
          tool: event.id,
        });
        break;
      }
      case "replan": {
        retries += 1;
        issueTimeline.push({
          kind: "retry",
          index: i,
          at,
          detail: `replan round ${event.round}: ${event.reason}`.slice(0, 240),
        });
        break;
      }
      case "done": {
        doneSteps = event.steps;
        doneModel = event.model;
        break;
      }
      default:
        break;
    }

    if (i > 0) {
      const prev = parseTs(events[i - 1]!.at);
      const cur = parseTs(at);
      if (prev !== null && cur !== null && cur - prev > threshold) {
        issueTimeline.push({
          kind: "stall",
          index: i,
          at,
          detail: `idle ${formatDuration(cur - prev)} before ${event.type}`.slice(0, 240),
        });
      }
    }
  }

  issueTimeline.sort((a, b) => a.index - b.index || a.at.localeCompare(b.at));

  const stepEvents = events.filter((e) => e.event.type === "step").length;
  const steps = input.steps ?? doneSteps ?? stepEvents;

  const promptTokens = input.usage?.promptTokens ?? 0;
  const completionTokens = input.usage?.completionTokens ?? 0;
  const model = input.model ?? doneModel ?? "unknown";

  const messages = input.messages ?? [];
  const userMessages = messages.filter((m) => m.role === "user").length;
  const assistantMessages = messages.filter((m) => m.role === "assistant").length;

  const started = parseTs(input.startedAt);
  const ended = parseTs(input.endedAt);
  let durationMs = started !== null && ended !== null ? Math.max(0, ended - started) : 0;
  if (durationMs === 0) {
    const first = parseTs(events[0]?.at);
    const last = parseTs(events.at(-1)?.at);
    if (first !== null && last !== null) durationMs = Math.max(0, last - first);
  }

  const category = input.category ?? detectModeFromText(input.prompt);
  const costUsd = round4(estimateCostUsd(model, promptTokens, completionTokens));

  const feedback = buildFeedback({ steps, toolCalls, toolFailures, retries, errorCount, durationMs, category });
  const improvedPrompt = buildImprovedPrompt(input.prompt, {
    toolFailures,
    retries,
    failures: issueTimeline.filter((i) => i.kind === "failure").map((i) => i.tool ?? i.detail),
  });

  return {
    taskId: input.taskId,
    generatedAt: new Date().toISOString(),
    metrics: {
      steps,
      toolCalls,
      toolFailures,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      costUsd,
      userMessages,
      assistantMessages,
      durationMs,
      category,
      model,
    },
    issueTimeline,
    knowledgeUsage: {
      memories: input.memories ?? 0,
      skills: input.skills ?? 0,
      memoryToolCalls,
      skillToolCalls,
    },
    actionableFeedback: feedback,
    improvedPrompt,
  };
}

function buildFeedback(o: {
  steps: number;
  toolCalls: number;
  toolFailures: number;
  retries: number;
  errorCount: number;
  durationMs: number;
  category: string;
}): string[] {
  const out: string[] = [];
  if (o.steps === 0 && o.toolCalls === 0) out.push("No steps were recorded for this session — nothing to review.");
  if (o.errorCount > 0) out.push(`${o.errorCount} hard error(s) ended or interrupted the run; read the error timeline before retrying.`);
  if (o.toolFailures > 0) out.push(`${o.toolFailures} of ${o.toolCalls} tool call(s) failed — check the failing commands and their arguments.`);
  if (o.retries > 0) out.push(`${o.retries} retry/replan event(s) — the first plan did not hold; tighten the success criteria.`);
  if (o.durationMs > 0) out.push(`${o.category} session ran ${formatDuration(o.durationMs)} over ${o.steps} step(s).`);
  if (out.length === 0) out.push("Session completed cleanly with no recorded issues.");
  return out;
}

function buildImprovedPrompt(prompt: string, o: { toolFailures: number; retries: number; failures: string[] }): string {
  const base = prompt.trim() || "(original prompt unavailable)";
  const notes: string[] = [];
  if (o.failures.length > 0) {
    const unique = [...new Set(o.failures)].slice(0, 3);
    notes.push(`Do not repeat the failed tool call(s): ${unique.join(", ")}.`);
  }
  if (o.retries > 0) notes.push("Verify each step against its success criteria before moving to the next one.");
  if (notes.length === 0) notes.push("Keep the current approach — it completed without recorded issues.");
  return `${base}\n\nNext time:\n${notes.map((n) => `- ${n}`).join("\n")}`;
}

const INSIGHT_SYSTEM = [
  "You are the post-session reviewer for a local autonomous agent.",
  "You receive exact metrics and an issue timeline from a finished session.",
  "Reply with ONLY a JSON object of the shape {\"feedback\": string[], \"improvedPrompt\": string}.",
  "feedback: 1-4 short, actionable sentences grounded in the timeline. improvedPrompt: the original prompt rewritten so the next run avoids the same failure. Never invent facts that are not in the input.",
].join("\n");

function buildModelDigest(insights: SessionInsights, prompt: string): string {
  const timeline = insights.issueTimeline.map((i) => `- [${i.kind}] ${i.detail}`).join("\n") || "(no issues)";
  return [
    "ORIGINAL PROMPT:", prompt.slice(0, 1500), "",
    "METRICS:", JSON.stringify(insights.metrics), "",
    "ISSUE TIMELINE (in order):", timeline, "",
    "KNOWLEDGE USAGE:", JSON.stringify(insights.knowledgeUsage),
  ].join("\n");
}

/** Parse the model's JSON reply; returns null when it is not usable. */
export function parseInsightReply(content: string): { feedback: string[]; improvedPrompt?: string } | null {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
  const obj = parsed as { feedback?: unknown; improvedPrompt?: unknown };
  const feedback = Array.isArray(obj.feedback) ? obj.feedback.map((f) => String(f)).filter((f) => f.trim().length > 0).slice(0, 8) : [];
  const improvedPrompt = typeof obj.improvedPrompt === "string" && obj.improvedPrompt.trim() ? obj.improvedPrompt.trim().slice(0, 4000) : null;
  if (feedback.length === 0 && !improvedPrompt) return null;
  return { feedback, ...(improvedPrompt ? { improvedPrompt } : {}) };
}

export interface GenerateInsightsOptions {
  /** Anything with the OllamaClient `chat` shape; a structural mock is fine. */
  ollama?: { chat(opts: { model: string; messages: Array<{ role: string; content: string }> }): Promise<{ content: string }> };
  model?: string;
}

/** Deterministic insights, optionally enriched by a model. Never throws. */
export async function generateInsights(input: InsightsInput, opts: GenerateInsightsOptions = {}): Promise<SessionInsights> {
  const base = computeInsights(input);
  if (!opts.ollama) return base;
  try {
    const res = await opts.ollama.chat({
      model: opts.model ?? base.metrics.model,
      messages: [
        { role: "system", content: INSIGHT_SYSTEM },
        { role: "user", content: buildModelDigest(base, input.prompt) },
      ],
    });
    const parsed = parseInsightReply(res.content);
    if (!parsed) return base;
    return {
      ...base,
      ...(parsed.feedback.length > 0 ? { actionableFeedback: parsed.feedback } : {}),
      ...(parsed.improvedPrompt ? { improvedPrompt: parsed.improvedPrompt } : {}),
    };
  } catch {
    return base;
  }
}
