import { filterReToolsList, isAllowedReTool, RE_ALLOWLIST_NAMES } from "../re/allowlist.js";
import { classifyReToolCall } from "../re/effects.js";
import { checkBudget, clipJson, recordToolCall, startBudget, type BudgetState } from "../re/budget.js";

export { filterReToolsList, isAllowedReTool, RE_ALLOWLIST_NAMES, classifyReToolCall, startBudget, checkBudget, recordToolCall, clipJson };
export type { BudgetState };

/**
 * Cap B surface helpers over the src/re allowlist layer. The older
 * src/tools/reaAllowlist.ts (13-name MCP catalogue filter, live tests) stays
 * the MCP wiring authority; this layer is the MISSING Cap B authority the
 * reverse-engineer mode and approval effects read from.
 */

/** MCP tools/list hook: drop anything not on the allowlist. */
export function applyReAllowlist<T extends { name: string }>(tools: T[]): T[] {
  return tools.filter((t) => isAllowedReTool(t.name));
}

/** Wrap a tool result as untrusted JSON within budget. */
export function wrapReResult(state: BudgetState, value: unknown): { state: BudgetState; payload: string; refused?: string } {
  const full = JSON.stringify(value);
  const gate = checkBudget(state, full.length);
  if (!gate.ok) {
    return { state, payload: JSON.stringify({ class: "refused", reason: gate.reason }), refused: gate.reason };
  }
  const clipped = clipJson(value, Math.max(0, state.budget.maxBytesOut - state.bytesOut));
  return { state: recordToolCall(state, clipped.text.length), payload: clipped.text };
}
