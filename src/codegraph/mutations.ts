/**
 * In-process observer for tools that can change files under a workspace.
 *
 * Why not PostToolUse hooks: ToolRegistry.exec skips lifecycle hooks when the
 * registry is readOnly (OBSERVED loam src/tools/registry.ts:192-197), and hooks
 * are user-configured shell commands. One call from exec() into this module is
 * cheaper and always on. Over-inclusion only costs one debounced incremental
 * refresh (~12 s OBSERVED); HEAD tracking catches edits made outside Loam.
 */
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
  "file_write", "file_edit", "file_multi_edit", "find_and_edit", "file_move", "file_delete", "text_editor",
  "git_commit", "git_branch",
  "shell_run", "shell_start", "shell_write", "pty_write",
  "code_session_collect", "scaffold_backend", "web_scaffold", "app_run",
]);

export type WorkspaceMutationObserver = (workspace: string, toolName: string) => void;

let observer: WorkspaceMutationObserver | null = null;

/** Set once by src/setup/runtime.ts after the CodeGraphService exists; null on dispose. */
export function setWorkspaceMutationObserver(fn: WorkspaceMutationObserver | null): void {
  observer = fn;
}

/** Called by ToolRegistry.exec after every tool run. Never throws, never awaits. */
export function notifyToolExecuted(toolName: string, ok: boolean, workspace: string): void {
  if (!observer || !MUTATING_TOOL_NAMES.has(toolName)) return;
  // A failed shell_run may still have written files, so only skip failed pure file tools.
  if (!ok && toolName.startsWith("file_")) return;
  try {
    observer(workspace, toolName);
  } catch {
    /* the graph is advisory; a broken observer must never fail a tool call */
  }
}
