import type { Config } from "../config.js";
import type { ChatMessage, OllamaClient } from "../ollama.js";
import type { PlanStepInfo, ToolTraceItem, Usage, Verdict, VerdictInfo } from "./events.js";
import { log } from "../log.js";
import { chatWithFallback } from "./model.js";
import { extractJson } from "./planner.js";
import { isCancelledError } from "../server/runControl.js";

export interface VerdictOutcome extends VerdictInfo {
  model: string;
  usage: Usage;
}

export interface ParsedVerdict extends VerdictInfo {
  parsed: boolean;
}

const VERIFIER_RULES = [
  "You are the verifier role in a planner/executor/verifier agent system (the critic of an actor-critic loop).",
  "You judge work by observable evidence (files, tool output, command results), never by the executor's confidence.",
  "Reply with JSON only, no markdown fences:",
  '{"verdict": "pass|revise|fail", "reason": "<one or two sentences>", "fixes": ["<concrete fix>", "..."]}',
  "Rules:",
  "- pass: the criteria are met and the evidence confirms it.",
  "- revise: incomplete, wrong, or unverified but fixable; fixes must be concrete actions for the executor.",
  "- fail: impossible, blocked, or the plan/approach itself is wrong (replanning is needed).",
  "- If the evidence is silent on something essential, do not pass; ask for it with revise.",
  "- Write reason and fixes in the user's language.",
].join("\n");

export const CRITIC_SYSTEM = ["You judge ONE executed plan step of the task.", VERIFIER_RULES].join("\n\n");

export const VERIFY_SYSTEM = ["You judge the COMPLETED task as a whole against the user's original request.", VERIFIER_RULES].join(
  "\n\n",
);

const PASS_WORDS = new Set([
  "pass",
  "passed",
  "ok",
  "done",
  "success",
  "successful",
  "complete",
  "completed",
  "yes",
  "true",
  "accept",
  "accepted",
  "satisfied",
  "verified",
]);
const REVISE_WORDS = new Set([
  "revise",
  "revision",
  "retry",
  "fix",
  "fixes",
  "partial",
  "partially",
  "incomplete",
  "improve",
  "needs_revision",
  "needs_fix",
  "needs revision",
  "needs fix",
  "unverified",
  "maybe",
]);
const FAIL_WORDS = new Set(["fail", "failed", "no", "false", "impossible", "blocked", "reject", "rejected", "error", "stuck", "wrong"]);

function mapVerdict(raw: string): Verdict | null {
  const v = raw.trim().toLowerCase().replace(/[.!]+$/g, "");
  if (!v) return null;
  if (PASS_WORDS.has(v)) return "pass";
  if (REVISE_WORDS.has(v)) return "revise";
  if (FAIL_WORDS.has(v)) return "fail";
  if (/\b(not|no|never)\b/.test(v) && /pass|satisf|verified|complete|done|ok/.test(v)) return "revise";
  if (/revis|retry|fix|incomplete/.test(v)) return "revise";
  if (/fail|impossible|blocked/.test(v)) return "fail";
  return null;
}

function scanWords(text: string): string {
  const lower = text.toLowerCase();
  if (/\b(fail|failed|impossible|blocked)\b/.test(lower)) return "fail";
  if (/\b(revise|revision|retry|incomplete|unverified)\b/.test(lower)) return "revise";
  if (/\bnot\s+(complete|completed|done|satisfied|ok|verified)\b/.test(lower)) return "revise";
  if (/\bneeds?\s+(fix|fixes|work|revision)\b/.test(lower)) return "revise";
  if (/\b(pass|passed|complete|completed|satisfied|verified)\b/.test(lower)) return "pass";
  return "";
}

function firstString(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return "";
}

function toFixes(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((s) => s.length > 0).slice(0, 8);
  if (typeof v === "string" && v.trim().length > 0) return [v.trim()];
  return [];
}

/** Missing or ambiguous evidence must never certify success. */
export function parseVerdict(content: string): ParsedVerdict {
  const json = extractJson(content);
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const obj = json as Record<string, unknown>;
    const mapped = mapVerdict(firstString(obj["verdict"], obj["result"], obj["status"], obj["decision"]));
    if (mapped) {
      return {
        verdict: mapped,
        reason: firstString(obj["reason"], obj["explanation"], obj["analysis"], obj["summary"]) || "(no reason given)",
        fixes: toFixes(obj["fixes"] ?? obj["required_fixes"] ?? obj["issues"] ?? obj["feedback"]),
        parsed: true,
      };
    }
  }
  const scanned = scanWords(content);
  if (scanned) {
    const mapped = mapVerdict(scanned);
    if (mapped && mapped !== "pass") {
      return { verdict: mapped, reason: content.trim().replace(/\s+/g, " ").slice(0, 300), fixes: [], parsed: false };
    }
  }
  return {
    verdict: "revise",
    reason: `(unverified: invalid verifier output) ${content.trim().replace(/\s+/g, " ").slice(0, 200)}`,
    fixes: [],
    parsed: false,
  };
}

