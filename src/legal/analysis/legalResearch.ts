import type { LegalCorpus } from "../corpusStore.js";
import { CLAIM_SUPPORT_SCHEMA } from "../model/schemas.js";
import { callLegalStructured } from "../model/structured.js";
import type { LegalModelPort } from "../model/types.js";
import type { EgressConfig } from "../egress.js";
import { searchLaw } from "../retrieval.js";
import type { ClaimSupport, LegalIssue, ResearchRecord } from "./types.js";

export async function researchIssue(corpus: LegalCorpus, model: { port: LegalModelPort; config: EgressConfig }, issue: LegalIssue, asOf: string): Promise<ResearchRecord> {
  const queries: string[] = [];
  const consulted = new Map<string, { avid: string; text: string; reference: string }>();
  for (const query of issue.researchQueries) {
    queries.push(query);
    const result = await searchLaw(corpus, query, { asOf, k: 6, matterKind: issue.kind === "contractual" ? "contract_review" : "research" });
    for (const hit of result.hits.filter((candidate) => candidate.citable)) {
      consulted.set(hit.avid, { avid: hit.avid, text: hit.text, reference: `${hit.legTitle} — المادة ${hit.label}` });
    }
  }
  const sources = [...consulted.values()];
  if (sources.length === 0) {
    return {
      issueId: issue.id, asOf, queries, consultedAvids: [],
      claims: [{ id: `claim-${issue.id}`, text: issue.title, support: "not_researched", authorityAvids: [], evidenceFactIds: issue.facts, exceptions: [], reason: "No citable authority was retrieved for this issue" }],
    };
  }
  const result = await callLegalStructured<{ claims: ClaimSupport[] }>(model.port, {
    contract: `legal-research:${issue.id}`,
    model: model.config.localModel,
    schema: CLAIM_SUPPORT_SCHEMA,
    repairAttempts: 2,
    messages: [
      { role: "system", content: "You are a Qatari legal analysis assistant. Use only the supplied sources. A source quote is not automatically support: check every element and exception. Return no authority id outside the supplied set." },
      { role: "user", content: JSON.stringify({ issue, sources }) },
    ],
  });
  if (!result.ok) throw new Error(`legal research contract failed for ${issue.id}: ${result.issues.join("; ")}`);
  const claims = result.value.claims.map((claim) => {
    const invalid = claim.authorityAvids.filter((avid) => !consulted.has(avid));
    if (invalid.length === 0) return claim;
    return { ...claim, support: "insufficient" as const, authorityAvids: claim.authorityAvids.filter((avid) => consulted.has(avid)), reason: `${claim.reason} Unretrieved authority rejected: ${invalid.join(",")}` };
  });
  return { issueId: issue.id, asOf, queries, consultedAvids: [...consulted.keys()], claims };
}
