import type { LegalCorpus } from "../corpusStore.js";
import { CLAIM_SUPPORT_SCHEMA } from "../model/schemas.js";
import { callLegalStructured } from "../model/structured.js";
import type { LegalModelPort } from "../model/types.js";
import type { EgressConfig } from "../egress.js";
import { searchLaw } from "../retrieval.js";
import type { ClaimSupport, LegalIssue, ResearchRecord } from "./types.js";
import type { FactAssertion } from "../evidence/types.js";
import { researchInputHash } from "./researchCache.js";

export async function researchIssue(corpus: LegalCorpus, model: { port: LegalModelPort; config: EgressConfig }, issue: LegalIssue, asOf: string, factRecords: Array<Pick<FactAssertion, "id" | "text" | "kind" | "status">> = []): Promise<ResearchRecord> {
  const inputSha256 = researchInputHash(corpus, issue, asOf, factRecords, model.config.localModel);
  const queries: string[] = [];
  const consulted = new Map<string, { avid: string; text: string; reference: string }>();
  for (const query of [...new Set([...issue.researchQueries, issue.title])]) {
    queries.push(query);
    const result = await searchLaw(corpus, query, { asOf, k: 6, matterKind: issue.kind === "contractual" ? "contract_review" : "research" });
    for (const hit of result.hits.filter((candidate) => candidate.citable)) {
      consulted.set(hit.avid, { avid: hit.avid, text: hit.text, reference: `${hit.legTitle} — المادة ${hit.label}` });
    }
  }
  const sources = [...consulted.values()];
  if (sources.length === 0) {
    return {
      issueId: issue.id, inputSha256, asOf, queries, consultedAvids: [],
      claims: [{ id: `claim-${issue.id}`, text: issue.title, support: "not_researched", authorityAvids: [], evidenceFactIds: issue.facts, exceptions: [], reason: "No citable authority was retrieved for this issue" }],
    };
  }
  const result = await callLegalStructured<{ claims: ClaimSupport[] }>(model.port, {
    contract: `legal-research:${issue.id}`,
    model: model.config.localModel,
    schema: CLAIM_SUPPORT_SCHEMA,
    repairAttempts: 2,
    messages: [
      { role: "system", content: `You are a Qatari legal analysis assistant. Assess only the supplied issue, not side questions. Return exactly one claim with id claim-${issue.id}. Use only supplied sources, check every element and exception, and return no authority id outside the supplied set. Every supported legal claim must cite its supporting source ids explicitly in authorityAvids and every relied-on fact id in evidenceFactIds; never leave authorityAvids empty for a supported legal proposition. Assess the supplied evidence text and review status, not merely the existence of fact ids; never infer a fact or amount from an id or title. Mark support insufficient or not_researched when the sources or linked facts do not support this issue; never add claims about missing authority or other topics.` },
      { role: "user", content: JSON.stringify({ issue, evidence: factRecords.filter((fact) => issue.facts.includes(fact.id)), sources }) },
    ],
  });
  if (!result.ok) throw new Error(`legal research contract failed for ${issue.id}: ${result.issues.join("; ")}`);
  const claims = result.value.claims.map((claim) => {
    const authorityAvids = (claim.authorityAvids ?? []).filter((avid) => consulted.has(avid));
    const evidenceFactIds = (claim.evidenceFactIds ?? []).filter((id) => issue.facts.includes(id));
    const normalized = { ...claim, authorityAvids, evidenceFactIds, exceptions: claim.exceptions ?? [] };
    const invalidAuthorities = (claim.authorityAvids ?? []).filter((avid) => !consulted.has(avid));
    const invalidFacts = (claim.evidenceFactIds ?? []).filter((id) => !issue.facts.includes(id));
    const unsupported = claim.support === "supported" && authorityAvids.length === 0 && evidenceFactIds.length === 0;
    if (invalidAuthorities.length === 0 && invalidFacts.length === 0 && !unsupported) return normalized;
    return { ...normalized, support: "insufficient" as const, reason: `${claim.reason} Unlinked or unretrieved support rejected. Invalid authorities: ${invalidAuthorities.join(",") || "none"}; invalid facts: ${invalidFacts.join(",") || "none"}.` };
  });
  return { issueId: issue.id, inputSha256, asOf, queries, consultedAvids: [...consulted.keys()], claims };
}
