/** fuzz: external Jazzer.js planning, execution and output triage. The fuzzer never runs in-process. */
export { jazzerPlan, exitMeaning, DEFAULTS, FINDING_EXIT, UNEXPECTED_ERROR_EXIT } from "./plan.js";
export type { JazzerPlan, JazzerPlanOptions } from "./plan.js";
export { parseJazzerStderr, parseCrashArtifacts, triage, toHits, triageJazzerRun } from "./triage.js";
export type { FuzzFinding, FuzzKind, TriageResult } from "./triage.js";
export { discoverFuzzTargets, runJazzerScan, toSarif, MAX_TARGETS } from "./run.js";
export type { JazzerScanContext, JazzerScanOutcome } from "./run.js";
