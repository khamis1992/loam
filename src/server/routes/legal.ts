/**
 * Legal mode HTTP surface. Mounted in src/server/http.ts next to the Knowledge
 * Garden, behind the same x-loam-local-token gate (http.ts:487-505):
 *
 *   import { handleLegalRoutes } from "./routes/legal.js";
 *   if (deps.legal && await handleLegalRoutes(req, res, p, deps.legal)) return;
 *
 *  GET    /api/legal/status
 *  GET    /api/legal/laws                               list legislations
 *  GET    /api/legal/laws/:type/:year/:number?asOf=     one legislation + articles at a date
 *  GET    /api/legal/search?q=&asOf=&lawKey=&k=&historical=
 *  GET    /api/legal/articles/:avid?asOf=               one version resolved + history
 *  POST   /api/legal/import/draft                       raw official text -> draft LegalPack
 *  POST   /api/legal/import                             import a reviewed LegalPack
 *  POST   /api/legal/verify                             verify a document (+ structure)
 *  GET    /api/legal/matters | POST /api/legal/matters
 *  GET    /api/legal/matters/:id | PATCH | DELETE
 *  GET    /api/legal/matters/:id/contracts | POST
 *  GET    /api/legal/matters/:id/contracts/:cid/clauses
 *  POST   /api/legal/matters/:id/contracts/:cid/review
 *  GET    /api/legal/matters/:id/reviews
 *  POST   /api/legal/reviews/:rid/(submit|approve|reject)
 *  GET    /api/legal/audit?matterId=&limit=  |  GET /api/legal/audit/verify
 *
 * Only this surface (a person at the UI) can change a matter's egress policy.
 */
import type http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LegalFileVault } from "../../legal/security/fileVault.js";
import type { EvidenceAnalysis } from "../../legal/evidence/service.js";
import { contractLanguage, segmentContract } from "../../legal/contract/clauses.js";
import { DEFAULT_QATAR_PLAYBOOK, type ContractType } from "../../legal/contract/playbook.js";
import { reviewContractDetailed } from "../../legal/contract/review.js";
import { buildOriginalRedlineDocx } from "../../legal/contract/ooxmlRedline.js";
import { buildRedlineDocx } from "../../legal/contract/redline.js";
import { finalizeApprovedRedlineDocx } from "../../legal/contract/finalizeRedline.js";
import type { LegalModelPort } from "../../legal/model/types.js";
import { buildDefensePackage } from "../../legal/defense/service.js";
import { buildLegalResponse } from "../../legal/response/service.js";
import { analyzeDocuments } from "../../legal/analysis/documentAnalysis.js";
import type { LegalCorpus, LegalPack } from "../../legal/corpusStore.js";
import type { CoverageEntry } from "../../legal/corpus/coverage.js";
import { validatePack } from "../../legal/corpusStore.js";
import { LegalKeyUnavailableError, type KeyProvider } from "../../legal/crypto.js";
import type { EgressConfig } from "../../legal/egress.js";
import { isApprovedLocal } from "../../legal/egress.js";
import { draftPackFromText } from "../../legal/ingest.js";
import { extractOfficeText } from "../../tools/attachments.js";
import type { MattersStore, NewMatter } from "../../legal/mattersStore.js";
import { qatarToday } from "../../legal/mattersStore.js";
import { checkStructure, coverSheetAr, internalLeaks, type DocKind } from "../../legal/memo.js";
import { searchLaw } from "../../legal/retrieval.js";
import { acceptReviewWarning, addReviewComment, approve, approveArtifact, canExportArtifact, markVerified, newReview, onContentChanged, reject, ReviewError, submitForReview } from "../../legal/review.js";
import { newDocumentVersion } from "../../legal/review/documentVersion.js";
import { reviewParagraphs } from "../../legal/review/paragraphs.js";
import { buildReviewPackage } from "../../legal/review/reviewPackage.js";
import type { Matter } from "../../legal/types.js";
import { verifyDocument } from "../../legal/verify.js";
import { LegalRunManager } from "../../legal/pipeline/manager.js";

