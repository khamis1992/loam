/**
 * Side-chat ("/btw question") tool policy.
 *
 * A side-chat run answers a read-only question while the main run continues.
 * It is therefore restricted to inspection tools: reading files, listing and
 * searching, fetching pages and inspecting the already-open browser. Any tool
 * that mutates files, the workspace, the browser, devices, memory or the task
 * graph is excluded, and `buildSideChatTools` is the single place the run's
 * allowlist is narrowed so the model never receives a mutating capability.
 */
import type { ToolRegistry } from "../tools/registry.js";

/** Inspection-only tools a side-chat run may use. */
export const SIDE_CHAT_READ_ONLY_TOOLS: readonly string[] = [
  "file_read",
  "file_list",
  "file_search",
  "file_stat",
  "file_extract_text",
  "file_view_image",
  "code_symbols",
  "code_outline",
  "web_fetch",
  "web_search",
  "browser_snapshot",
  "browser_pages",
  "browser_table",
  "browser_screenshot",
  "scratchpad_list",
  "task_list",
  "task_get",
  "schedule_list",
  "watch_list",
  "skill_list",
  "skill_view",
  "skill_search",
  "session_search",
  "subagent_list",
  "list_children",
  "ticket_list",
];

/** Tools that must never appear in a side-chat run. Kept explicit so the
 *  enforcement test can assert the two sets never overlap. */
export const MUTATING_TOOLS: readonly string[] = [
  "file_write",
  "file_edit",
  "file_mkdir",
  "file_move",
  "file_delete",
  "file_multi_edit",
  "shell_run",
  "shell_start",
  "shell_write",
  "shell_kill",
  "pty_run",
  "pty_start",
  "pty_write",
  "pty_kill",
  "preview_serve",
  "preview_stop",
  "browser_open",
  "browser_goto",
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_act",
  "browser_close",
  "browser_eval",
  "computer_click",
  "computer_type",
  "computer_key",
  "computer_ui_click",
  "computer_ui_set_text",
  "device_exec",
  "device_write_file",
  "device_push_file",
  "memory_store",
  "memory_delete",
  "recall",
  "recall_status",
  "scratchpad_add",
  "scratchpad_complete",
  "task_create",
  "task_cancel",
  "schedule_create",
  "schedule_delete",
  "delegate_subagent",
  "spawn_agent",
];

const READ_ONLY_SET = new Set(SIDE_CHAT_READ_ONLY_TOOLS);
const MUTATING_SET = new Set(MUTATING_TOOLS);

/** Narrow any registry to the side-chat inspection allowlist. */
export function buildSideChatTools(registry: ToolRegistry): ToolRegistry {
  return registry.forAllowlist([...SIDE_CHAT_READ_ONLY_TOOLS]);
}

/** True when a tool name is explicitly read-only for side chat. */
export function isSideChatReadOnlyTool(name: string): boolean {
  return READ_ONLY_SET.has(name);
}

/** True when a tool name mutates state and is therefore barred from side chat. */
export function isMutatingTool(name: string): boolean {
  return MUTATING_SET.has(name);
}

/** Keep only names that are read-only and not explicitly mutating. */
export function filterReadOnlyToolNames(names: readonly string[]): string[] {
  return names.filter((name) => READ_ONLY_SET.has(name) && !MUTATING_SET.has(name));
}
