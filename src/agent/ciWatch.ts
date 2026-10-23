/**
 * CI watch loop (D2): poll a pull request's CI check-runs through the D1 PR
 * provider, hand the failing job names and the trimmed log tails back to the
 * model, and stop after a bounded number of fix attempts keyed by the failure
 * signature.
 *
 * The budget is deliberately small and per signature: a failing job the agent
 * already tried to fix is not retried forever. Reaching the cap escalates to
 * the user instead of silently looping, and the shared stallGuard sees the
 * escalation too, so its "stop repeating this call" notice fires on the next
 * poll.
 */
import os from "node:os";
import path from "node:path";
import {
  GitHubPrProvider,
  LocalPrProvider,
  type CheckRunInfo,
  type FailingJob,
  type PrProvider,
} from "../tools/gitPrProvider.js";

/** Consecutive identical failures of one signature before escalating to the user. */
export const MAX_CI_FIX_ATTEMPTS = 3;
/** Default cap on how many log lines the model receives for one failing job. */
export const DEFAULT_LOG_TAIL_LINES = 40;
/** Hard cap on the characters kept from one job log (keeps context small). */
export const MAX_LOG_TAIL_CHARS = 8000;
/** Default per-request timeout for one check-run poll. */
export const DEFAULT_CI_POLL_TIMEOUT_MS = 30_000;
/** Hard cap the tool accepts for its own timeout (never hangs a run). */
export const MAX_CI_POLL_TIMEOUT_MS = 120_000;

/** Machine-checkable marker on the model-facing text when the fix budget is spent.
 *  The agent loop keys its stop-and-report notice off this marker. */
export const CI_ESCALATION_MARKER = "[ci_watch: escalate]";

/** The loop notice injected when a poll escalates to the user. */
export const CI_ESCALATION_NOTICE =
  `ci_watch escalated ${CI_ESCALATION_MARKER} CI did not pass within ${MAX_CI_FIX_ATTEMPTS} fix attempts on the same failure signature. Stop polling ci_watch: report what failed, what you tried and what you need from the user instead of repeating the call.`;

/** Whether model-facing text is a ci_watch escalation (budget spent). */
export function isCiEscalation(content: string): boolean {
  return content.includes(CI_ESCALATION_MARKER);
}

/** Fix attempts spent per failure signature, shared by the tool and the loop. */
export class CiWatchBudget {
  private readonly attempts: Map<string, number>;

  constructor(attempts?: Map<string, number>) {
    this.attempts = attempts ?? new Map();
  }

  /** Attempts already spent on one signature. */
  used(signature: string): number {
    return this.attempts.get(signature) ?? 0;
  }

  /** Attempts still available for one signature. */
  left(signature: string): number {
    return Math.max(0, MAX_CI_FIX_ATTEMPTS - this.used(signature));
  }

  /** Record that one more attempt was spent on a signature. */
  spend(signature: string): void {
    this.attempts.set(signature, this.used(signature) + 1);
  }

  /** Forget every tracked signature (run reset / explicit re-check). */
  reset(): void {
    this.attempts.clear();
  }
}

/** Check-run conclusions that mean "this job failed". */
const FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "stale"]);

export interface CiWatchPollOptions {
  /** Fix attempts already spent on this failure signature. */
  attemptsFor?: (signature: string) => number;
  /** Job-log line cap; defaults to DEFAULT_LOG_TAIL_LINES. */
  logTailLines?: number;
  /** Per-poll timeout; defaults to DEFAULT_CI_POLL_TIMEOUT_MS. */
  timeoutMs?: number;
}

export type CiWatchPollOutcome =
  | {
      status: "success";
      failingJobs: [];
      escalation: null;
      attemptsUsed: Record<string, number>;
      /** Stop watching: the checks passed. */
      retry: false;
    }
  | {
      status: "failed";
      failingJobs: FailingJob[];
      escalation: string | null;
      attemptsUsed: Record<string, number>;
      /** Keep polling: the signature is still inside its fix budget. */
      retry: boolean;
    }
  | {
      status: "timeout";
      /** Set when the provider call exceeded the timeout: the watch never
       *  concludes, so the caller decides whether to poll again. */
      error: string;
      failingJobs: [];
      escalation: null;
      attemptsUsed: Record<string, number>;
      retry: boolean;
    };

/** Collapse a job log to its last `lines` non-empty lines, capped in characters. */
export function trimLogTail(log: string, lines = DEFAULT_LOG_TAIL_LINES): string {
  const kept = log
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-Math.max(1, lines));
  const text = kept.join("\n");
  if (text.length <= MAX_LOG_TAIL_CHARS) return text;
  return `${text.slice(text.length - MAX_LOG_TAIL_CHARS)}\n[...log trimmed]`;
}

