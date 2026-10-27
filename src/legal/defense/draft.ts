import type { LegalCorpus } from "../corpusStore.js";
import type { EgressConfig } from "../egress.js";
import { checkStructure, internalLeaks, type StructureIssue } from "../memo.js";
import { DEFENSE_DRAFT_SCHEMA } from "../model/schemas.js";
import { callLegalStructured } from "../model/structured.js";
import type { LegalModelPort } from "../model/types.js";
import { verifyDocument } from "../verify.js";
import type { Matter, VerificationReport } from "../types.js";
import type { AdversarialFinding, ResearchRecord } from "../analysis/types.js";
import type { FactAssertion } from "../evidence/types.js";
import type { CaseTheory } from "./types.js";

export async function draftDefenseMemo(
  corpus: LegalCorpus,
  model: { port: LegalModelPort; config: EgressConfig },
  input: { matter: Matter; theory: CaseTheory; research: ResearchRecord[]; facts: FactAssertion[]; revision?: { draft: string; findings: AdversarialFinding[] } },
): Promise<{ draft: string; verification: VerificationReport; structure: StructureIssue[] }> {
  const consulted = new Set(input.research.flatMap((record) => record.consultedAvids));
  const sources = input.research.flatMap((record) => record.consultedAvids.map((avid) => {
    const resolved = corpus.resolve(avid, record.asOf);
    return resolved ? { avid, reference: `${resolved.legislation.titleAr} — المادة ${resolved.article.label}`, text: resolved.version.text } : null;
  }).filter(Boolean));
  let revision: unknown = input.revision;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await callLegalStructured<{ markdown: string }>(model.port, {
      contract: "defense-memo-draft",
      model: model.config.localModel,
      schema: DEFENSE_DRAFT_SCHEMA,
      repairAttempts: 2,
      messages: [
        { role: "system", content: "Draft a persuasive Arabic defense memorandum for a Qatari court. Use only facts and exact source texts supplied. Use this exact structure: ## بيانات الدعوى, ## الوقائع, ## الدفوع الشكلية والإجرائية (only if applicable), ## الدفاع الموضوعي, ## الطلبات. Each legal proposition must use an exact short quote in «…» followed immediately by ⟦cite:QL-xxxxxxxxxx⟧ from the supplied sources. Copy every quote verbatim; never paraphrase it. Never invent article ids, facts, case numbers or authorities. Follow each burden of proof exactly as the supplied source states it; never shift a burden to the opponent unless the cited text expressly does so. Address weaknesses and opposing arguments without adding procedural defenses or requests outside the approved theory. Treat the matter title as the client's objective, never as an opponent's admission. Do not include internal notes or disclaimers. When revision feedback or validationErrors are supplied, fix every reported defect without adding facts: keep requests consistent with the theory and proven record, never deny and reduce the same obligation, and never request a specific amount unsupported by evidence." },
        { role: "user", content: JSON.stringify({ matter: input.matter, theory: input.theory, research: input.research, facts: input.facts, sources, revision }) },
      ],
    });
    if (!result.ok) throw new Error(`defense draft contract failed: ${result.issues.join("; ")}`);
    const draft = result.value.markdown;
    const used = [...draft.matchAll(/⟦cite:(QL-[0-9a-f]{10})(?:\|historical)?⟧/g)].map((match) => match[1]!);
    const outside = used.filter((avid) => !consulted.has(avid));
    const verification = verifyDocument(corpus, draft, { asOf: input.matter.asOf, ledger: consulted, matterKind: "defense_memo" });
    const structure = [...checkStructure("defense_memo", draft), ...(verification.renderedDocument ? internalLeaks(verification.renderedDocument) : [])];
    const errors = [
      ...(outside.length ? [`unretrieved authorities: ${outside.join(",")}`] : []),
      ...verification.checks.filter((check) => !["OK", "VERIFIED", "VERIFIED_NORMALIZED"].includes(check.status)).map((check) => `${check.status}: ${check.messageAr}`),
      ...structure.filter((issue) => issue.level === "error").map((issue) => `structure ${issue.code}: ${issue.messageAr}`),
    ];
    if (errors.length === 0) return { draft, verification, structure };
    if (attempt === 2) throw new Error(`defense draft validation failed after repair: ${errors.join("; ")}`);
    revision = { draft, findings: input.revision?.findings ?? [], validationErrors: errors };
  }
  throw new Error("unreachable defense draft validation");
}
