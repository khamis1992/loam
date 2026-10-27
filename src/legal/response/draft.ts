import type { LegalCorpus } from "../corpusStore.js";
import type { EgressConfig } from "../egress.js";
import { checkStructure, internalLeaks, type StructureIssue } from "../memo.js";
import { DEFENSE_DRAFT_SCHEMA } from "../model/schemas.js";
import { callLegalStructured } from "../model/structured.js";
import type { LegalModelPort } from "../model/types.js";
import { verifyDocument } from "../verify.js";
import type { Matter, VerificationReport } from "../types.js";
import type { AdversarialFinding, ResearchRecord } from "../analysis/types.js";
import type { AllegationResponseMatrix } from "./types.js";

export async function draftLegalResponse(
  corpus: LegalCorpus,
  model: { port: LegalModelPort; config: EgressConfig },
  input: { matter: Matter; matrix: AllegationResponseMatrix; research: ResearchRecord[]; revision?: { draft: string; findings: AdversarialFinding[] } },
): Promise<{ draft: string; verification: VerificationReport; structure: StructureIssue[] }> {
  const consulted = new Set(input.research.flatMap((record) => record.consultedAvids));
  const sources = input.research.flatMap((record) => record.consultedAvids.map((avid) => {
    const resolved = corpus.resolve(avid, record.asOf);
    return resolved ? { avid, reference: `${resolved.legislation.titleAr} — المادة ${resolved.article.label}`, text: resolved.version.text } : null;
  }).filter(Boolean));
  let revision: unknown = input.revision;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await callLegalStructured<{ markdown: string }>(model.port, {
      contract: "legal-response-draft",
      model: model.config.localModel,
      schema: DEFENSE_DRAFT_SCHEMA,
      repairAttempts: 2,
      messages: [
        { role: "system", content: "Draft a precise Arabic legal response as an expert defense lawyer. Address every allegation in the matrix with its disposition and evidence. Avoid unintended admissions or waiver. Use ## بيانات الدعوى, ## الوقائع, ## الدفوع الشكلية والإجرائية when applicable, ## الدفاع الموضوعي, ## الطلبات. Copy exact short quotes verbatim in «…» followed by ⟦cite:QL-xxxxxxxxxx⟧ from supplied sources only; never paraphrase a quote. Do not invent facts or authorities or internal notes. Follow each burden of proof exactly as the supplied source states it; never shift a burden to the opponent unless the cited text expressly does so. Do not add procedural defenses or requests outside the approved matrix. Treat the matter title as the client's objective, never as an opponent's admission. When revision feedback or validationErrors are supplied, fix every reported defect without adding facts: do not deny and reduce the same obligation, do not request relief with missing proof, and keep every request consistent with the matrix and proven record." },
        { role: "user", content: JSON.stringify({ matter: input.matter, matrix: input.matrix, research: input.research, sources, revision }) },
      ],
    });
    if (!result.ok) throw new Error(`legal response draft contract failed: ${result.issues.join("; ")}`);
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
    if (attempt === 2) throw new Error(`legal response draft validation failed after repair: ${errors.join("; ")}`);
    revision = { draft, findings: input.revision?.findings ?? [], validationErrors: errors };
  }
  throw new Error("unreachable legal response draft validation");
}
