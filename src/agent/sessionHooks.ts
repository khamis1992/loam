import { runLifecycleHooks, wrapHookContext } from "../policy/hooks.js";
import { isCancelled, throwIfCancelled } from "../server/runControl.js";
import { wikiStartNotice } from "../wiki/hooks.js";

type WikiCfg = Parameters<typeof wikiStartNotice>[0];

/** Why a top-level run reached its terminal state. */
export type SessionEndReason = "completed" | "cancelled" | "failed";

/** Context SessionStart/UserPromptSubmit asked Loam to inject, or null when empty. */
export interface SessionHookContext {
  injected: string;
  end: (reason: SessionEndReason) => Promise<void>;
}

/**
 * Run SessionStart and UserPromptSubmit before the first model call, and return
 * the SessionEnd closer. Both hooks fire only for a top-level run; nested runs
 * (orchestrator workers, subagent children) never see them.
 *
 * A blocked hook throws so the caller's own error handling reports it. The
 * returned `end` runs in a `finally` so SessionEnd always fires once, for a
 * completed, cancelled or failed session alike.
 */
export async function openSession(options: {
  workspace: string;
  prompt: string;
  signal?: AbortSignal;
  taskId?: string;
  /** Top-level runs pass true; nested runs pass false/omit. */
  enabled: boolean;
  /** Project wiki config; when enabled, open handoffs are announced (metadata only). */
  wikiCfg?: WikiCfg;
}): Promise<SessionHookContext> {
  if (!options.enabled) return { injected: "", end: async () => {} };

  throwIfCancelled(options.signal, options.taskId);
  const sessionStart = await runLifecycleHooks("SessionStart", "", { source: "startup" }, options.workspace);
  if (sessionStart.blocked) throw new Error("SessionStart hook blocked the session: " + sessionStart.message);
  const promptSubmit = await runLifecycleHooks("UserPromptSubmit", "", { prompt: options.prompt }, options.workspace);
  if (promptSubmit.blocked) throw new Error("UserPromptSubmit hook blocked the prompt: " + promptSubmit.message);

  const wikiNotice = options.wikiCfg ? wikiStartNotice(options.wikiCfg) : "";
  const injected = [sessionStart.additionalContext, promptSubmit.additionalContext, wikiNotice]
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("\n");

  return { injected: wrapHookContext(injected), end: (reason) => closeSession(options.workspace, reason) };
}

/** Report the run's real terminal reason; a hook must be able to tell them apart. */
export async function closeSession(workspace: string, reason: SessionEndReason): Promise<void> {
  await runLifecycleHooks("SessionEnd", "", { reason }, workspace);
}

/** True when the run was stopped by the user rather than failing on its own. */
export function cancelled(signal: AbortSignal | undefined, taskId: string | undefined): boolean {
  return Boolean(signal?.aborted) || isCancelled(taskId);
}
