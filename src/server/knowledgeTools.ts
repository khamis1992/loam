/**
 * Neo N3: the Knowledge Garden tool policy.
 *
 * The kb_* tools (kb_search / kb_ingest / kb_manage) are registered
 * unconditionally by the runtime so the companion gateway can advertise them as
 * the "knowledge" service. Whether a run may actually call them is decided per
 * run: a run started with the garden switched on keeps them in its allowlist,
 * every other run has them stripped, so the model never spends a call on a
 * feature the user switched off.
 *
 * This module is the single source of truth for the names, so the policy test,
 * the gateway service entry and the run-allowlist gate can never drift apart.
 */

/** The Knowledge Garden tool names, in a stable order. */
export const KNOWLEDGE_TOOL_NAMES: readonly string[] = ["kb_search", "kb_ingest", "kb_manage"];

const KNOWLEDGE_SET = new Set(KNOWLEDGE_TOOL_NAMES);

/** True when the tool belongs to the Knowledge Garden service. */
export function isKnowledgeTool(name: string): boolean {
  return KNOWLEDGE_SET.has(name);
}

/**
 * Apply the per-run Knowledge Garden gate to a resolved run allowlist.
 *
 * This is the single composition point for the toggle (used by executeTask in
 * src/index.ts): a run that opted into the garden keeps the kb_* tools, any
 * other run has them stripped. Keeping it here means the gate can be tested
 * without booting the whole agent loop, and the toggle can never silently stop
 * meaning anything — the regression test asserts the kb_* names actually reach
 * the input allowlist first.
 */
export function applyKnowledgeGate(allow: readonly string[], enabled: boolean): string[] {
  return enabled ? [...allow] : excludeKnowledgeTools(allow);
}

/**
 * Strip the Knowledge Garden tools from a resolved run allowlist.
 *
 * Used when a run did not opt into the garden. The tools stay registered (so
 * `registry.names()` still lists them and the gateway keeps advertising the
 * service) but they are absent from the allowlist, which is what decides what
 * the model sees.
 */
export function excludeKnowledgeTools(names: readonly string[]): string[] {
  return names.filter((name) => !KNOWLEDGE_SET.has(name));
}