export function formatTrace(trace: ToolTraceItem[], limit = 25): string {
  if (trace.length === 0) return "(no tools were used)";
  return trace
    .slice(-limit)
    .map((t) => `- ${t.ok ? "ok" : "FAIL"} ${t.name}${t.ms !== undefined ? ` (${t.ms}ms)` : ""}: ${t.summary.replace(/\s+/g, " ").slice(0, 200)}`)
    .join("\n");
}

async function callVerifier(
  cfg: Config,
  ollama: OllamaClient,
  system: string,
  user: string,
  model: string | undefined,
  signal: AbortSignal | undefined,
  what: string,
  history: ChatMessage[] = [],
): Promise<VerdictOutcome> {
  try {
    const res = await chatWithFallback({
      cfg,
      ollama,
      messages: [
        { role: "system", content: system },
        ...history,
        { role: "user", content: user },
      ],
      temperature: 0.05,
      ...(model ? { model } : {}),
      ...(signal ? { signal } : {}),
    });
    const parsed = parseVerdict(res.content);
    if (!parsed.parsed) log.warn(`verifier (${what}): unparseable output; defaulting to ${parsed.verdict}`);
    return { verdict: parsed.verdict, reason: parsed.reason, fixes: parsed.fixes, model: res.model, usage: res.usage };
  } catch (err) {
    // Cancellation aborts the whole run — never "default to pass" and keep executing.
    if (signal?.aborted || isCancelledError(err)) throw err instanceof Error ? err : new Error(String(err));
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`verifier (${what}) failed: ${msg}; verification required`);
    return {
      verdict: "revise",
      reason: `(verifier unavailable: ${msg})`,
      fixes: [],
      model: cfg.model,
      usage: { promptTokens: 0, completionTokens: 0, durationMs: 0 },
    };
  }
}

export interface CritiqueOptions {
  history?: ChatMessage[];
  cfg: Config;
  ollama: OllamaClient;
  goal: string;
  request: string;
  step: PlanStepInfo;
  stepIndex: number;
  totalSteps: number;
  attempt: number;
  maxAttempts: number;
  workerText: string;
  trace: ToolTraceItem[];
  model?: string;
  signal?: AbortSignal;
}

export async function critiqueStep(o: CritiqueOptions): Promise<VerdictOutcome> {
  const user = [
    "ORIGINAL USER REQUEST:",
    o.request.slice(0, 1500),
    "",
    `PLAN GOAL: ${o.goal}`,
    "",
    `STEP ${o.stepIndex + 1}/${o.totalSteps}: ${o.step.title}`,
    `INSTRUCTION: ${o.step.instruction}`,
    `SUCCESS CRITERIA: ${o.step.successCriteria}`,
    "",
    `EXECUTOR ATTEMPT ${o.attempt}/${o.maxAttempts} FINAL MESSAGE:`,
    o.workerText.slice(0, 3000) || "(empty)",
    "",
    "TOOL EVIDENCE:",
    formatTrace(o.trace),
    "",
    "Judge this step now.",
  ].join("\n");
  return callVerifier(o.cfg, o.ollama, CRITIC_SYSTEM, user, o.model, o.signal, `step ${o.step.id}`, o.history);
}

export interface FinalVerifyOptions {
  history?: ChatMessage[];
  cfg: Config;
  ollama: OllamaClient;
  request: string;
  goal: string;
  finalText: string;
  completedSteps: string[];
  trace: ToolTraceItem[];
  model?: string;
  signal?: AbortSignal;
}

export async function verifyFinal(o: FinalVerifyOptions): Promise<VerdictOutcome> {
  const user = [
    "ORIGINAL USER REQUEST:",
    o.request.slice(0, 1500),
    "",
    `PLAN GOAL: ${o.goal}`,
    "",
    "COMPLETED STEPS:",
    o.completedSteps.length > 0 ? o.completedSteps.map((c) => `- ${c}`).join("\n") : "(none)",
    "",
    "FINAL ANSWER:",
    o.finalText.slice(0, 3000) || "(empty)",
    "",
    "TOOL EVIDENCE:",
    formatTrace(o.trace),
    "",
    "Does the final answer fully satisfy the original request? Judge now.",
  ].join("\n");
  return callVerifier(o.cfg, o.ollama, VERIFY_SYSTEM, user, o.model, o.signal, "final", o.history);
}
