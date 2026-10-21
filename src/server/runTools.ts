/**
 * Always-on core tools for agent runs.
 *
 * The companion gateway composes each run's tool allowlist as
 * mode-catalog tools ∪ work-mode service grants, and index.ts then intersects
 * it with the registry. A tool that is registered but absent from BOTH the
 * mode catalog (src/modes/catalog.ts) and every service group
 * (src/server/companionGateway.ts) can therefore never reach a run — the
 * model never sees it, even though `registry.names()` lists it.
 *
 * Always-on tools are low-risk, per-agent bookkeeping utilities (scratchpad)
 * that ship in every Loam mode and work mode without approval. The caller
 * merges them into the gateway-resolved allowlist AFTER resolution, so the
 * gateway stays the single policy point for services and the per-agent
 * tool-denial layer (agent.disabledTools) still removes them.
 */

/** Low-risk tools exposed to every agent run in every mode. */
export const ALWAYS_ON_TOOLS: readonly string[] = [
  "scratchpad_add",
  "scratchpad_list",
  "scratchpad_complete",
  "handoff_to_agent",
];

export interface AlwaysOnMergeInput {
  /** Gateway-resolved allowlist (mode ∪ work-mode grants − revokes − denials). */
  resolvedAllow: readonly string[];
  /** Tool names actually present in the registry at run time. */
  registeredTools: readonly string[];
  /** Per-agent explicit tool denials; they win over the always-on grant. */
  disabledTools?: string[];
}

/** Merge always-on core tools into a gateway-resolved run allowlist. */
export function mergeAlwaysOnTools(input: AlwaysOnMergeInput): string[] {
  const registered = new Set(input.registeredTools);
  const disabled = new Set(input.disabledTools ?? []);
  const merged = new Set(input.resolvedAllow);
  for (const name of ALWAYS_ON_TOOLS) {
    if (registered.has(name) && !disabled.has(name)) merged.add(name);
  }
  return [...merged];
}