import type { EgressConfig } from "../egress.js";
import { ALLEGATION_MATRIX_SCHEMA } from "../model/schemas.js";
import { callLegalStructured } from "../model/structured.js";
import type { LegalModelPort } from "../model/types.js";
import type { Matter } from "../types.js";
import type { EvidenceDocument, FactAssertion, TimelineEvent } from "../evidence/types.js";
import type { AllegationResponseMatrix } from "./types.js";

export async function buildAllegationMatrix(
  model: { port: LegalModelPort; config: EgressConfig },
  input: { matter: Matter; sourceText: string; documents: EvidenceDocument[]; facts: FactAssertion[]; timeline: TimelineEvent[] },
): Promise<AllegationResponseMatrix> {
  const result = await callLegalStructured<AllegationResponseMatrix>(model.port, {
    contract: "legal-response-allegations",
    model: model.config.localModel,
    schema: ALLEGATION_MATRIX_SCHEMA,
    repairAttempts: 2,
    messages: [
      { role: "system", content: "Analyze the opposing legal document as a defense lawyer. Decompose every material factual allegation, legal proposition and request. Choose admit/deny/no_knowledge/explain/procedural carefully. Do not make unintended admissions or waive rights. Link only supplied evidence and flag decisions requiring the client. Do not cite law from memory." },
      { role: "user", content: JSON.stringify(input) },
    ],
  });
  if (!result.ok) throw new Error(`allegation matrix contract failed: ${result.issues.join("; ")}`);
  const factIds = new Set(input.facts.map((fact) => fact.id));
  return {
    ...result.value,
    entries: result.value.entries.map((entry) => ({
      ...entry,
      evidenceFactIds: entry.evidenceFactIds.filter((id) => factIds.has(id)),
      needsClientDecision: entry.needsClientDecision || entry.evidenceFactIds.some((id) => !factIds.has(id)),
    })),
  };
}
