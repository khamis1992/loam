import type { EgressConfig } from "../egress.js";
import { ADVERSARIAL_SCHEMA } from "../model/schemas.js";
import { callLegalStructured } from "../model/structured.js";
import type { LegalModelPort } from "../model/types.js";
import type { AdversarialFinding } from "./types.js";

export async function adversarialReview(
  model: { port: LegalModelPort; config: EgressConfig },
  input: { draft: string; facts: unknown; authorities: unknown; coverage: unknown },
): Promise<AdversarialFinding[]> {
  const result = await callLegalStructured<{ findings: AdversarialFinding[] }>(model.port, {
    contract: "legal-adversarial-review",
    model: model.config.localModel,
    schema: ADVERSARIAL_SCHEMA,
    repairAttempts: 2,
    messages: [
      { role: "system", content: "Act as opposing counsel and a strict reviewing lawyer. Attack the draft, not the drafting instructions. Identify only concrete defects supported by the supplied facts and authorities: invented facts, unsupported claims, missed exceptions, unintended admissions, contradictions, unenforceable requests, stronger missing defenses, and coverage gaps. Do not invent evidence or law." },
      { role: "user", content: JSON.stringify(input) },
    ],
  });
  if (!result.ok) throw new Error(`adversarial review contract failed: ${result.issues.join("; ")}`);
  return result.value.findings;
}
