/** Recall-first evidence gate: only an explicit refutation rejects. Ordinal only, no arithmetic. */
import type { EvidenceItem } from "./types.js";

export type GateOutcome = "reject" | "needs_validation" | "pass";

export function evidenceGate(vector: EvidenceItem[]): GateOutcome {
  if (vector.some((e) => e.state === "refuted")) return "reject";
  if (vector.length === 0 || vector.some((e) => e.state === "unknown")) return "needs_validation";
  return "pass";
}
