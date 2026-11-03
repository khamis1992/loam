import type { ScenarioPack } from "./plugins.js";

export interface AtomicObservation {
  positiveControl: boolean;
  negativeControl: boolean;
  evidenceIds: string[];
}

export function validateAtomicDefinition(test: ScenarioPack): void {
  if (!test.standard || !test.standardVersion || !test.ruleVersion || !test.negativeControl || !test.evidenceRequired?.length) throw new Error("atomic test is missing standard, version, negative control or evidence contract");
  if (test.timeoutMs !== undefined && (test.timeoutMs < 1 || test.timeoutMs > 300_000)) throw new Error("atomic test timeout is outside limits");
}

export function evaluateAtomicTest(test: ScenarioPack, observation: AtomicObservation): { status: "covered" | "finding" | "inconclusive" | "not-run"; reason: string; evidenceIds: string[] } {
  validateAtomicDefinition(test);
  const evidenceIds = [...new Set(observation.evidenceIds)];
  if (!evidenceIds.length) return { status: "not-run", reason: "no evidence was captured", evidenceIds };
  if (observation.positiveControl && observation.negativeControl) return { status: "finding", reason: "vulnerable behavior confirmed against both controls", evidenceIds };
  if (!observation.positiveControl && !observation.negativeControl) return { status: "covered", reason: "safe behavior confirmed against both controls", evidenceIds };
  return { status: "inconclusive", reason: "positive and negative controls disagree", evidenceIds };
}
