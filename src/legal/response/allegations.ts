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
  const factIds = new Set(input.facts.map((fact) => fact.id));
  let correction: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await callLegalStructured<AllegationResponseMatrix>(model.port, {
      contract: "legal-response-allegations",
      model: model.config.localModel,
      schema: ALLEGATION_MATRIX_SCHEMA,
      repairAttempts: 2,
      messages: [
        { role: "system", content: "Analyze only the opposing sourceText as a defense lawyer. Decompose every material factual allegation, legal proposition and request actually asserted there; never turn the client's evidence or matter title into new opponent allegations. Every entry must include sourceQuote copied verbatim and contiguously from sourceText so its origin can be checked; never translate or paraphrase sourceQuote. Use documents, facts and timeline only to evaluate or respond to those sourceText allegations. Choose admit/deny/no_knowledge/explain/procedural carefully. Do not make unintended admissions or waive rights. Link only supplied evidence and flag decisions requiring the client. Do not cite law from memory." },
        { role: "user", content: JSON.stringify({ ...input, correction }) },
      ],
    });
    if (!result.ok) throw new Error(`allegation matrix contract failed: ${result.issues.join("; ")}`);
    const entries = result.value.entries.filter((entry) => input.sourceText.includes(entry.sourceQuote)).map((entry) => ({
      ...entry,
      sourceStart: input.sourceText.indexOf(entry.sourceQuote),
      evidenceFactIds: entry.evidenceFactIds.filter((id) => factIds.has(id)),
      needsClientDecision: entry.needsClientDecision || entry.evidenceFactIds.some((id) => !factIds.has(id)),
    }));
    const excludedEntries = result.value.entries.filter((entry) => !input.sourceText.includes(entry.sourceQuote));
    if (excludedEntries.length > 0 && attempt === 1) {
      correction = { unanchoredEntries: excludedEntries, instruction: "Keep only sourceText allegations and replace each invalid sourceQuote with an exact contiguous substring from the original sourceText; do not translate it." };
      continue;
    }
    return {
      ...result.value,
      entries,
      unresolvedQuestions: [...result.value.unresolvedQuestions, ...(excludedEntries.length > 0 ? [{ question: `استُبعد ${excludedEntries.length} من الادعاءات لعدم وجود اقتباس مطابق في نص الخصم؛ راجع النص قبل الاعتماد.`, material: true }] : [])],
    };
  }
  throw new Error("unreachable allegation anchor repair");
}
