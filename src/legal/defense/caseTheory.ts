import type { EgressConfig } from "../egress.js";
import { CASE_THEORY_SCHEMA } from "../model/schemas.js";
import { callLegalStructured } from "../model/structured.js";
import type { LegalModelPort } from "../model/types.js";
import type { Matter } from "../types.js";
import type { Contradiction, EvidenceDocument, FactAssertion, TimelineEvent } from "../evidence/types.js";
import type { CaseTheory } from "./types.js";

export async function buildCaseTheory(
  model: { port: LegalModelPort; config: EgressConfig },
  input: { matter: Matter; documents: EvidenceDocument[]; facts: FactAssertion[]; timeline: TimelineEvent[]; contradictions: Contradiction[] },
): Promise<CaseTheory> {
  const result = await callLegalStructured<CaseTheory>(model.port, {
    contract: "defense-case-theory",
    model: model.config.localModel,
    schema: CASE_THEORY_SCHEMA,
    repairAttempts: 2,
    messages: [
      { role: "system", content: "Build a defense case theory as an expert Qatari defense lawyer. Use only supplied facts and documents. Separate procedural, substantive and evidentiary pleas. Do not cite article numbers or invent facts. Each plea must link fact ids and research queries. Include weaknesses and missing evidence honestly." },
      { role: "user", content: JSON.stringify(input) },
    ],
  });
  if (!result.ok) throw new Error(`case theory contract failed: ${result.issues.join("; ")}`);
  const factIds = new Set(input.facts.map((fact) => fact.id));
  const missing = new Set<string>();
  const pleas = result.value.pleas.map((plea) => {
    const allowed = plea.factIds.filter((id) => factIds.has(id));
    for (const id of plea.factIds.filter((id) => !factIds.has(id))) missing.add(id);
    return { ...plea, factIds: allowed };
  });
  return {
    ...result.value,
    pleas: pleas.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)),
    unresolvedQuestions: result.value.unresolvedQuestions.concat([...missing].map((id) => ({ question: `Missing evidence for model-referenced fact ${id}`, material: true }))),
  };
}
