/**
 * Legal tools for the agent loop. Registered in src/runtime.ts next to the
 * knowledge tools and exposed ONLY in the `legal` mode allowlist
 * (src/modes/catalog.ts). Every tool:
 *  - records retrieved article-version ids in the per-task retrieval ledger
 *    (verify warns NOT_RETRIEVED_IN_RUN for citations the run never looked up);
 *  - returns official text verbatim with a ⟦cite:ID⟧ token the model must copy;
 *  - checks egress before returning client (matter/contract) text to the model;
 *  - writes audit events with metadata only.
 * Changing a matter's egress policy is deliberately NOT a tool (UI only).
 */
import fs from "node:fs";
import path from "node:path";
import { renderCitationAr } from "../legal/citation.js";
import { contractLanguage, segmentContract } from "../legal/contract/clauses.js";
import { DEFAULT_QATAR_PLAYBOOK, reviewContract, type ContractType } from "../legal/contract/playbook.js";
import { buildRedlineDocx } from "../legal/contract/redline.js";
import { buildOriginalRedlineDocx } from "../legal/contract/ooxmlRedline.js";
import type { LegalCorpus } from "../legal/corpusStore.js";
import { sha256 } from "../legal/corpusStore.js";
import { decideEgress, type EgressConfig } from "../legal/egress.js";
import type { MattersStore } from "../legal/mattersStore.js";
import { qatarToday } from "../legal/mattersStore.js";
import { parseLabel } from "../legal/normalize.js";
import { checkStructure, internalLeaks, type DocKind } from "../legal/memo.js";
import { redactForCloud } from "../legal/redact.js";
import { searchLaw, type Embedder, type Reranker } from "../legal/retrieval.js";
import { canExportFinal, markVerified, newReview, onContentChanged } from "../legal/review.js";
import type { Matter } from "../legal/types.js";
import { reportToText, verifyDocument } from "../legal/verify.js";
import { bool, num, str, type Tool, type ToolContext, type ToolResult } from "./registry.js";

export const LEGAL_TOOL_NAMES = [
  "legal_search", "legal_article", "legal_cite_check", "legal_memo_check",
  "contract_import", "contract_clauses", "contract_review", "contract_redline",
] as const;
export const LEGAL_READ_TOOLS: readonly string[] = ["legal_search", "legal_article", "legal_cite_check", "legal_memo_check", "contract_clauses", "contract_review"];
export const LEGAL_WRITE_TOOLS: readonly string[] = ["contract_import", "contract_redline"];

export interface LegalToolDeps {
  corpus: LegalCorpus;
  matters: MattersStore;
  egress: EgressConfig;
  /** Model the current run uses (src/index.ts records it per task). */
  runModelFor(taskId: string | undefined): string;
  embedder?: Embedder;
  embedModel?: string;
  reranker?: Reranker;
  /** Loam's local extractor (src/knowledge/importers.ts) for .pdf/.docx. */
  extractText?: (absPath: string) => Promise<string>;
  actor?: string;
  now?: () => Date;
}

const MAX_OUT = 15_000; // stays under registry truncate (16,000)
const ok = (content: string): ToolResult => ({ ok: true, content: content.length > MAX_OUT ? `${content.slice(0, MAX_OUT)}\n…[truncated]` : content });
const fail = (content: string): ToolResult => ({ ok: false, content });

/** Resolve a workspace-relative path; refuses anything outside the task workspace. */
export function insideWorkspace(ctx: ToolContext, rel: string): string | null {
  if (!rel.trim()) return null;
  const root = path.resolve(ctx.workspace);
  const abs = path.resolve(root, rel);
  return abs === root || abs.startsWith(root + path.sep) ? abs : null;
}

function matterOf(deps: LegalToolDeps, args: Record<string, unknown>): Matter | null | "missing" {
  const id = str(args, "matterId");
  if (!id) return null;
  return deps.matters.getMatter(id) ?? "missing";
}

