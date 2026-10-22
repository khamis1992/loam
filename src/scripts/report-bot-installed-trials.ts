import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// Explicit retrospective cohort, not a claim of unbiased or same-build parity.
const files = ["bot-installed-inventory-live.json", "bot-installed-inventory-corrected-live.json", "bot-installed-inventory-review-recovery-live.json", "bot-installed-sqlite-contract-live.json", "bot-installed-bookings-live.json", "bot-bookings-continuation-live.json", "bot-installed-transfers-live.json", "bot-installed-transfers-repair-live.json", "bot-installed-tickets-live.json", "bot-installed-tickets-docker-unavailable.json", "bot-installed-tickets-recovered-live.json", "bot-tickets-restart-live.json"];
files.push("bot-independent-installed-quote-format-failure.json", "bot-independent-installed-quote.json");
files.push("bot-independent-installed-quote-resumed.json", "bot-independent-installed-quote-selector-fix.json");
files.push("bot-installed-tickets-fresh-full-gate.json", "bot-installed-tickets-fresh-full-gate-1792390885363.json");
files.push("bot-installed-tickets-fresh-full-gate-1792391378865.json");
files.push("bot-installed-tickets-fresh-full-gate-1792392121105.json");
files.push("bot-installed-tickets-fresh-full-gate-1792393382079.json");
files.push("bot-installed-tickets-fresh-full-gate-1792394086306.json");
files.push("bot-installed-tickets-fresh-full-gate-1792395455746.json");
files.push("bot-installed-tickets-fresh-full-gate-1792395796648.json");
const records: Array<{ file: string; sha256: string; taskId?: string; startedAt?: string; capabilityRevision?: number; continuationOf?: string; observationMode?: string; outcome: string; elapsedMs?: number; elapsedMeaning: string; browserChecks?: number; independentProbePassed: boolean; error?: string }> = [];
for (const file of files) {
  const raw = fs.readFileSync(path.join("docs/evidence", file), "utf8");
  const r = JSON.parse(raw);
  const taskId = r.taskId ?? r.events?.find((e: { type: string; taskId?: string }) => e.type === "task" && e.taskId)?.taskId;
  // Current task status may belong to a later user turn. Never upgrade an
  // archived observation from a different execution using that mutable state.
  const observationTimedOut = /timeout/i.test(String(r.error ?? ""));
  const outcome = r.pass === true ? "passed" : observationTimedOut ? "observation-timeout-not-proof-of-task-termination" : r.error ? "trial-not-passed" : "incomplete-evidence";
  records.push({ file, sha256: createHash("sha256").update(raw).digest("hex"), taskId, startedAt: r.startedAt, capabilityRevision: r.capabilities?.revision, continuationOf: r.continuationOf, observationMode: r.observationMode, outcome, elapsedMs: r.elapsedMs, elapsedMeaning: r.observationMode ? "reattached observation only; excludes earlier execution and interruption" : outcome === "incomplete-evidence" ? "report-write snapshot; not current run duration" : "observer duration; may include verification and independent probe", browserChecks: r.report?.checks?.length, independentProbePassed: r.independentProbe?.pass === true, error: r.error });
}
const passedDurations = records.filter(r => r.outcome === "passed" && !r.observationMode && Number.isFinite(r.elapsedMs)).map(r => Number(r.elapsedMs)).sort((a,b) => a-b);
const report = { generatedAt: new Date().toISOString(), scope: "Explicit retrospective backend-app diagnostic cohort across changing builds and requirements; not all project trials and not an unbiased benchmark", caveats: ["No Grok or other external agent comparison was run", "Do not combine continuation success with initial attempts to claim first-pass success", "Older observation timeouts do not establish task termination", "Capability revision is not a unique build hash; builds changed within revisions", "Pending report pass=false is not failure", "Known finite contract coverage does not prove universal correctness"], counts: Object.fromEntries([...new Set(records.map(r => r.outcome))].map(outcome => [outcome, records.filter(r => r.outcome === outcome).length])), passedObservedDurationMs: passedDurations.length ? { min: passedDurations[0], max: passedDurations.at(-1) } : null, records };
fs.writeFileSync("docs/evidence/bot-installed-trials-summary.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({ counts: report.counts, passedObservedDurationMs: report.passedObservedDurationMs, scope: report.scope }));