/** Stable signature for one failing job: its name plus its own log tail. */
export function failureSignature(run: CheckRunInfo, logTail: string): string {
  return `${run.name}::${trimLogTail(logTail, 8)}`;
}

/** Wrap one provider call so a slow CI provider cannot stall the agent loop. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Poll a pull request's CI check-runs once.
 *
 * Returns the failing job names with their trimmed log tails. The fix budget is
 * counted BEFORE this poll (attemptsFor), so a signature reported three times
 * in a row is on its third and last attempt; the poll after it escalates.
 */
export async function pollCiChecks(
  provider: PrProvider,
  repo: string,
  ref: string,
  options: CiWatchPollOptions = {},
): Promise<CiWatchPollOutcome> {
  const attemptsFor = options.attemptsFor ?? (() => 0);
  const logTailLines = options.logTailLines ?? DEFAULT_LOG_TAIL_LINES;
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? DEFAULT_CI_POLL_TIMEOUT_MS, MAX_CI_POLL_TIMEOUT_MS));

  let runs: CheckRunInfo[];
  try {
    runs = await withTimeout(provider.listCheckRuns(repo, ref), timeoutMs, "listCheckRuns");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "timeout",
      error: message,
      failingJobs: [],
      escalation: null,
      attemptsUsed: {},
      retry: true,
    };
  }

  const failed = runs.filter((run) => FAILURE_CONCLUSIONS.has(run.conclusion ?? ""));
  const failingJobs: FailingJob[] = [];
  const attemptsUsed: Record<string, number> = {};

  for (const run of failed) {
    let log = "";
    try {
      log = await withTimeout(provider.getCheckRunLog(repo, run.id), timeoutMs, "getCheckRunLog");
    } catch {
      // A job whose log cannot be fetched is still a failure; it is reported
      // without a tail instead of aborting the whole watch.
      log = "";
    }
    const logTail = trimLogTail(log, logTailLines);
    const signature = failureSignature(run, logTail);
    const used = attemptsFor(signature);
    attemptsUsed[signature] = used;
    failingJobs.push({ name: run.name, signature, logTail });
  }

  if (failingJobs.length === 0) {
    return { status: "success", failingJobs: [], escalation: null, attemptsUsed, retry: false };
  }

  const attemptsLeft = failingJobs.some((job) => (attemptsUsed[job.signature] ?? 0) < MAX_CI_FIX_ATTEMPTS);

  if (!attemptsLeft) {
    return {
      status: "failed",
      failingJobs,
      escalation: escalationNotice(failingJobs, attemptsUsed),
      attemptsUsed,
      retry: false,
    };
  }

  return { status: "failed", failingJobs, escalation: null, attemptsUsed, retry: true };
}

/** The escalation the model receives when the fix budget is spent. */
export function escalationNotice(failingJobs: FailingJob[], attemptsUsed: Record<string, number>): string {
  const jobs = failingJobs
    .map((job) => `- ${job.name} (failure signature ${job.signature}, ${attemptsUsed[job.signature] ?? 0} fix attempts)`)
    .join("\n");
  return `${CI_ESCALATION_MARKER} CI is still failing after ${MAX_CI_FIX_ATTEMPTS} fix attempts on the same failure signature. Stop retrying it: report what failed, what you tried and what you need from the user, or ask the user with the message tool.\n${jobs}`;
}

/** Short user-facing escalation for the tool result (no model instructions). */
export function ciEscalationSummary(failingJobs: FailingJob[], attemptsUsed: Record<string, number>): string {
  const jobs = failingJobs
    .map((job) => `- ${job.name}: still failing after ${attemptsUsed[job.signature] ?? MAX_CI_FIX_ATTEMPTS} fix attempts`)
    .join("\n");
  return `Escalating to the user: CI did not pass within ${MAX_CI_FIX_ATTEMPTS} fix attempts.\n${jobs}`;
}

/**
 * Resolve the PR provider a `ci_watch` call runs against.
 *
 * `LOAM_PR_PROVIDER=local` (with an optional `LOAM_PR_DIR` directory) selects the
 * scripted local provider, so a watch can be exercised without any network. The
 * default is the GitHub provider backed by the connected connector.
 */
export function resolvePrProvider(env: NodeJS.ProcessEnv = process.env): PrProvider {
  if ((env.LOAM_PR_PROVIDER ?? "").trim().toLowerCase() === "local") {
    const dir = (env.LOAM_PR_DIR ?? "").trim() || path.join(os.tmpdir(), "loam-prs");
    return new LocalPrProvider(dir);
  }
  return new GitHubPrProvider();
}
