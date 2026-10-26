/**
 * C1: progress ledger + stall counter + learning replan.
 *
 * Idea from Microsoft Agent Framework Magentic orchestration (MIT;
 * _magentic.py: ledger :196-262, stall counter :1100-1187, reset and replan
 * :1189-1220). Prompts below are Loam's own wording, not Magentic text.
 * Runs only on a cloud model (llm/cloudModel.ts); never on the local model.
 */
import type { ChatMessage } from "../../ollama.js";
import { callStructured } from "../contracts/structured.js";
import type { JsonSchema } from "../contracts/schema.js";
import type { ModelPort } from "../modelPort.js";
import type { LedgerDecision } from "../events.js";

export interface LedgerEntry {
  satisfied: { value: boolean; reason: string };
  inLoop: { value: boolean; reason: string };
  progressing: { value: boolean; reason: string };
  /** Plan step id the next worker turn should serve, or "replan". */
  nextStepId: string;
  /** One concrete instruction for that worker turn (max 600 chars). */
  instruction: string;
}

/** Persisted inside ExecutionCheckpoint as `ledger` (new optional field). */
export interface LedgerState {
  version: 1;
  facts: string[];
  guesses: string[];
  stallCount: number;
  resetCount: number;
  turns: number;
  lastEntry?: LedgerEntry;
  /** Short history kept for the root-cause replan prompt, newest last, max 8. */
  history: Array<{ turn: number; decision: LedgerDecision; reason: string }>;
}

export const EMPTY_LEDGER: LedgerState = { version: 1, facts: [], guesses: [], stallCount: 0, resetCount: 0, turns: 0, history: [] };

const verdict = (desc: string): JsonSchema => ({
  type: "object",
  required: ["value", "reason"],
  additionalProperties: false,
  properties: { value: { type: "boolean", description: desc }, reason: { type: "string", maxLength: 400 } },
});

export const LEDGER_SCHEMA: JsonSchema = {
  type: "object",
  required: ["satisfied", "inLoop", "progressing", "nextStepId", "instruction"],
  additionalProperties: false,
  properties: {
    satisfied: verdict("The whole request is fully done and verified."),
    inLoop: verdict("Recent turns repeat the same actions or replies."),
    progressing: verdict("The last turns moved the task forward."),
    nextStepId: { type: "string", minLength: 1, maxLength: 80 },
    instruction: { type: "string", minLength: 1, maxLength: 600 },
  },
};

export const FACTS_SCHEMA: JsonSchema = {
  type: "object",
  required: ["facts", "guesses"],
  additionalProperties: false,
  properties: {
    facts: { type: "array", maxItems: 30, items: { type: "string", maxLength: 300 } },
    guesses: { type: "array", maxItems: 15, items: { type: "string", maxLength: 300 } },
  },
};

export interface LedgerContext {
  goal: string;
  planSteps: Array<{ id: string; title: string; status: string }>;
  /** Compact digest of the latest worker turns (tool names, results, text), newest last. */
  recentDigest: string;
  stuckHint?: string;
}

const LEDGER_SYSTEM = [
  "You are the progress auditor of an orchestrated agent run.",
  "You do not do the work. You judge where the run stands and say what the next worker turn must do.",
  "Judge from evidence in the digest only. A claim without a tool result proving it does not count as done.",
  "Report a loop when the same tool calls, errors or replies keep coming back.",
  "Report progress only when a new fact was learned or an artifact changed.",
].join("\n");

export function ledgerMessages(ctx: LedgerContext, st: LedgerState, maxChars: number): ChatMessage[] {
  const plan = ctx.planSteps.map((s) => `- [${s.status}] ${s.id}: ${s.title}`).join("\n");
  const facts = st.facts.length ? st.facts.map((f) => `- ${f}`).join("\n") : "- (none yet)";
  const body = [
    `Goal:\n${ctx.goal}`,
    `Plan:\n${plan}`,
    `Known facts:\n${facts}`,
    ctx.stuckHint ? `Automatic check flagged: ${ctx.stuckHint}` : "",
    `Latest turns (newest last):\n${ctx.recentDigest}`,
    "Answer with the ledger. nextStepId must be one of the plan ids above, or \"replan\".",
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    { role: "system", content: LEDGER_SYSTEM },
    { role: "user", content: body.length > maxChars ? `${body.slice(0, maxChars)}\n[digest truncated]` : body },
  ];
}

export function factsMessages(ctx: LedgerContext, st: LedgerState, maxChars: number): ChatMessage[] {
  const body = [
    `Goal:\n${ctx.goal}`,
    `Current fact sheet:\n${st.facts.map((f) => `- ${f}`).join("\n") || "- (empty)"}`,
    `Current guesses:\n${st.guesses.map((g) => `- ${g}`).join("\n") || "- (empty)"}`,
    `What happened since (newest last):\n${ctx.recentDigest}`,
    "Rewrite the fact sheet. Keep facts proven by tool results. Move anything unproven to guesses.",
    "Add what the failed attempts taught us, phrased as facts (for example: \"npm test fails because port 3000 is taken\").",
  ].join("\n\n");
  return [
    { role: "system", content: "You keep the fact sheet of a long agent run accurate and short." },
    { role: "user", content: body.slice(0, maxChars) },
  ];
}