function asOfFor(args: Record<string, unknown>, matter: Matter | null, deps: LegalToolDeps): string {
  const explicit = str(args, "asOf");
  if (/^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;
  return matter?.asOf ?? qatarToday(deps.now?.() ?? new Date());
}

/** Gate for returning client text to the model of this run. */
function clientTextFor(deps: LegalToolDeps, ctx: ToolContext, matter: Matter, text: string): { text: string; note: string } | { denied: string } {
  const model = deps.runModelFor(ctx.taskId);
  const d = decideEgress(matter, model, "contract_text", deps.egress);
  deps.matters.audit.append(deps.actor ?? "agent", "egress.decision", matter.id, "client text to model", { model, allow: d.allow, redact: d.allow ? d.redact : false });
  if (!d.allow) return { denied: d.reason };
  if (!d.redact) return { text, note: "" };
  const r = redactForCloud(text, matter.parties);
  return { text: r.text, note: `(redacted for cloud model: ${Object.entries(r.counts).map(([k, v]) => `${k}=${v}`).join(", ") || "nothing found"})` };
}

async function readDocArg(deps: LegalToolDeps, ctx: ToolContext, args: Record<string, unknown>): Promise<{ text: string; name: string } | string> {
  const inline = str(args, "text");
  if (inline.trim()) return { text: inline, name: str(args, "name", "inline-draft.md") };
  const rel = str(args, "path");
  const abs = insideWorkspace(ctx, rel);
  if (!abs) return "path is required and must be inside the task workspace";
  if (!fs.existsSync(abs)) return `file not found: ${rel}`;
  const ext = path.extname(abs).toLowerCase();
  if (ext === ".md" || ext === ".txt") return { text: fs.readFileSync(abs, "utf8"), name: path.basename(abs) };
  if ((ext === ".pdf" || ext === ".docx") && deps.extractText) return { text: await deps.extractText(abs), name: path.basename(abs) };
  return `unsupported file type ${ext || "(none)"} (use .md, .txt, .pdf or .docx)`;
}

export function createLegalTools(deps: LegalToolDeps): Tool[] {
  const actor = deps.actor ?? "agent";

  const legalSearch: Tool = {
    name: "legal_search",
    description:
      "Search the verified Qatari legislation corpus (articles with their in-force version at a date). " +
      "Returns official text verbatim with a ⟦cite:ID⟧ token. In drafts, quote the text exactly in «…» immediately followed by the token. " +
      "If it returns NO_AUTHORITY, do not cite anything for that point: write [غير موثّق — يحتاج بحث محامٍ].",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Arabic or English: topic, or 'المادة 171 من القانون المدني'." },
        asOf: { type: "string", description: "YYYY-MM-DD date the law is applied at; default the matter date or today (Asia/Qatar)." },
        lawKey: { type: "string", description: "Restrict to one legislation, e.g. law/2004/22." },
        matterId: { type: "string" },
        k: { type: "number", description: "1-20, default 6." },
        includeHistorical: { type: "boolean", description: "Also return versions not in force at asOf." },
      },
      required: ["query"],
    },
    async run(args, ctx) {
      const query = str(args, "query").trim();
      if (!query) return fail("query is required");
      const matter = matterOf(deps, args);
      if (matter === "missing") return fail("matter not found");
      const asOf = asOfFor(args, matter, deps);
      const res = await searchLaw(deps.corpus, query, {
        asOf, k: num(args, "k", 6), includeHistorical: bool(args, "includeHistorical"),
        ...(str(args, "lawKey") ? { lawKey: str(args, "lawKey") } : {}),
        ...(deps.embedder && deps.embedModel ? { embedder: deps.embedder, embedModel: deps.embedModel } : {}),
        ...(deps.reranker ? { reranker: deps.reranker } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      deps.matters.audit.append(actor, "search", matter?.id ?? null, "legal_search", { hits: res.hits.length, mode: res.mode, asOf, queryChars: query.length });
      if (res.noAuthority) {
        return ok(`NO_AUTHORITY asOf=${asOf}: no article in the verified corpus matches. Do not cite. Mark the point with [غير موثّق — يحتاج بحث محامٍ].`);
      }
      if (ctx.taskId) deps.matters.ledgerAdd(ctx.taskId, res.hits.filter((h) => h.citable).map((h) => h.avid));
      const blocks = res.hits.map((h) => {
        const r = deps.corpus.resolve(h.avid, asOf);
        const ref = r ? renderCitationAr(r, deps.corpus, h.status !== "in_force") : h.legTitle;
        const flags = [`status=${h.status}`, `from=${h.effectiveFrom}`, `to=${h.effectiveTo ?? "-"}`, `provenance=${h.provenance}`, `citable=${h.citable ? "yes" : "NO"}`];
        const head = h.citable ? `⟦cite:${h.avid}${h.status === "in_force" ? "" : "|historical"}⟧` : "(NOT CITABLE: unverified source — use only to guide research)";
        return `${head} ${ref}\n${flags.join(" ")}\n«${h.text}»${h.truncated ? " …[text truncated: call legal_article for the full text]" : ""}`;
      });
      return ok(`asOf=${asOf} mode=${res.mode}${res.direct ? " direct" : ""}\n\n${blocks.join("\n\n")}`);
    },
  };

  const legalArticle: Tool = {
    name: "legal_article",
    description: "Full official text of one article at a date, with its version history and amendment chain. Give id (QL-…) or lawKey + label (+ part).",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" }, lawKey: { type: "string" }, label: { type: "string", description: "171, 115 مكرراً, ١٢ …" },
        part: { type: "string", enum: ["body", "issuance"] }, asOf: { type: "string" }, matterId: { type: "string" },
      },
    },
    async run(args, ctx) {
      const matter = matterOf(deps, args);
      if (matter === "missing") return fail("matter not found");
      const asOf = asOfFor(args, matter, deps);
      let artKey: string | undefined;
      const id = str(args, "id");
      if (id) artKey = deps.corpus.getVersion(id)?.articleKey;
      else {
        const leg = deps.corpus.resolveLegislationRef(str(args, "lawKey"));
        const label = str(args, "label");
        const part = str(args, "part", "body") === "issuance" ? "issuance" : "body";
        if (leg && label) {
          const p = parseLabel(label);
          if (p) artKey = `${leg.key}:${part}:${p.label}`;
        }
      }
      const article = artKey ? deps.corpus.getArticle(artKey) : undefined;
      if (!artKey || !article) return fail("NOT_FOUND: this article does not exist in the verified corpus. Do not cite it.");
      const versions = deps.corpus.versionsOf(artKey);
      const current = deps.corpus.versionAt(artKey, asOf);
      if (ctx.taskId) deps.matters.ledgerAdd(ctx.taskId, versions.map((v) => v.avid));
      const lines: string[] = [];
      if (current) {
        const r = deps.corpus.resolve(current.avid, asOf);
        lines.push(`⟦cite:${current.avid}⟧ ${r ? renderCitationAr(r, deps.corpus) : artKey}`, `«${current.text}»`);
      } else {
        lines.push(`NOT_IN_FORCE at ${asOf}: no version of ${artKey} applies on that date (repealed or not yet in force). Cite a version only with |historical and say so in the text.`);
      }
      lines.push("", "Versions:");
      for (const v of versions) lines.push(`- ${v.avid} from=${v.effectiveFrom} to=${v.effectiveTo ?? "-"} origin=${v.origin}${v.introducedBy ? ` introducedBy=${v.introducedBy}` : ""}`);
      const chain = deps.corpus.amendmentsOf(artKey);
      if (chain.length > 0) {
        lines.push("", "Amendments:");
        for (const a of chain) lines.push(`- ${a.kind} by ${a.amendingLegKey} art. ${a.amendingArticle} effective ${a.effectiveDate}`);
      }
      return ok(lines.join("\n"));
    },
  };

  const citeCheck: Tool = {
    name: "legal_cite_check",
    description:
      "Verify every citation in a draft against the official corpus at the matter date: exact quotes, existing articles, in-force versions, and uncited article/law mentions. " +
      "Must pass before a draft is presented. On fail, follow the REFUSAL instructions in the result.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Workspace-relative .md/.txt/.docx/.pdf" }, text: { type: "string" }, name: { type: "string" }, matterId: { type: "string" }, asOf: { type: "string" } },
    },
    async run(args, ctx) {
      const matter = matterOf(deps, args);
      if (matter === "missing") return fail("matter not found");
      const doc = await readDocArg(deps, ctx, args);
      if (typeof doc === "string") return fail(doc);
      const asOf = asOfFor(args, matter, deps);
      const report = verifyDocument(deps.corpus, doc.text, { asOf, ...(ctx.taskId ? { ledger: deps.matters.ledger(ctx.taskId) } : {}) });
      deps.matters.audit.append(actor, "cite_check", matter?.id ?? null, doc.name, { verdict: report.verdict, cited: report.counts.cited, failed: report.counts.failed, sha256: report.documentSha256 });
      if (matter) recordReview(deps, matter, doc.name, report, actor);
      return { ok: report.verdict !== "fail", content: reportToText(report) };
    },
  };

  const memoCheck: Tool = {
    name: "legal_memo_check",
    description: "Check a defense memorandum, legal opinion or contract-review report: required sections in order, citations (as legal_cite_check), and no internal artefacts in the rendered text.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["defense_memo", "opinion", "contract_report"] },
        path: { type: "string" }, text: { type: "string" }, name: { type: "string" }, matterId: { type: "string" }, asOf: { type: "string" },
      },
      required: ["kind"],
    },
    async run(args, ctx) {
      const kind = str(args, "kind") as DocKind;
      if (!["defense_memo", "opinion", "contract_report"].includes(kind)) return fail("kind must be defense_memo, opinion or contract_report");
      const matter = matterOf(deps, args);
      if (matter === "missing") return fail("matter not found");
      const doc = await readDocArg(deps, ctx, args);
      if (typeof doc === "string") return fail(doc);
      const asOf = asOfFor(args, matter, deps);
      const report = verifyDocument(deps.corpus, doc.text, { asOf, ...(ctx.taskId ? { ledger: deps.matters.ledger(ctx.taskId) } : {}) });
      const issues = [...checkStructure(kind, doc.text), ...(report.renderedDocument ? internalLeaks(report.renderedDocument) : [])];
      const errors = issues.filter((i) => i.level === "error");
      deps.matters.audit.append(actor, "cite_check", matter?.id ?? null, doc.name, { kind, verdict: report.verdict, structureErrors: errors.length, sha256: report.documentSha256 });
      if (matter && errors.length === 0) recordReview(deps, matter, doc.name, report, actor);
      const structure = issues.length ? issues.map((i) => `- [${i.level}:${i.code}] ${i.messageAr}`).join("\n") : "- structure OK";
      return { ok: report.verdict !== "fail" && errors.length === 0, content: `STRUCTURE (${kind}):\n${structure}\n\nCITATIONS:\n${reportToText(report)}` };
    },
  };

  const contractImport: Tool = {
    name: "contract_import",
    description: "Import a contract file from the task workspace into a matter (stored encrypted, split into clauses). Returns the contract id.",
    parameters: { type: "object", properties: { matterId: { type: "string" }, path: { type: "string" } }, required: ["matterId", "path"] },
    async run(args, ctx) {
      const matter = matterOf(deps, args);
      if (!matter || matter === "missing") return fail("matterId of an existing matter is required");
      const doc = await readDocArg(deps, ctx, { path: str(args, "path") });
      if (typeof doc === "string") return fail(doc);
      const c = deps.matters.addContract(matter.id, { fileName: doc.name, mime: path.extname(doc.name), text: doc.text, language: contractLanguage(doc.text) }, actor);
      const clauses = segmentContract(c.id, c.text);
      deps.matters.saveClauses(c.id, clauses);
      return ok(`contractId=${c.id} clauses=${clauses.length} language=${c.language} sha256=${c.sha256.slice(0, 12)}`);
    },
  };

  const contractClauses: Tool = {
    name: "contract_clauses",
    description: "List a contract's clauses with categories. Clause text is included only if this run's model may see the matter's text (egress policy).",
    parameters: { type: "object", properties: { matterId: { type: "string" }, contractId: { type: "string" }, withText: { type: "boolean" } }, required: ["matterId", "contractId"] },
    async run(args, ctx) {
      const matter = matterOf(deps, args);
      if (!matter || matter === "missing") return fail("matter not found");
      const contract = deps.matters.getContract(str(args, "contractId"));
      if (!contract || contract.matterId !== matter.id) return fail("contract not found in this matter");
      const clauses = deps.matters.clauses(contract.id);
      if (!bool(args, "withText", true)) return ok(clauses.map((c) => `${c.id} | ${c.heading} | ${c.categories.join(",")}`).join("\n"));
      const gate = clientTextFor(deps, ctx, matter, clauses.map((c) => `### ${c.id} | ${c.categories.join(",")}\n${c.text}`).join("\n\n"));
      if ("denied" in gate) return ok(`TEXT WITHHELD (${gate.denied}). Headings only:\n${clauses.map((c) => `${c.id} | ${c.heading} | ${c.categories.join(",")}`).join("\n")}`);
      return ok(`${gate.note}\n${gate.text}`.trim());
    },
  };

  const contractReviewTool: Tool = {
    name: "contract_review",
    description: "Run the Qatari playbook on a contract at the matter date. Returns findings with severity, clause, and pinned/suggested authorities (⟦cite:ID⟧ tokens). Suggested authorities must be confirmed by legal_article before use.",
    parameters: {
      type: "object",
      properties: { matterId: { type: "string" }, contractId: { type: "string" }, contractType: { type: "string", enum: ["any", "employment", "commercial_agency", "lease", "services", "sale", "nda"] } },
      required: ["matterId", "contractId"],
    },
    async run(args, ctx) {
      const matter = matterOf(deps, args);
      if (!matter || matter === "missing") return fail("matter not found");
      const contract = deps.matters.getContract(str(args, "contractId"));
      if (!contract || contract.matterId !== matter.id) return fail("contract not found in this matter");
      const findings = await reviewContract(deps.matters.clauses(contract.id), DEFAULT_QATAR_PLAYBOOK, {
        corpus: deps.corpus, asOf: matter.asOf, contractType: (str(args, "contractType", "any") as ContractType), fullText: contract.text,
      });
      const avids = findings.flatMap((f) => [...f.authorities, ...f.suggestedAuthorities]);
      if (ctx.taskId) deps.matters.ledgerAdd(ctx.taskId, avids);
      deps.matters.audit.append(actor, "contract.review", matter.id, contract.id, { findings: findings.length, high: findings.filter((f) => f.severity === "high").length });
      if (findings.length === 0) return ok("No playbook findings. This does not mean the contract is risk-free.");
      const rows = findings.map((f) =>
        `- [${f.severity}] ${f.ruleId} ${f.clauseId ?? "(whole contract)"}: ${f.titleAr}\n  ${f.explanationAr}${f.suggestionAr ? `\n  اقتراح: ${f.suggestionAr}` : ""}` +
        `${f.authorities.length ? `\n  pinned: ${f.authorities.map((a) => `⟦cite:${a}⟧`).join(" ")}` : ""}` +
        `${f.suggestedAuthorities.length ? `\n  suggested (confirm with legal_article): ${f.suggestedAuthorities.join(" ")}` : ""}` +
        `${f.unresolvedAuthorityQueries.length ? `\n  unresolved: ${f.unresolvedAuthorityQueries.join(" | ")}` : ""}`);
      return ok(rows.join("\n"));
    },
  };

  const contractRedline: Tool = {
    name: "contract_redline",
    description: "Write a DOCX with Word tracked changes (insertions/deletions) for proposed clause edits. Exports a watermarked draft unless the redline document is approved by a licensed lawyer in the review gate.",
    parameters: {
      type: "object",
      properties: {
        matterId: { type: "string" }, contractId: { type: "string" },
        edits: { type: "array", items: { type: "object", properties: { clauseId: { type: "string" }, newText: { type: "string" } }, required: ["clauseId", "newText"] } },
        outPath: { type: "string", description: "Workspace-relative .docx path" },
      },
      required: ["matterId", "contractId", "edits", "outPath"],
    },
    async run(args, ctx) {
      const matter = matterOf(deps, args);
      if (!matter || matter === "missing") return fail("matter not found");
      const contract = deps.matters.getContract(str(args, "contractId"));
      if (!contract || contract.matterId !== matter.id) return fail("contract not found in this matter");
      const out = insideWorkspace(ctx, str(args, "outPath"));
      if (!out || !out.toLowerCase().endsWith(".docx")) return fail("outPath must be a .docx path inside the task workspace");
      const rawEdits = Array.isArray(args.edits) ? args.edits : [];
      const clauses = deps.matters.clauses(contract.id);
      const ids = new Set(clauses.map((c) => c.id));
      const edits = rawEdits.flatMap((e) => {
        const o = e as Record<string, unknown>;
        return typeof o.clauseId === "string" && typeof o.newText === "string" && ids.has(o.clauseId) ? [{ clauseId: o.clauseId, newText: o.newText }] : [];
      });
      if (edits.length !== rawEdits.length) return fail("every edit needs a clauseId of this contract and newText");
      const fingerprint = sha256(JSON.stringify({ contract: contract.sha256, edits }));
      const docName = `redline:${contract.id}`;
      const review = deps.matters.reviewsOf(matter.id).find((r) => r.documentName === docName);
      const final = review ? canExportFinal(review, fingerprint) : false;
      const at = (deps.now?.() ?? new Date()).toISOString();
      const buf = contract.originalBase64
        ? await buildOriginalRedlineDocx(Buffer.from(contract.originalBase64, "base64"), clauses, edits, { author: "Loam Legal", date: at, rtl: contract.language !== "en", draft: !final })
        : await buildRedlineDocx(clauses, edits, { title: contract.fileName, author: "Loam", date: at, rtl: contract.language !== "en", draft: !final });
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, buf);
      deps.matters.audit.append(actor, final ? "export.final" : "export.draft", matter.id, docName, { edits: edits.length, sha256: fingerprint, bytes: buf.length });
      return ok(`wrote ${path.relative(ctx.workspace, out)} (${final ? "final" : "DRAFT — watermarked; needs lawyer approval"}) edits=${edits.length} fingerprint=${fingerprint.slice(0, 12)}`);
    },
  };

  return [legalSearch, legalArticle, citeCheck, memoCheck, contractImport, contractClauses, contractReviewTool, contractRedline];
}

/** Create/advance the review record of a document after a passing check. */
function recordReview(deps: LegalToolDeps, matter: Matter, documentName: string, report: ReturnType<typeof verifyDocument>, actor: string): void {
  const at = (deps.now?.() ?? new Date()).toISOString();
  let rec = deps.matters.reviewsOf(matter.id).find((r) => r.documentName === documentName) ?? newReview(matter.id, documentName);
  const before = rec.state;
  rec = onContentChanged(rec, report.documentSha256, actor, at);
  if (report.verdict !== "fail" && rec.state !== "in_review") rec = markVerified(rec, report, actor, at);
  deps.matters.saveReview(rec);
  if (rec.state !== before) deps.matters.audit.append(actor, "review.transition", matter.id, documentName, { from: before, to: rec.state, sha256: report.documentSha256 });
}
