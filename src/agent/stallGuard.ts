/** Stall detection for the tool loop: the same call repeated, or a call that
 *  keeps failing, without any new progress. Each detection returns a short
 *  instruction the agent injects into the conversation so the model changes
 *  course instead of looping. */
import { BoundedMap } from "../memory/cache.js";
import { registerCacheStats } from "../memory/stats.js";

/** Repeated identical or failing calls before nudging the model off the loop. */
const MAX_CONSECUTIVE_NO_PROGRESS = 6;
/** Failures of one mode-specific tool before telling the model to stop and report. */
const MAX_DEDICATED_FAILURES = 2;
const DEDICATED_TOOL_PREFIX = /^(office_|pentest_|security_|browser_)/;
const DEDICATED_TOOL_EXACT = new Set([
  "loam_document",
  "loam_studio",
  "loam_creative",
  "loam_canvas",
  "loam_dataset",
  "data_chart",
  "web_search",
]);

/** Tools that exist precisely to do the job a mode advertises — failing them
 *  twice is a real blocker, not a reason to fall back to a shell script. */
export function isDedicatedTool(name: string): boolean {
  return DEDICATED_TOOL_PREFIX.test(name) || DEDICATED_TOOL_EXACT.has(name);
}

/**
 * Failure counters and "already warned" flags (J6). One guard is created per
 * agent run, so both collections are scoped to that run and die with it — but a
 * single run can still call the whole tool list, and an unbounded `Map` would
 * keep one entry per distinct tool name for the life of the run. Capped: the
 * counters only matter for the tools the run is actually repeating, so the
 * least-recently-used names are the right ones to drop.
 */
const GUARD_FAILURE_CAPACITY = 64;

export const STALL_NOTICE =
  "You have repeated the same failing or identical tool call several times without progress. Stop repeating it: re-read the available tool list, change the arguments or the tool, or state the concrete blocker. Do not claim success without new evidence.";

export function dedicatedFailureNotice(name: string): string {
  if (name.startsWith("office_")) {
    return `The tool ${name} failed twice. Stop retrying it: report the exact error and the current artifact revision, or repair the input with the studio tools. Do not claim the file was created, and do not switch to shell or Python while ${name} is available.`;
  }
  return `The tool ${name} failed twice. Stop retrying it: report the exact error and what you verified, then switch to a different available tool or state the concrete blocker instead of repeating the call or writing an unrelated script.`;
}

/** Tracks repeated identical calls and repeated failures of mode-specific tools.
 *  Returns the notice to inject, or null when the call looks like progress. */
export function createStallGuard(): (name: string, args: Record<string, unknown>, ok: boolean) => string | null {
  let stalled = 0;
  let lastSignature: string | null = null;
  const failures = new BoundedMap<string, number>(GUARD_FAILURE_CAPACITY, "stall-guard-failures");
  const warned = new BoundedMap<string, true>(GUARD_FAILURE_CAPACITY, "stall-guard-warned");

  // Both collections are bounded, so report them on the local `debug:memory`
  // surface. Registration is by name and last-wins, which matches the other
  // per-instance caches (e.g. videoStudioRelay); every guard shares the same
  // cap, so the newest guard is a representative row.
  registerCacheStats("stall-guard-failures", () => failures.stats());
  registerCacheStats("stall-guard-warned", () => warned.stats());

  return (name, args, ok) => {
    let notice: string | null = null;
    const signature = `${name}:${JSON.stringify(args)}`;
    const repeated = signature === lastSignature;
    lastSignature = signature;

    if (isDedicatedTool(name)) {
      if (ok) {
        failures.delete(name);
      } else {
        const count = (failures.get(name) ?? 0) + 1;
        failures.set(name, count);
        if (count >= MAX_DEDICATED_FAILURES && !warned.has(name)) {
          warned.set(name, true);
          failures.delete(name);
          notice = dedicatedFailureNotice(name);
        }
      }
    }

    // A failing call is no progress; a call identical to the previous one is
    // no progress either. Anything else resets the counter.
    if (!ok || repeated) stalled++;
    else stalled = 0;

    if (stalled >= MAX_CONSECUTIVE_NO_PROGRESS) {
      stalled = 0;
      notice = notice ? `${notice}\n\n${STALL_NOTICE}` : STALL_NOTICE;
    }
    return notice;
  };
}
