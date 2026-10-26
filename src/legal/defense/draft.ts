import type { LegalCorpus } from "../corpusStore.js";
import type { EgressConfig } from "../egress.js";
import { checkStructure, internalLeaks, type StructureIssue } from "../memo.js";
import { DEFENSE_DRAFT_SCHEMA } from "../model/schemas.js";
import { callLegalStructured } from "../model/structured.js";
import type { LegalModelPort } from "../model/types.js";
import { verifyDocument } from "../verify.js";
import type { Matter, VerificationReport } from "../types.js";
import type { ResearchRecord } from "../analysis/types.js";
import type { CaseTheory } from "./types.js";

export async function draftDefenseMemo(
  corpus: LegalCorpus,
  model: { port: LegalModelPort; config: EgressConfig },
  input: { matter: Matter; theory: CaseTheory; research: ResearchRecord[] },
): Promise<{ draft: string; verification: VerificationReport; structure: StructureIssue[] }> {
  const consulted = new Set(input.research.flatMap((record) => record.consultedAvids));
  const sources = input.research.flatMap((record) => record.consultedAvids.map((avid) => {
    const resolved = corpus.resolve(avid, record.asOf);
    return resolved ? { avid, reference: `${resolved.legislation.titleAr} — المادة ${resolved.article.label}`, text: resolved.version.text } : null;
  }).filter(Boolean));
  const result = await callLegalStructured<{ markdown: string }>(model.port, {
    contract: "defense-memo-draft",
    model: model.config.localModel,
    schema: DEFENSE_DRAFT_SCHEMA,
    repairAttempts: 2,
    messages: [
      { role: "system", content: "Draft a persuasive Arabic defense memorandum for a Qatari court. Use only facts and exact source texts supplied. Use this exact structure: ## بيانات الدعوى, ## الوقائع, ## الدفوع الشكلية والإجرائية (only if applicable), ## الدفاع الموضوعي, ## الطلبات. Each legal proposition must use an exact short quote in «…» followed immediately by ⟦cite:QL-xxxxxxxxxx⟧ from the supplied sources. Never invent article ids, facts, case numbers or authorities. Address weaknesses and opposing arguments. Do not include internal notes or disclaimers." },
      { role: "user", content: JSON.stringify({ matter: input.matter, theory: input.theory, research: input.research, sources }) },
    ],
  });
  if (!result.ok) throw new Error(`defense draft contract failed: ${result.issues.join("; ")}`);
  const draft = result.value.markdown;
  const used = [...draft.matchAll(/⟦cite:(QL-[0-9a-f]{10})(?:\|historical)?⟧/g)].map((match) => match[1]!);
  const outside = used.filter((avid) => !consulted.has(avid));
  if (outside.length > 0) throw new Error(`draft cited unretrieved authorities: ${outside.join(",")}`);
  const verification = verifyDocument(corpus, draft, { asOf: input.matter.asOf, ledger: consulted, matterKind: "defense_memo" });
  if (verification.verdict === "fail") throw new Error(`defense draft verification failed: ${verification.checks.filter((check) => !["OK", "VERIFIED", "VERIFIED_NORMALIZED"].includes(check.status)).map((check) => check.status).join(",")}`);
  const structure = [...checkStructure("defense_memo", draft), ...(verification.renderedDocument ? internalLeaks(verification.renderedDocument) : [])];
  if (structure.some((issue) => issue.level === "error")) throw new Error(`defense draft structure failed: ${structure.filter((issue) => issue.level === "error").map((issue) => issue.code).join(",")}`);
  return { draft, verification, structure };
}
