/**
 * Agent-loop integration for the CI watch loop (D2).
 *
 * The tool (`ci_watch`) owns the provider call and the per-run fix budget. This
 * module owns the loop-facing half: it turns an escalated poll into a user
 * escalation and gives the agent loop the stop-and-report notice it injects so
 * the model stops polling a signature whose budget is spent.
 */
import { createApproval, waitForDecision } from "../server/approvals.js";
import type { FailingJob, PrProvider } from "../tools/gitPrProvider.js";
import type { Emit } from "./events.js";
import {
  CI_ESCALATION_NOTICE,
  CiWatchBudget,
  MAX_CI_FIX_ATTEMPTS,
  isCiEscalation,
  pollCiChecks,
} from "./ciWatch.js";

/** One poll's result, ready to be injected into the model's next turn. */
export interface CiWatchReport {
  /** Failing job names with their trimmed log tails, or null when CI is green. */
  failingJobs: Array<{ name: string; signature: string; logTail: string }> | null;
  /** True when the signature's fix budget is spent and the user was escalated. */
  escalated: boolean;
  /** Model-facing text for this poll. */
  text: string;
}

function formatJobs(jobs: Array<{ name: string; signature: string; logTail: string }>): string {
  return jobs
    .map((job) => {
      const tail = job.logTail.trim();
      return `- ${job.name} (failure signature: ${job.signature})${tail ? `\n${tail}` : ""}`;
    })
    .join("\n");
}

/** The escalation text the loop injects when a poll could not be read. */
export function ciWatchTimeoutMessage(error: string): string {
  return `ci_watch could not read the check-runs (${error}). Poll ci_watch again; if the provider keeps failing, report the problem instead of retrying forever.`;
}

/**
 * The notice the agent loop injects after a `ci_watch` result, or null when the
 * poll did not escalate. This is the loop half of "then escalate to the user":
 * the tool result already carries the failing jobs, and this notice tells the
 * model to stop polling and report instead of burning more steps on a spent
 * failure signature. It reuses the loop's existing stall-notice channel.
 */
export function ciWatchEscalationNotice(content: string): string | null {
  return isCiEscalation(content) ? CI_ESCALATION_NOTICE : null;
}

/**
 * Poll a pull request's CI check-runs once for the agent loop.
 *
 * Returns null when CI is green (nothing to report). Otherwise it returns the
 * failing job names with their trimmed log tails; when every failing signature
 * has already consumed its fix budget it escalates to the user and returns the
 * escalation text instead of asking the model to try again.
 */
export async function watchCiOnce(
  budget: CiWatchBudget,
  provider: PrProvider,
  repo: string,
  ref: string,
  options: {
    emit: Emit;
    taskId?: string;
    signal?: AbortSignal;
    logTailLines?: number;
    timeoutMs?: number;
  },
): Promise<CiWatchReport | null> {
  const outcome = await pollCiChecks(provider, repo, ref, {
    attemptsFor: (signature) => budget.used(signature),
    logTailLines: options.logTailLines,
    timeoutMs: options.timeoutMs,
  });

  if (outcome.status === "timeout") {
    return { failingJobs: null, escalated: false, text: ciWatchTimeoutMessage(outcome.error) };
  }

  if (outcome.status === "success") return null;

  for (const job of outcome.failingJobs) budget.spend(job.signature);

  if (outcome.escalation) {
    await escalateToUser(options, { failingJobs: outcome.failingJobs, escalation: outcome.escalation });
    return { failingJobs: outcome.failingJobs, escalated: true, text: outcome.escalation };
  }

  const remaining = outcome.failingJobs
    .map((job) => `- ${job.name}: ${budget.left(job.signature)} of ${MAX_CI_FIX_ATTEMPTS} fix attempts left`)
    .join("\n");
  return {
    failingJobs: outcome.failingJobs,
    escalated: false,
    text: `CI is failing. Fix these jobs and poll ci_watch again:\n${formatJobs(outcome.failingJobs)}\nRemaining fix budget:\n${remaining}`,
  };
}

/** Surface the escalation to the user: a task-status event, an assistant message
 *  and, when the run has an approval channel, a blocking approval request. */
export async function escalateToUser(
  options: { emit: Emit; taskId?: string; signal?: AbortSignal },
  escalation: { failingJobs: FailingJob[]; escalation: string },
): Promise<void> {
  options.emit({ type: "task-status", status: `CI still failing after ${MAX_CI_FIX_ATTEMPTS} fix attempts; escalating to the user.` });
  options.emit({ type: "assistant_message", text: escalation.escalation });
  if (!options.taskId) return;
  const approval = createApproval({
    taskId: options.taskId,
    tool: "ci_watch",
    summary: escalation.escalation,
    argsPreview: JSON.stringify({ repo: "", ref: "" }),
  });
  options.emit({ type: "approval_required", approvalId: approval.id, tool: "ci_watch", summary: escalation.escalation });
  await waitForDecision(approval.id, options.signal);
}
