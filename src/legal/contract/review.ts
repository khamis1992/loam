import crypto from "node:crypto";
import type { EgressConfig } from "../egress.js";
import { CONTRACT_ANALYSIS_SCHEMA } from "../model/schemas.js";
import { callLegalStructured } from "../model/structured.js";
import type { LegalModelPort } from "../model/types.js";
import { reviewContract, type Playbook, type ReviewContext } from "./playbook.js";
import { negotiationPlan } from "./negotiation.js";
import type { ClientPosition, ContractReviewReport, RiskTolerance } from "./types.js";
import type { Clause, ReviewFinding } from "../types.js";
import type { Contradiction } from "../evidence/types.js";

export interface DetailedReviewContext extends ReviewContext {
  clientPosition: ClientPosition;
  riskTolerance: RiskTolerance;
}

export async function reviewContractDetailed(
  clauses: Clause[],
  playbook: Playbook,
  ctx: DetailedReviewContext,
  model: { port: LegalModelPort; config: EgressConfig },
  bilingualFindings: Contradiction[] = [],
): Promise<ContractReviewReport> {
  const deterministic = await reviewContract(clauses, playbook, ctx);
  const generated = await callLegalStructured<{ findings: ReviewFinding[] }>(model.port, {
    contract: `contract-analysis:${ctx.contractType}:${ctx.clientPosition}`,
    model: model.config.localModel,
    schema: CONTRACT_ANALYSIS_SCHEMA,
    repairAttempts: 2,
    messages: [
      { role: "system", content: "Review the contract as a lawyer protecting the specified client. Identify only material clause risks, missing protections, conflicts, and negotiation points supported by the contract. Do not invent article numbers or facts. Findings are leads for a lawyer, not legal conclusions." },
      { role: "user", content: JSON.stringify({ contractType: ctx.contractType, clientPosition: ctx.clientPosition, riskTolerance: ctx.riskTolerance, clauses, deterministicFindings: deterministic }) },
    ],
  });
  if (!generated.ok) throw new Error(`contract analysis contract failed: ${generated.issues.join("; ")}`);
  const clauseIds = new Set(clauses.map((clause) => clause.id));
  const contextual = generated.value.findings.map((finding) => ({
    ...finding,
    id: `fd-model-${crypto.createHash("sha256").update(`${finding.id}|${finding.clauseId ?? ""}|${finding.titleAr}`).digest("hex").slice(0, 10)}`,
    clauseId: finding.clauseId && clauseIds.has(finding.clauseId) ? finding.clauseId : null,
    authorities: [], suggestedAuthorities: [], unresolvedAuthorityQueries: ["Contextual finding requires lawyer confirmation and authority review"],
  }));
  const ids = new Set(deterministic.map((finding) => finding.id));
  const findings = [...deterministic, ...contextual.filter((finding) => !ids.has(finding.id))];
  return {
    clientPosition: ctx.clientPosition,
    riskTolerance: ctx.riskTolerance,
    findings,
    bilingualFindings,
    negotiation: negotiationPlan(findings, ctx.riskTolerance),
    coverage: ctx.corpus.coverage({ asOf: ctx.asOf, matterKind: "contract_review" }),
    corpusSnapshotId: ctx.corpus.snapshot({ persist: false }).id,
  };
}
