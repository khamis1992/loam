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
  "report_environment_issue",
  "todo_write",
  "browser_operator",
  "propose_instructions_update",
  "spawn_agent",
  "delegate_to_child",
  "list_children",
  "deep_research",
  "wide_research",
  "ticket_create",
  "ticket_list",
  "ticket_claim",
  "ticket_update",
  "handoff_to_agent",
  "scaffold_backend",
  "playbook_create_from_session",
  "web_scaffold",
  "design_create",
  "design_brand_kit_save",
  "design_image_generate",
  "design_page_images",
  "design_brief",
  "watch_url",
  "video_edit",
  "video_studio",
  "deploy_app",
  "export_build",
  "loam_design",
  "design_lint",
  "design_autofix",
  "workflow_run",
  "workflow_resume",
  "workflow_status",
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