export interface LegalRouteContext {
  corpus: LegalCorpus;
  matters: MattersStore;
  egress: EgressConfig;
  enabled: boolean;
  /** Same provider the MattersStore uses; probed for /status. */
  keys: KeyProvider;
  vault: LegalFileVault;
  model: { port: LegalModelPort };
  buildDefense(matterId: string): ReturnType<typeof buildDefensePackage>;
  buildResponse(input: { matterId: string; sourceText: string }): ReturnType<typeof buildLegalResponse>;
  analyzeDocuments(matterId: string): ReturnType<typeof analyzeDocuments>;
  importDocument(matterId: string, absPath: string): Promise<EvidenceAnalysis>;
  now?: () => Date;
}

const runManagers = new WeakMap<LegalRouteContext, LegalRunManager>();
function runsFor(ctx: LegalRouteContext): LegalRunManager {
  let manager = runManagers.get(ctx);
  if (!manager) {
    manager = new LegalRunManager(ctx.matters, ctx.corpus, { port: ctx.model.port, config: ctx.egress });
    runManagers.set(ctx, manager);
  }
  return manager;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
  res.end(text);
}

function readJson(req: http.IncomingMessage, maxBytes = 5_000_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) { reject(new HttpError(413, "body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        const v: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!v || typeof v !== "object" || Array.isArray(v)) return reject(new HttpError(400, "JSON object body required"));
        resolve(v as Record<string, unknown>);
      } catch { reject(new HttpError(400, "invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

const isDate = (s: string | null | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const s = (v: unknown): string => (typeof v === "string" ? v : "");

function matterJson(m: Matter): Matter { return m; }

export async function handleLegalRoutes(req: http.IncomingMessage, res: http.ServerResponse, p: string, ctx: LegalRouteContext): Promise<boolean> {
  if (!p.startsWith("/api/legal")) return false;
  if (req.headers.origin === "app://agent") {
    res.setHeader("access-control-allow-origin", "app://agent");
    res.setHeader("vary", "Origin");
  }
  const url = new URL(req.url ?? p, "http://127.0.0.1");
  p = p.split("?")[0]!;
  const method = req.method ?? "GET";
  if (method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS", "access-control-allow-headers": "content-type,authorization,x-loam-local-token", "access-control-max-age": "600" });
    res.end();
    return true;
  }
  const today = qatarToday(ctx.now?.() ?? new Date());
  const asOfParam = url.searchParams.get("asOf");
  const asOf = isDate(asOfParam) ? asOfParam : today;
  const seg = p.split("/").filter(Boolean).slice(2).map(decodeURIComponent); // after "api","legal"
  try {
    if (seg.length === 1 && seg[0] === "status" && method === "GET") {
      let keyAvailable = true;
      try { ctx.keys.key(); } catch (e) { if (e instanceof LegalKeyUnavailableError) keyAvailable = false; else throw e; }
      sendJson(res, 200, {
        enabled: ctx.enabled, today, corpus: ctx.corpus.stats(), keyAvailable,
        localModel: ctx.egress.localModel, localModelApproved: isApprovedLocal(ctx.egress.localModel, ctx.egress),
      });
      return true;
    }
    if (!ctx.enabled) throw new HttpError(403, "legal mode is disabled in settings");

    // ---- corpus -----------------------------------------------------------
    if (seg[0] === "coverage") {
      if (seg.length === 1 && method === "GET") {
        const matterKind = url.searchParams.get("matterKind") ?? "research";
        sendJson(res, 200, { coverage: ctx.corpus.coverage({ asOf, matterKind, now: ctx.now?.() }), snapshot: ctx.corpus.snapshot({ persist: false }) });
        return true;
      }
      if (seg.length === 2 && seg[1] === "manifest" && method === "GET") {
        sendJson(res, 200, { entries: ctx.corpus.coverageManifest() });
        return true;
      }
      if (seg.length === 2 && seg[1] === "manifest" && method === "PUT") {
        const body = await readJson(req, 1_000_000);
        if (!Array.isArray(body.entries)) throw new HttpError(400, "entries[] is required");
        ctx.corpus.setCoverageManifest(body.entries as CoverageEntry[]);
        sendJson(res, 200, { entries: ctx.corpus.coverageManifest() });
        return true;
      }
    }
    if (seg[0] === "laws" && method === "GET") {
      if (seg.length === 1) { sendJson(res, 200, { laws: ctx.corpus.listLegislations() }); return true; }
      if (seg.length === 4) {
        const leg = ctx.corpus.getLegislation(`${seg[1]}/${seg[2]}/${seg[3]}`);
        if (!leg) throw new HttpError(404, "legislation not found");
        const articles = ctx.corpus.articlesOf(leg.key).map((a) => {
          const v = ctx.corpus.versionAt(a.key, asOf);
          return { ...a, current: v ? { avid: v.avid, text: v.text, effectiveFrom: v.effectiveFrom, effectiveTo: v.effectiveTo } : null, versions: ctx.corpus.versionsOf(a.key).length };
        });
        sendJson(res, 200, { legislation: leg, asOf, articles });
        return true;
      }
    }
    if (seg.length === 1 && seg[0] === "search" && method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      if (!q.trim()) throw new HttpError(400, "q is required");
      const lawKey = url.searchParams.get("lawKey");
      const result = await searchLaw(ctx.corpus, q, {
        asOf, k: Number(url.searchParams.get("k") ?? 10) || 10,
        includeHistorical: url.searchParams.get("historical") === "true",
        matterKind: url.searchParams.get("matterKind") ?? "research",
        ...(lawKey ? { lawKey } : {}),
      });
      ctx.matters.audit.append("user", "search", null, "ui search", { hits: result.hits.length, asOf });
      sendJson(res, 200, result);
      return true;
    }
    if (seg.length === 2 && seg[0] === "articles" && method === "GET") {
      const r = ctx.corpus.resolve(seg[1]!, asOf);
      if (!r) throw new HttpError(404, "article version not found");
      sendJson(res, 200, { resolved: r, versions: ctx.corpus.versionsOf(r.article.key), amendments: ctx.corpus.amendmentsOf(r.article.key), provenance: ctx.corpus.provenanceOf(r.version.avid) });
      return true;
    }
    if (seg[0] === "import" && method === "POST") {
      const body = await readJson(req, 20_000_000);
      if (seg[1] === "draft") {
        const draft = draftPackFromText(body.legislation as LegalPack["legislation"], body.source as LegalPack["source"], s(body.rawText));
        sendJson(res, 200, { ...draft, errors: validatePack(draft.pack) });
        return true;
      }
      const pack = body.pack;
      const errors = validatePack(pack);
      if (errors.length) { sendJson(res, 422, { errors }); return true; }
      const result = ctx.corpus.importPack(pack as LegalPack);
      ctx.matters.audit.append("user", "corpus.import", null, result.legKey, { articles: result.articles, versions: result.versions, amendments: result.amendmentsApplied });
      sendJson(res, 200, result);
      return true;
    }
    if (seg.length === 1 && seg[0] === "verify" && method === "POST") {
      const body = await readJson(req);
      const text = s(body.text);
      if (!text.trim()) throw new HttpError(400, "text is required");
      const matter = s(body.matterId) ? ctx.matters.getMatter(s(body.matterId)) : undefined;
      const at = isDate(s(body.asOf)) ? s(body.asOf) : matter?.asOf ?? today;
      const report = verifyDocument(ctx.corpus, text, { asOf: at, ...(matter ? { matterKind: matter.kind } : {}) });
      const kind = s(body.kind) as DocKind;
      const structure = ["defense_memo", "opinion", "contract_report"].includes(kind)
        ? [...checkStructure(kind, text), ...(report.renderedDocument ? internalLeaks(report.renderedDocument) : [])] : [];
      ctx.matters.audit.append("user", "cite_check", matter?.id ?? null, "ui verify", { verdict: report.verdict, sha256: report.documentSha256 });
      const documentName = s(body.documentName) || "document";
      let review = matter ? ctx.matters.reviewsOf(matter.id).find((r) => r.documentName === documentName) : undefined;
      if (matter && s(body.documentName) && report.verdict !== "fail" && structure.every((issue) => issue.level !== "error")) {
        const at = (ctx.now?.() ?? new Date()).toISOString();
        let next = onContentChanged(review ?? newReview(matter.id, documentName), report.documentSha256, "user", at);
        if (next.state !== "in_review") next = markVerified(next, report, "user", at);
        next = { ...next, sourceText: text, documentVersion: newDocumentVersion({ matterId: matter.id, documentName, contentSha256: report.documentSha256, corpusSnapshotId: report.corpusSnapshotId, model: ctx.egress.localModel }, at) };
        ctx.matters.saveReview(next);
        review = next;
      }
      sendJson(res, 200, { report, structure, review, ...(matter ? { coverSheet: coverSheetAr(matter, documentName, report, review) } : {}) });
      return true;
    }

    // ---- matters ------------------------------------------------------------
    if (seg[0] === "matters") {
      if (seg.length === 1 && method === "GET") { sendJson(res, 200, { matters: ctx.matters.listMatters().map(matterJson) }); return true; }
      if (seg.length === 1 && method === "POST") {
        const body = await readJson(req);
        sendJson(res, 201, { matter: ctx.matters.createMatter(body as unknown as NewMatter, "user") });
        return true;
      }
      const matter = ctx.matters.getMatter(seg[1] ?? "");
      if (!matter) throw new HttpError(404, "matter not found");
      if (seg.length === 2 && method === "GET") { sendJson(res, 200, { matter, contracts: ctx.matters.listContracts(matter.id), reviews: ctx.matters.reviewsOf(matter.id) }); return true; }
      if (seg.length === 2 && method === "PATCH") {
        const body = await readJson(req);
        if (body.egress !== undefined && body.confirmEgress !== true) throw new HttpError(400, "changing egress requires confirmEgress: true from the confirmation dialog");
        const { confirmEgress: _c, ...patch } = body;
        sendJson(res, 200, { matter: ctx.matters.updateMatter(matter.id, patch as Partial<Matter>, "user", true) });
        return true;
      }
      if (seg.length === 2 && method === "DELETE") { sendJson(res, 200, { deleted: ctx.matters.deleteMatter(matter.id, "user") }); return true; }
      if (seg.length === 3 && seg[2] === "runs" && method === "POST") {
        const body = await readJson(req, 10_000_000);
        const kind = s(body.kind);
        if (!["defense_memo", "legal_response", "document_analysis", "contract_review"].includes(kind)) throw new HttpError(400, "unsupported run kind");
        if (kind === "legal_response" && !s(body.sourceText).trim()) throw new HttpError(400, "sourceText is required");
        if (kind === "contract_review" && !s(body.contractId).trim()) throw new HttpError(400, "contractId is required");
        const run = await runsFor(ctx).start(kind as "defense_memo" | "legal_response" | "document_analysis" | "contract_review", matter.id, {
          matterId: matter.id,
          ...(kind === "legal_response" ? { sourceText: s(body.sourceText) } : {}),
          ...(kind === "contract_review" ? { contractId: s(body.contractId), contractType: (s(body.contractType) || "any") as ContractType, clientPosition: (s(body.clientPosition) || "other") as import("../../legal/contract/types.js").ClientPosition, riskTolerance: (s(body.riskTolerance) || "balanced") as import("../../legal/contract/types.js").RiskTolerance } : {}),
        });
        sendJson(res, 201, { run });
        return true;
      }
      if (seg.length === 3 && seg[2] === "analyze-documents" && method === "POST") {
        sendJson(res, 200, await ctx.analyzeDocuments(matter.id));
        return true;
      }
      if (seg.length === 3 && seg[2] === "response" && method === "POST") {
        const body = await readJson(req, 10_000_000);
        if (!s(body.sourceText).trim()) throw new HttpError(400, "sourceText is required");
        sendJson(res, 200, await ctx.buildResponse({ matterId: matter.id, sourceText: s(body.sourceText) }));
        return true;
      }
      if (seg.length === 3 && seg[2] === "defense" && method === "POST") {
        const result = await ctx.buildDefense(matter.id);
        sendJson(res, 200, result);
        return true;
      }
      if (seg[2] === "documents") {
        if (seg.length === 3 && method === "GET") {
          sendJson(res, 200, {
            documents: ctx.matters.evidence.listDocuments(matter.id), facts: ctx.matters.evidence.listFacts(matter.id),
            timeline: ctx.matters.evidence.listTimeline(matter.id), contradictions: ctx.matters.evidence.listContradictions(matter.id),
          });
          return true;
        }
        if (seg.length === 3 && method === "POST") {
          const body = await readJson(req, 30_000_000);
          const fileName = path.basename(s(body.fileName) || "document.txt");
          const data = Buffer.from(s(body.dataBase64), "base64");
          if (data.length === 0) throw new HttpError(400, "document is empty");
          const stored = ctx.vault.put(data);
          const temp = fs.mkdtempSync(path.join(os.tmpdir(), "legal-import-"));
          try {
            const source = path.join(temp, fileName);
            fs.writeFileSync(source, data);
            const analysis = await ctx.importDocument(matter.id, source);
            sendJson(res, 201, { ...analysis, vaultId: stored.id });
          } finally {
            fs.rmSync(temp, { recursive: true, force: true });
          }
          return true;
        }
        if (seg.length === 4 && method === "GET") {
          const document = ctx.matters.evidence.getDocument(seg[3]!);
          if (!document || document.matterId !== matter.id) throw new HttpError(404, "document not found");
          sendJson(res, 200, { document });
          return true;
        }
      }
      if (seg[2] === "contracts") {
        if (seg.length === 3 && method === "GET") { sendJson(res, 200, { contracts: ctx.matters.listContracts(matter.id) }); return true; }
        if (seg.length === 3 && method === "POST") {
          const body = await readJson(req, 20_000_000);
          let text = s(body.text);
          const original = s(body.originalBase64) ? Buffer.from(s(body.originalBase64), "base64") : undefined;
          if (!text.trim() && original && s(body.fileName).toLowerCase().endsWith(".docx")) {
            const temp = fs.mkdtempSync(path.join(os.tmpdir(), "legal-contract-"));
            try {
              const source = path.join(temp, "contract.docx");
              fs.writeFileSync(source, original);
              text = extractOfficeText(source);
            } finally {
              fs.rmSync(temp, { recursive: true, force: true });
            }
          }
          const c = ctx.matters.addContract(matter.id, { fileName: s(body.fileName) || "contract.txt", mime: s(body.mime) || "text/plain", text, language: contractLanguage(text), ...(original ? { original } : {}) }, "user");
          const clauses = segmentContract(c.id, c.text);
          ctx.matters.saveClauses(c.id, clauses);
          sendJson(res, 201, { contract: { id: c.id, fileName: c.fileName, sha256: c.sha256, language: c.language }, clauses: clauses.length });
          return true;
        }
        const contract = ctx.matters.getContract(seg[3] ?? "");
        if (!contract || contract.matterId !== matter.id) throw new HttpError(404, "contract not found");
        if (seg.length === 5 && seg[4] === "clauses" && method === "GET") { sendJson(res, 200, { clauses: ctx.matters.clauses(contract.id) }); return true; }
        if (seg.length === 5 && seg[4] === "review" && method === "POST") {
          const body = await readJson(req);
          const report = await reviewContractDetailed(ctx.matters.clauses(contract.id), DEFAULT_QATAR_PLAYBOOK, {
            corpus: ctx.corpus, asOf: matter.asOf, contractType: (s(body.contractType) || "any") as ContractType, fullText: contract.text,
            clientPosition: (s(body.clientPosition) || "other") as "other",
            riskTolerance: (s(body.riskTolerance) || "balanced") as "balanced",
          }, { port: ctx.model.port, config: ctx.egress });
          ctx.matters.audit.append("user", "contract.review", matter.id, contract.id, { findings: report.findings.length });
          sendJson(res, 200, { ...report, playbook: { id: DEFAULT_QATAR_PLAYBOOK.id, version: DEFAULT_QATAR_PLAYBOOK.version } });
          return true;
        }
        if (seg.length === 5 && seg[4] === "redline" && method === "POST") {
          const body = await readJson(req, 10_000_000);
          const rawEdits = Array.isArray(body.edits) ? body.edits : [];
          const clauses = ctx.matters.clauses(contract.id);
          const ids = new Set(clauses.map((clause) => clause.id));
          const edits = rawEdits.flatMap((value) => {
            const edit = value as Record<string, unknown>;
            return typeof edit.clauseId === "string" && typeof edit.newText === "string" && ids.has(edit.clauseId) ? [{ clauseId: edit.clauseId, newText: edit.newText }] : [];
          });
          if (edits.length !== rawEdits.length) throw new HttpError(400, "every edit needs a valid clauseId and newText");
          const buffer = contract.originalBase64
            ? await buildOriginalRedlineDocx(Buffer.from(contract.originalBase64, "base64"), clauses, edits, { author: "Loam Legal", date: (ctx.now?.() ?? new Date()).toISOString(), rtl: contract.language !== "en", draft: true })
            : await buildRedlineDocx(clauses, edits, { title: contract.fileName, author: "Loam Legal", date: (ctx.now?.() ?? new Date()).toISOString(), rtl: contract.language !== "en", draft: true });
          ctx.matters.audit.append("user", "export.draft", matter.id, `redline:${contract.id}`, { edits: edits.length, bytes: buffer.length });
          sendJson(res, 200, { fileName: `${contract.fileName.replace(/\.docx$/i, "")}-redline.docx`, dataBase64: buffer.toString("base64"), draft: true });
          return true;
        }
      }
      if (seg.length === 3 && seg[2] === "reviews" && method === "GET") { sendJson(res, 200, { reviews: ctx.matters.reviewsOf(matter.id) }); return true; }
    }

    if (seg[0] === "runs") {
      if (seg.length === 1 && method === "GET") {
        const matterId = url.searchParams.get("matterId");
        if (!matterId) throw new HttpError(400, "matterId is required");
        if (!ctx.matters.getMatter(matterId)) throw new HttpError(404, "matter not found");
        sendJson(res, 200, { runs: runsFor(ctx).list(matterId) });
        return true;
      }
      const run = runsFor(ctx).get(seg[1] ?? "");
      if (!run) throw new HttpError(404, "run not found");
      if (seg.length === 2 && method === "GET") { sendJson(res, 200, { run }); return true; }
      if (seg.length === 3 && method === "POST") {
        if (seg[2] === "cancel") sendJson(res, 200, { run: await runsFor(ctx).cancel(run.id) });
        else if (seg[2] === "resume") {
          const body = await readJson(req, 5_000_000);
          sendJson(res, 200, { run: await runsFor(ctx).resume(run.id, body.answer) });
        } else throw new HttpError(404, "unknown run action");
        return true;
      }
    }

    if (seg.length === 2 && seg[0] === "artifacts" && seg[1] === "verify" && method === "POST") {
      const body = await readJson(req, 30_000_000);
      const matter = ctx.matters.getMatter(s(body.matterId));
      if (!matter) throw new HttpError(404, "matter not found");
      const data = Buffer.from(s(body.dataBase64), "base64");
      if (data.length === 0) throw new HttpError(400, "artifact is empty");
      const documentName = s(body.documentName) || "artifact.docx";
      if (!documentName.toLowerCase().endsWith(".docx")) throw new HttpError(400, "artifact verification requires a DOCX file");
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), "legal-artifact-"));
      let text: string;
      try {
        const source = path.join(temp, "artifact.docx");
        fs.writeFileSync(source, data);
        text = extractOfficeText(source);
      } catch {
        throw new HttpError(400, "invalid or unreadable DOCX artifact");
      } finally {
        fs.rmSync(temp, { recursive: true, force: true });
      }
      if (!text.trim()) throw new HttpError(400, "artifact text is empty");
      const report = verifyDocument(ctx.corpus, text, { asOf: matter.asOf, matterKind: matter.kind });
      const structure = documentName.startsWith("redline")
        ? (report.renderedDocument ? internalLeaks(report.renderedDocument) : [])
        : [...checkStructure(matter.kind === "contract_review" ? "contract_report" : matter.kind === "defense_memo" ? "defense_memo" : "opinion", text), ...(report.renderedDocument ? internalLeaks(report.renderedDocument) : [])];
      const contentSha256 = crypto.createHash("sha256").update(data).digest("hex");
      report.documentSha256 = contentSha256;
      const at = (ctx.now?.() ?? new Date()).toISOString();
      let review = ctx.matters.reviewsOf(matter.id).find((r) => r.documentName === documentName) ?? newReview(matter.id, documentName);
      review = onContentChanged(review, contentSha256, "user", at);
      if (report.verdict !== "fail" && structure.every((issue) => issue.level !== "error")) {
        if (review.state !== "in_review") review = markVerified(review, report, "user", at);
        review = { ...review, sourceText: text, documentVersion: newDocumentVersion({ matterId: matter.id, documentName, contentSha256, corpusSnapshotId: report.corpusSnapshotId, model: ctx.egress.localModel }, at) };
        ctx.matters.saveReview(review);
      } else if (review.state !== "in_review") {
        ctx.matters.saveReview(review);
      }
      sendJson(res, 200, { report, structure, review, paragraphs: reviewParagraphs(text) });
      return true;
    }

    // ---- review gate -----------------------------------------------------------
    if (seg[0] === "reviews" && seg.length === 3 && seg[2] === "review-package" && method === "GET") {
      const rec = ctx.matters.getReview(seg[1]!);
      if (!rec) throw new HttpError(404, "review not found");
      const matter = ctx.matters.getMatter(rec.matterId);
      if (!matter) throw new HttpError(404, "matter not found");
      const at = (ctx.now?.() ?? new Date()).toISOString();
      const contents = buildReviewPackage(matter, rec, ctx.matters.approvals.latest(rec.id), at);
      ctx.matters.audit.append("user", "export.draft", matter.id, rec.documentName, { package: "internal-review", state: rec.state });
      sendJson(res, 200, { fileName: `${rec.documentName.replace(/\.docx$/i, "")}.review.json`, dataBase64: Buffer.from(contents, "utf8").toString("base64"), internal: true });
      return true;
    }
    if (seg[0] === "reviews" && seg.length === 3 && seg[2] === "comments" && method === "POST") {
      const rec = ctx.matters.getReview(seg[1]!);
      if (!rec) throw new HttpError(404, "review not found");
      const body = await readJson(req);
      const anchor = (body.anchor ?? {}) as Record<string, unknown>;
      const paragraph = reviewParagraphs(rec.sourceText ?? "").find((item) => item.start === Number(anchor.start) && item.end === Number(anchor.end) && item.quote === s(anchor.quote));
      if (!paragraph) throw new ReviewError("comment anchor does not match the verified document");
      const at = (ctx.now?.() ?? new Date()).toISOString();
      const next = addReviewComment(rec, { ...paragraph, body: s(body.body) }, { name: s(body.reviewerName), licenseNo: s(body.licenseNo) }, at);
      ctx.matters.saveReview(next);
      ctx.matters.audit.append(`${s(body.reviewerName)} (${s(body.licenseNo)})`, "review.comment", rec.matterId, rec.documentName, { commentId: next.comments.at(-1)!.id, start: paragraph.start, end: paragraph.end });
      sendJson(res, 200, { review: next });
      return true;
    }
    if (seg[0] === "reviews" && seg.length === 3 && seg[2] === "accept-warning" && method === "POST") {
      const rec = ctx.matters.getReview(seg[1]!);
      if (!rec) throw new HttpError(404, "review not found");
      const body = await readJson(req);
      const at = (ctx.now?.() ?? new Date()).toISOString();
      const next = acceptReviewWarning(rec, { code: s(body.code), reason: s(body.reason) }, { name: s(body.reviewerName), licenseNo: s(body.licenseNo) }, at);
      ctx.matters.saveReview(next);
      ctx.matters.audit.append(`${s(body.reviewerName)} (${s(body.licenseNo)})`, "review.warning", rec.matterId, rec.documentName, { code: s(body.code) });
      sendJson(res, 200, { review: next });
      return true;
    }
    if (seg[0] === "reviews" && seg.length === 3 && seg[2] === "export" && method === "GET") {
      const rec = ctx.matters.getReview(seg[1]!);
      if (!rec) throw new HttpError(404, "review not found");
      const artifact = ctx.matters.approvals.latest(rec.id);
      const actualSha256 = artifact?.dataBase64 ? crypto.createHash("sha256").update(Buffer.from(artifact.dataBase64, "base64")).digest("hex") : undefined;
      if (!artifact || actualSha256 !== artifact.artifactSha256 || !canExportArtifact(rec, actualSha256 ?? "")) throw new ReviewError("final artifact is not approved or no longer matches");
      sendJson(res, 200, { fileName: artifact.documentName, dataBase64: artifact.dataBase64, artifact });
      return true;
    }
    if (seg[0] === "reviews" && seg.length === 3 && seg[2] === "approve-artifact" && method === "POST") {
      const rec = ctx.matters.getReview(seg[1]!);
      if (!rec) throw new HttpError(404, "review not found");
      const matter = ctx.matters.getMatter(rec.matterId);
      if (!matter) throw new HttpError(404, "matter not found");
      const body = await readJson(req, 30_000_000);
      const data = Buffer.from(s(body.dataBase64), "base64");
      if (data.length === 0) throw new HttpError(400, "artifact is empty");
      const at = (ctx.now?.() ?? new Date()).toISOString();
      const contentSha256 = crypto.createHash("sha256").update(data).digest("hex");
      if (rec.verifiedSha256 !== contentSha256) throw new ReviewError("artifact content changed since verification");
      const finalData = rec.documentName.startsWith("redline") ? await finalizeApprovedRedlineDocx(data) : data;
      const artifact = {
        id: `aa-${crypto.randomBytes(6).toString("hex")}`, reviewId: rec.id, matterId: matter.id, documentName: rec.documentName,
        kind: "docx" as const, contentSha256, artifactSha256: crypto.createHash("sha256").update(finalData).digest("hex"),
        corpusSnapshotId: ctx.corpus.snapshot({ persist: true }).id, model: ctx.egress.localModel, dataBase64: finalData.toString("base64"), createdAt: at,
      };
      if (rec.verifiedCorpusSnapshotId === artifact.corpusSnapshotId) {
        const coverage = ctx.corpus.coverage({ asOf: matter.asOf, matterKind: matter.kind, now: ctx.now?.() });
        if (coverage.status !== "complete") throw new ReviewError(`cannot approve with corpus coverage ${coverage.status}; resolve every required source first`);
      }
      const next = approveArtifact(rec, artifact, { name: s(body.reviewerName), licenseNo: s(body.licenseNo) }, at);
      ctx.matters.saveReview(next);
      ctx.matters.approvals.save(artifact);
      ctx.matters.audit.append(`${next.reviewer!.name} (${next.reviewer!.licenseNo})`, "review.transition", matter.id, rec.documentName, { from: rec.state, to: next.state, artifactSha256: artifact.artifactSha256 });
      sendJson(res, 200, { review: next, artifact });
      return true;
    }
    if (seg[0] === "reviews" && seg.length === 3 && method === "POST") {
      const rec = ctx.matters.getReview(seg[1]!);
      if (!rec) throw new HttpError(404, "review not found");
      const matter = ctx.matters.getMatter(rec.matterId);
      if (!matter) throw new HttpError(404, "matter not found");
      const body = await readJson(req);
      const at = (ctx.now?.() ?? new Date()).toISOString();
      let next = rec;
      if (seg[2] === "submit") next = submitForReview(rec, "user", at);
      else if (seg[2] === "approve") {
        const text = s(body.text);
        const report = verifyDocument(ctx.corpus, text, { asOf: matter.asOf, matterKind: matter.kind });
        const kind: DocKind = matter.kind === "contract_review" ? "contract_report" : matter.kind === "defense_memo" ? "defense_memo" : "opinion";
        const structure = [...checkStructure(kind, text), ...(report.renderedDocument ? internalLeaks(report.renderedDocument) : [])];
        if (structure.some((issue) => issue.level === "error")) throw new ReviewError(`document structure failed: ${structure.filter((issue) => issue.level === "error").map((issue) => issue.code).join(",")}`);
        next = approve(rec, report, { name: s(body.reviewerName), licenseNo: s(body.licenseNo) }, at);
      } else if (seg[2] === "reject") next = reject(rec, "user", s(body.note), at);
      else throw new HttpError(404, "unknown review action");
      ctx.matters.saveReview(next);
      ctx.matters.audit.append(next.reviewer ? `${next.reviewer.name} (${next.reviewer.licenseNo})` : "user", "review.transition", matter.id, rec.documentName, { from: rec.state, to: next.state });
      sendJson(res, 200, { review: next });
      return true;
    }

    // ---- audit -------------------------------------------------------------------
    if (seg[0] === "audit" && method === "GET") {
      if (seg[1] === "verify") { const broken = ctx.matters.audit.verifyChain(); sendJson(res, 200, { intact: broken === null, firstBrokenSeq: broken }); return true; }
      const matterId = url.searchParams.get("matterId");
      sendJson(res, 200, { events: ctx.matters.audit.list({ ...(matterId ? { matterId } : {}), limit: Number(url.searchParams.get("limit") ?? 200) || 200 }) });
      return true;
    }
    sendJson(res, 404, { error: "not found" });
    return true;
  } catch (err) {
    if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
    else if (err instanceof LegalKeyUnavailableError) sendJson(res, 423, { error: "matters store is locked: the encryption key is not available" });
    else if (err instanceof ReviewError) sendJson(res, 409, { error: err.message });
    else {
      const message = err instanceof Error ? err.message : String(err);
      const user = /required|invalid|not found|already|must|changed|differs/i.test(message);
      sendJson(res, user ? 400 : 500, { error: user ? message : "internal error" });
    }
    return true;
  }
}
