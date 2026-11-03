export interface BusinessObservation {
  accepted: boolean;
  state?: string;
  evidenceId: string;
}

export interface BusinessScenario {
  id: string;
  kind: "step-order" | "quota" | "replay" | "offline";
  steps: string[];
  expectedOrder?: string[];
  quota?: number;
  expectedFinalState?: string;
}

export interface BusinessResult {
  scenarioId: string;
  status: "pass" | "finding" | "inconclusive";
  detail: string;
  evidenceIds: string[];
}

export async function runBusinessScenario(scenario: BusinessScenario, execute: (step: string, index: number) => Promise<BusinessObservation>): Promise<BusinessResult> {
  const evidenceIds: string[] = [];
  const observations: BusinessObservation[] = [];
  for (const [index, step] of scenario.steps.entries()) {
    const observation = await execute(step, index);
    evidenceIds.push(observation.evidenceId);
    observations.push(observation);
  }
  const accepted = observations.filter((observation) => observation.accepted);
  if (scenario.kind === "step-order") {
    if (!scenario.expectedOrder) throw new Error("step-order scenario requires expectedOrder");
    const acceptedSteps = observations.map((observation, index) => ({ observation, step: scenario.steps[index]! })).filter((entry) => entry.observation.accepted).map((entry) => entry.step);
    if (acceptedSteps.join("\n") !== scenario.expectedOrder.join("\n")) return { scenarioId: scenario.id, status: "finding", detail: `Accepted order ${acceptedSteps.join(" -> ")} differs from required order`, evidenceIds };
    return { scenarioId: scenario.id, status: "pass", detail: "required step order enforced", evidenceIds };
  }
  if (scenario.kind === "quota") {
    if (!scenario.quota || scenario.quota < 1) throw new Error("quota scenario requires a positive quota");
    if (accepted.length < scenario.quota) return { scenarioId: scenario.id, status: "inconclusive", detail: "positive quota control was not reached", evidenceIds };
    return accepted.length > scenario.quota
      ? { scenarioId: scenario.id, status: "finding", detail: `${accepted.length} operations accepted above quota ${scenario.quota}`, evidenceIds }
      : { scenarioId: scenario.id, status: "pass", detail: "quota enforced", evidenceIds };
  }
  if (scenario.kind === "replay") {
    if (observations.length < 2 || !observations[0]?.accepted) return { scenarioId: scenario.id, status: "inconclusive", detail: "initial operation was not accepted", evidenceIds };
    if (!observations[1]?.accepted) return { scenarioId: scenario.id, status: "pass", detail: "replayed operation rejected", evidenceIds };
    if (!observations[0].state || !observations[1].state) return { scenarioId: scenario.id, status: "inconclusive", detail: "replay accepted but state witness is missing", evidenceIds };
    return observations[0].state === observations[1].state
      ? { scenarioId: scenario.id, status: "pass", detail: "replay accepted without additional state effect", evidenceIds }
      : { scenarioId: scenario.id, status: "finding", detail: "replay changed state more than once", evidenceIds };
  }
  const finalState = observations.at(-1)?.state;
  if (!finalState) return { scenarioId: scenario.id, status: "inconclusive", detail: "offline state witness missing", evidenceIds };
  return finalState === scenario.expectedFinalState
    ? { scenarioId: scenario.id, status: "pass", detail: "offline synchronization reached the required state", evidenceIds }
    : { scenarioId: scenario.id, status: "finding", detail: `offline synchronization ended in ${finalState}`, evidenceIds };
}
