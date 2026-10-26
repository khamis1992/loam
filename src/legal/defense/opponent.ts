import type { EgressConfig } from "../egress.js";
import { adversarialReview } from "../analysis/adversarial.js";
import type { LegalModelPort } from "../model/types.js";
import type { AdversarialFinding } from "../analysis/types.js";
import type { CaseTheory } from "./types.js";

export function opposeDefense(model: { port: LegalModelPort; config: EgressConfig }, input: { draft: string; theory: CaseTheory; research: unknown; coverage: unknown }): Promise<AdversarialFinding[]> {
  return adversarialReview(model, { draft: input.draft, facts: input.theory, authorities: input.research, coverage: input.coverage });
}
