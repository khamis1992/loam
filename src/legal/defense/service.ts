import type { LegalCorpus } from "../corpusStore.js";
import type { EgressConfig } from "../egress.js";
import { qualityGate } from "../analysis/claimSupport.js";
import type { LegalModelPort } from "../model/types.js";
import type { MattersStore } from "../mattersStore.js";
import { buildCaseTheory } from "./caseTheory.js";
import { draftDefenseMemo } from "./draft.js";
import { opposeDefense } from "./opponent.js";
import { proceduralFlags } from "./procedure.js";
import { researchDefense } from "./strategy.js";
import type { DefensePackage } from "./types.js";

export async function buildDefensePackage(
  store: MattersStore,
  corpus: LegalCorpus,
  model: { port: LegalModelPort; config: EgressConfig },
  matterId: string,
): Promise<DefensePackage & { quality: ReturnType<typeof qualityGate>; procedural: ReturnType<typeof proceduralFlags> }> {
  const matter = store.getMatter(matterId);
  if (!matter) throw new Error(`matter ${matterId} not found`);
  const theory = await buildCaseTheory(model, {
    matter,
    documents: store.evidence.listDocuments(matterId),
    facts: store.evidence.listFacts(matterId),
    timeline: store.evidence.listTimeline(matterId),
    contradictions: store.evidence.listContradictions(matterId),
  });
  const research = await researchDefense(corpus, model, theory, matter.asOf, [matter.title], store.evidence.listFacts(matterId));
  const drafted = await draftDefenseMemo(corpus, model, { matter, theory, research, facts: store.evidence.listFacts(matterId) });
  const adversarial = await opposeDefense(model, { draft: drafted.draft, theory, research, coverage: drafted.verification.coverage });
  const claims = research.flatMap((record) => record.claims);
  const quality = qualityGate({ claims, findings: adversarial, coverage: drafted.verification.coverage });
  return { theory, research, draft: drafted.draft, verification: drafted.verification, structure: drafted.structure, adversarial, quality, procedural: proceduralFlags(matter) };
}