/** Extra text appended to the orchestrator's replanPrompt (agent/orchestrator.ts) after a reset. */
export function rootCauseReplanNote(st: LedgerState, reason: string): string {
  const hist = st.history.slice(-5).map((h) => `- turn ${h.turn}: ${h.decision} (${h.reason})`).join("\n");
  return [
    `The previous plan stalled: ${reason}`,
    "Recent ledger history:",
    hist || "- (none)",
    "Updated facts:",
    st.facts.map((f) => `- ${f}`).join("\n") || "- (none)",
    "Name the root cause in one line first. The new plan must avoid the approach that stalled.",
  ].join("\n");
}

export interface LedgerLimits {
  maxStallCount: number;
  maxResets: number;
}

/**
 * Pure stall arithmetic (same rule as Magentic: +1 when not progressing or in
 * a loop, otherwise decay by 1, floor 0; reset when count exceeds the limit).
 */
export function applyLedger(st: LedgerState, e: LedgerEntry, lim: LedgerLimits): { state: LedgerState; decision: LedgerDecision; reason: string } {
  const turns = st.turns + 1;
  if (e.satisfied.value) {
    return { state: pushHist({ ...st, turns, lastEntry: e, stallCount: 0 }, "finish", e.satisfied.reason), decision: "finish", reason: e.satisfied.reason };
  }
  const stalled = !e.progressing.value || e.inLoop.value;
  const stallCount = stalled ? st.stallCount + 1 : Math.max(0, st.stallCount - 1);
  if (stallCount > lim.maxStallCount) {
    const reason = e.inLoop.value ? e.inLoop.reason : e.progressing.reason;
    if (st.resetCount >= lim.maxResets) {
      return { state: pushHist({ ...st, turns, lastEntry: e, stallCount }, "escalate", reason), decision: "escalate", reason };
    }
    return {
      state: pushHist({ ...st, turns, lastEntry: e, stallCount: 0, resetCount: st.resetCount + 1 }, "replan", reason),
      decision: "replan",
      reason,
    };
  }
  if (e.nextStepId === "replan") {
    return { state: pushHist({ ...st, turns, lastEntry: e, stallCount }, "replan", e.instruction), decision: "replan", reason: e.instruction };
  }
  return { state: pushHist({ ...st, turns, lastEntry: e, stallCount }, "continue", e.progressing.reason), decision: "continue", reason: e.progressing.reason };
}

function pushHist(st: LedgerState, decision: LedgerDecision, reason: string): LedgerState {
  return { ...st, history: [...st.history, { turn: st.turns, decision, reason: reason.slice(0, 200) }].slice(-8) };
}

export interface LedgerRunInput {
  port: ModelPort;
  model: string;
  ctx: LedgerContext;
  state: LedgerState;
  limits: LedgerLimits;
  maxChars: number;
  repairAttempts: number;
  signal?: AbortSignal;
}

export type LedgerRunOutput =
  | { ok: true; state: LedgerState; decision: LedgerDecision; reason: string; entry: LedgerEntry; tokens: number }
  | { ok: false; state: LedgerState; error: string; tokens: number };

/** One ledger turn. On a reset it also refreshes the fact sheet (second call). */
export async function runLedgerTurn(i: LedgerRunInput): Promise<LedgerRunOutput> {
  const r = await callStructured<LedgerEntry>(i.port, {
    model: i.model,
    contract: "progress_ledger",
    schema: LEDGER_SCHEMA,
    messages: ledgerMessages(i.ctx, i.state, i.maxChars),
    repairAttempts: i.repairAttempts,
    signal: i.signal,
  });
  let tokens = r.promptTokens + r.completionTokens;
  // A broken ledger must never stop the run: keep the state, let the orchestrator continue.
  if (!r.ok) return { ok: false, state: i.state, error: `${r.error}: ${r.issues.map((x) => x.message).join("; ")}`, tokens };
  const known = new Set(i.ctx.planSteps.map((s) => s.id));
  const entry: LedgerEntry = known.has(r.value.nextStepId) || r.value.nextStepId === "replan" ? r.value : { ...r.value, nextStepId: "replan" };
  const applied = applyLedger(i.state, entry, i.limits);
  let state = applied.state;
  if (applied.decision === "replan" && state.resetCount > i.state.resetCount) {
    const f = await callStructured<{ facts: string[]; guesses: string[] }>(i.port, {
      model: i.model,
      contract: "fact_sheet",
      schema: FACTS_SCHEMA,
      messages: factsMessages(i.ctx, state, i.maxChars),
      repairAttempts: i.repairAttempts,
      signal: i.signal,
    });
    tokens += f.promptTokens + f.completionTokens;
    if (f.ok) state = { ...state, facts: f.value.facts, guesses: f.value.guesses };
  }
  return { ok: true, state, decision: applied.decision, reason: applied.reason, entry, tokens };
}

/** When to spend a ledger call: a stuck pattern fired, or every N worker turns. */
export function shouldRunLedger(turnsSinceLast: number, everyTurns: number, stuck: boolean): boolean {
  return stuck || turnsSinceLast >= everyTurns;
}
