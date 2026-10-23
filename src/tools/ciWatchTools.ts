/**
 * ci_watch tool (D2): poll a pull request's CI check-runs through the D1 PR
 * provider and hand the failing job names plus their trimmed log tails back to
 * the model.
 *
 * The fix budget is keyed by failure signature (job name + its own log tail) and
 * is tracked per run: the first three identical failures ask the model to fix,
 * the fourth escalates to the user instead of looping.
 */
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { bool, num, str } from "./registry.js";
import type { PrProvider } from "./gitPrProvider.js";
import {
  CiWatchBudget,
  MAX_CI_FIX_ATTEMPTS,
  ciEscalationSummary,
  pollCiChecks,
  resolvePrProvider,
  type CiWatchPollOutcome,
} from "../agent/ciWatch.js";

export interface CiWatchToolOptions {
  /** Defaults to the GitHub provider backed by the connected connector
   *  (`LOAM_PR_PROVIDER=local` selects the scripted local provider). */
  provider?: PrProvider;
  /** Fix attempts already spent per failure signature (tests inject their own). */
  attempts?: Map<string, number>;
  /** Budget instance to share with the agent loop (one per run). */
  budget?: CiWatchBudget;
}

function formatFailingJob(job: { name: string; signature: string; logTail: string }): string {
  const tail = job.logTail.trim();
  const tailText = tail ? `\nLast log lines:\n${tail}` : "\nNo job log was available.";
  return `- ${job.name} (failure signature: ${job.signature})${tailText}`;
}

/** Render one poll outcome as the model-facing tool content. */
export function formatCiWatchResult(outcome: CiWatchPollOutcome): string {
  if (outcome.status === "success") return "CI is green: every check-run passed.";
  if (outcome.status === "timeout") {
    return `CI watch could not be read (${outcome.error}). Poll ci_watch again; if the provider keeps failing, report the error instead of guessing.`;
  }
  const jobs = outcome.failingJobs.map(formatFailingJob).join("\n");
  const attempts = Object.entries(outcome.attemptsUsed)
    .map(([signature, used]) => `${signature}: ${used}/${MAX_CI_FIX_ATTEMPTS} fix attempts used`)
    .join("\n");
  const budget = `Fix budget:\n${attempts}`;
  return outcome.escalation
    ? `${outcome.escalation}\n${budget}\nFailing jobs:\n${jobs}`
    : `CI is failing. Fix these jobs, then poll ci_watch again:\n${jobs}\n${budget}`;
}

export function createCiWatchTool(options: CiWatchToolOptions = {}): Tool {
  // One budget per tool instance; the agent loop can share it so a run keeps a
  // single fix budget across the tool and any loop-side poll.
  const budget = options.budget ?? new CiWatchBudget(options.attempts);
  // Default to the connector-backed GitHub provider; `LOAM_PR_PROVIDER=local`
  // selects the scripted provider so a watch works without any network.
  const provider = options.provider ?? resolvePrProvider();

  return {
    name: "ci_watch",
    description:
      "Poll CI check-runs for a pull request ref (GitHub check-runs API when connected, scripted results for the local provider) " +
      `and report the failing job names with their trimmed log tails. The same failure signature may be fixed at most ${MAX_CI_FIX_ATTEMPTS} times; ` +
      "after that ci_watch escalates to the user instead of asking for another attempt.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["repo", "ref"],
      properties: {
        repo: { type: "string", description: "Repository as owner/repo." },
        ref: { type: "string", description: "Branch, tag or commit SHA whose CI should be watched." },
        reset: { type: "boolean", default: false, description: "Forget the tracked fix budget for this ref." },
        logTailLines: { type: "integer", minimum: 5, maximum: 200, description: "Lines of job log to keep (default 40)." },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 120_000, description: "Per-poll timeout in milliseconds." },
      },
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const repo = str(args, "repo").trim();
      const ref = str(args, "ref").trim();
      if (!repo || !ref) return { ok: false, content: "ci_watch requires repo and ref" };

      if (bool(args, "reset", false)) budget.reset();

      const outcome = await pollCiChecks(provider, repo, ref, {
        attemptsFor: (signature) => budget.used(signature),
        logTailLines: num(args, "logTailLines", 40),
        timeoutMs: num(args, "timeoutMs", 0) || undefined,
      });

      // The poll we just served consumed one attempt per failing signature.
      if (outcome.status === "failed") {
        for (const job of outcome.failingJobs) budget.spend(job.signature);
      }

      if (outcome.status === "failed" && outcome.escalation) {
        ctx.emit({ type: "task-status", status: ciEscalationSummary(outcome.failingJobs, outcome.attemptsUsed) });
      }

      return { ok: true, content: formatCiWatchResult(outcome) };
    },
  };
}
