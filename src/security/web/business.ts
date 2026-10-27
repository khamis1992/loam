import { runBusinessScenario, type BusinessObservation, type BusinessResult } from "../mobile/businessLogic.js";

export { runBusinessScenario };
export type { BusinessObservation, BusinessResult };

export async function runRaceScenario(id: string, execute: () => Promise<BusinessObservation>, options: { attempts: number; allowedSuccesses: number }): Promise<BusinessResult> {
  if (options.attempts < 2 || options.attempts > 20 || options.allowedSuccesses < 0) throw new Error("invalid race scenario limits");
  const observations = await Promise.all(Array.from({ length: options.attempts }, () => execute()));
  const accepted = observations.filter((observation) => observation.accepted);
  const evidenceIds = observations.map((observation) => observation.evidenceId);
  if (accepted.length < options.allowedSuccesses) return { scenarioId: id, status: "inconclusive", detail: "positive race control did not reach the allowed success count", evidenceIds };
  if (accepted.length > options.allowedSuccesses) return { scenarioId: id, status: "finding", detail: `${accepted.length} concurrent successes exceed allowed ${options.allowedSuccesses}`, evidenceIds };
  if (observations.some((observation) => !observation.state)) return { scenarioId: id, status: "inconclusive", detail: "race state witness missing", evidenceIds };
  return { scenarioId: id, status: "pass", detail: "concurrent successes remained within the allowed limit", evidenceIds };
}
