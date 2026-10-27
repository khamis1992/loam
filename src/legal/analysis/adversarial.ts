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
      { role: "system", content: "Act as opposing counsel and a strict reviewing lawyer. Attack the draft, not the drafting instructions. For every finding, identify an exact draft span and the supplied fact or authority element proving the defect. Identify only concrete defects: invented facts, unsupported claims, missed exceptions, unintended admissions, contradictions, unenforceable requests, stronger missing defenses, and coverage gaps. Do not invent evidence, hypothetical losses, legal requirements or procedural rules. Never report a condition, exception or burden as missing when the draft already quotes or addresses it; quoting the gross-excess condition and comparing the proven amounts addresses that condition. Reserve critical for a demonstrated defect that makes export legally unsafe, not for style, a merely arguable strategy, or evidence outside the record. Do not require a particular wording when the substance is addressed." },
      { role: "user", content: JSON.stringify(input) },
    ],
  });
  if (!result.ok) throw new Error(`adversarial review contract failed: ${result.issues.join("; ")}`);
  return result.value.findings;
}
