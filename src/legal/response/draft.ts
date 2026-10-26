import type { LegalCorpus } from "../corpusStore.js";
import type { EgressConfig } from "../egress.js";
import { checkStructure, internalLeaks, type StructureIssue } from "../memo.js";
import { DEFENSE_DRAFT_SCHEMA } from "../model/schemas.js";
import { callLegalStructured } from "../model/structured.js";
import type { LegalModelPort } from "../model/types.js";
import { verifyDocument } from "../verify.js";
import type { Matter, VerificationReport } from "../types.js";
import type { ResearchRecord } from "../analysis/types.js";
import type { AllegationResponseMatrix } from "./types.js";

export async function draftLegalResponse(
  corpus: LegalCorpus,
  model: { port: LegalModelPort; config: EgressConfig },
  input: { matter: Matter; matrix: AllegationResponseMatrix; research: ResearchRecord[] },
): Promise<{ draft: string; verification: VerificationReport; structure: StructureIssue[] }> {
  const consulted = new Set(input.research.flatMap((record) => record.consultedAvids));
  const sources = input.research.flatMap((record) => record.consultedAvids.map((avid) => {
    const resolved = corpus.resolve(avid, record.asOf);
    return resolved ? { avid, reference: `${resolved.legislation.titleAr} — المادة ${resolved.article.label}`, text: resolved.version.text } : null;
  }).filter(Boolean));
  const result = await callLegalStructured<{ markdown: string }>(model.port, {
    contract: "legal-response-draft",
    model: model.config.localModel,
    schema: DEFENSE_DRAFT_SCHEMA,
    repairAttempts: 2,
    messages: [
      { role: "system", content: "Draft a precise Arabic legal response as an expert defense lawyer. Address every allegation in the matrix with its disposition and evidence. Avoid unintended admissions or waiver. Use ## بيانات الدعوى, ## الوقائع, ## الدفوع الشكلية والإجرائية when applicable, ## الدفاع الموضوعي, ## الطلبات. Use exact quotes in «…» followed by ⟦cite:QL-xxxxxxxxxx⟧ from supplied sources only. Do not invent facts or authorities or internal notes." },
      { role: "user", content: JSON.stringify({ matter: input.matter, matrix: input.matrix, research: input.research, sources }) },
    ],
  });
  if (!result.ok) throw new Error(`legal response draft contract failed: ${result.issues.join("; ")}`);
  const draft = result.value.markdown;
  const used = [...draft.matchAll(/⟦cite:(QL-[0-9a-f]{10})(?:\|historical)?⟧/g)].map((match) => match[1]!);
  if (used.some((avid) => !consulted.has(avid))) throw new Error("response cited an unretrieved authority");
  const verification = verifyDocument(corpus, draft, { asOf: input.matter.asOf, ledger: consulted, matterKind: "defense_memo" });
  if (verification.verdict === "fail") throw new Error("legal response citation verification failed");
  const structure = [...checkStructure("defense_memo", draft), ...(verification.renderedDocument ? internalLeaks(verification.renderedDocument) : [])];
  if (structure.some((issue) => issue.level === "error")) throw new Error("legal response structure failed");
  return { draft, verification, structure };
}
