import { DEFAULT_RE_BUDGET, type ReBudget } from "./types.js";

export interface BudgetState {
  toolCalls: number;
  bytesOut: number;
  startedAt: number;
  budget: ReBudget;
}

export function startBudget(budget: ReBudget = DEFAULT_RE_BUDGET): BudgetState {
  return { toolCalls: 0, bytesOut: 0, startedAt: Date.now(), budget };
}

export type BudgetVerdict = { ok: true } | { ok: false; reason: "max_tool_calls" | "max_bytes_out" | "max_wall_ms" };

export function checkBudget(state: BudgetState, addBytes = 0): BudgetVerdict {
  if (state.toolCalls >= state.budget.maxToolCalls) return { ok: false, reason: "max_tool_calls" };
  if (state.bytesOut + addBytes > state.budget.maxBytesOut) return { ok: false, reason: "max_bytes_out" };
  if (Date.now() - state.startedAt > state.budget.maxWallMs) return { ok: false, reason: "max_wall_ms" };
  return { ok: true };
}

export function recordToolCall(state: BudgetState, bytesOut: number): BudgetState {
  return { ...state, toolCalls: state.toolCalls + 1, bytesOut: state.bytesOut + bytesOut };
}

/** Truncate tool JSON to budget; mark truncated. */
export function clipJson(value: unknown, maxChars: number): { text: string; truncated: boolean } {
  const text = JSON.stringify(value);
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, Math.max(0, maxChars - 20)) + '\u2026"truncated":true}', truncated: true };
}
