import type { LegalCorpus } from "../corpusStore.js";
import type { EgressConfig } from "../egress.js";
import { qualityGate } from "../analysis/claimSupport.js";
import { adversarialReview } from "../analysis/adversarial.js";
import type { LegalModelPort } from "../model/types.js";
import type { MattersStore } from "../mattersStore.js";
import { buildAllegationMatrix } from "./allegations.js";
import { draftLegalResponse } from "./draft.js";
import { researchResponse } from "./responseStrategy.js";
import type { LegalResponsePackage } from "./types.js";

export async function buildLegalResponse(
  store: MattersStore,
  corpus: LegalCorpus,
  model: { port: LegalModelPort; config: EgressConfig },
  input: { matterId: string; sourceText: string },
): Promise<LegalResponsePackage & { quality: ReturnType<typeof qualityGate> }> {
  const matter = store.getMatter(input.matterId);
  if (!matter) throw new Error(`matter ${input.matterId} not found`);
  const matrix = await buildAllegationMatrix(model, {
    matter, sourceText: input.sourceText, documents: store.evidence.listDocuments(matter.id),
    facts: store.evidence.listFacts(matter.id), timeline: store.evidence.listTimeline(matter.id),
  });
  const research = await researchResponse(corpus, model, matrix, matter.asOf);
  const drafted = await draftLegalResponse(corpus, model, { matter, matrix, research });
  const adversarial = await adversarialReview(model, { draft: drafted.draft, facts: matrix, authorities: research, coverage: drafted.verification.coverage });
  const quality = qualityGate({ claims: research.flatMap((record) => record.claims), findings: adversarial, coverage: drafted.verification.coverage });
  return { matrix, research, draft: drafted.draft, verification: drafted.verification, structure: drafted.structure, adversarial, quality };
}
