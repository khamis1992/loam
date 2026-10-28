import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import JSZip from "jszip";
import { SAMPLE_CONTRACT } from "../../legal/__tests__/contract.test.js";
import { fillAvids, loadFixtureCorpus } from "../../legal/__tests__/helpers.js";
import { StaticKeyProvider } from "../../legal/crypto.js";
import { MattersStore } from "../../legal/mattersStore.js";
import { createLegalTools, insideWorkspace, LEGAL_TOOL_NAMES, type LegalToolDeps } from "../legalTools.js";
import type { Tool, ToolContext } from "../registry.js";

function setup(runModel = "qwen3.6:35b-a3b") {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "legal-tools-"));
  const deps: LegalToolDeps = {
    corpus: loadFixtureCorpus(),
    matters: new MattersStore(":memory:", new StaticKeyProvider(crypto.randomBytes(32)), () => new Date("2092-01-10T08:00:00Z")),
    egress: { localModel: "qwen3.6:35b-a3b", approvedLocalModels: ["qwen3.6:35b-a3b"], ollamaUrl: "http://127.0.0.1:11434" },
    runModelFor: () => runModel,
    now: () => new Date("2092-01-10T08:00:00Z"),
  };
  const tools = new Map<string, Tool>(createLegalTools(deps).map((t) => [t.name, t]));
  // Same construction as Loam's own tool tests (e.g. contextRecallTool.test.ts:8).
  const ctx = { cfg: {}, emit: () => {}, workspace, taskId: "task-1" } as unknown as ToolContext;
  const tool = (name: string): Tool => { const t = tools.get(name); assert.ok(t, name); return t; };
  const matter = deps.matters.createMatter({ title: "مسألة اختبار", kind: "contract_review", asOf: "2092-01-01", parties: [{ role: "counterparty", name: "شركة المثال للتجارة", identifiers: [] }] }, "user");
  return { deps, ctx, tool, matter, workspace, cleanup: () => fs.rmSync(workspace, { recursive: true, force: true }) };
}

test("all eight tools are created with JSON-schema parameters", () => {
  const { tool, cleanup } = setup();
  for (const n of LEGAL_TOOL_NAMES) assert.equal(tool(n).parameters.type, "object");
  cleanup();
});

test("legal_search returns verbatim text with tokens and records the ledger", async () => {
  const { tool, ctx, deps, matter, cleanup } = setup();
  const r = await tool("legal_search").run({ query: "المادة 3 من القانون المدني الاختباري", matterId: matter.id }, ctx);
  assert.ok(r.ok);
  const avid = deps.corpus.versionAt("law/2090/1:body:3", "2092-01-01")?.avid ?? "";
  assert.ok(r.content.includes(`⟦cite:${avid}⟧`));
  assert.ok(r.content.includes("ويجوز للقاضي أن يخفض التعويض الاتفاقي"));
  assert.ok(deps.matters.ledger("task-1").has(avid));
  const none = await tool("legal_search").run({ query: "براءات الاختراع والعلامات التجارية" }, ctx);
  assert.match(none.content, /^NO_AUTHORITY/);
  cleanup();
});

test("legal_article: full history, amendment chain, NOT_FOUND for fabricated articles", async () => {
  const { tool, ctx, cleanup } = setup();
  const r = await tool("legal_article").run({ lawKey: "القانون المدني الاختباري", label: "٣", asOf: "2092-01-01" }, ctx);
  assert.ok(r.ok);
  assert.match(r.content, /Versions:/);
  assert.match(r.content, /replace by law\/2091\/2/);
  const f = await tool("legal_article").run({ lawKey: "law/2090/1", label: "77" }, ctx);
  assert.equal(f.ok, false);
  assert.match(f.content, /NOT_FOUND/);
  const old = await tool("legal_article").run({ lawKey: "law/2090/1", label: "5", asOf: "2092-01-01" }, ctx);
  assert.match(old.content, /NOT_IN_FORCE/);
  cleanup();
});

test("legal_cite_check refuses fabricated citations and advances the review on pass", async () => {
  const { tool, ctx, deps, matter, workspace, cleanup } = setup();
  await tool("legal_search").run({ query: "المادة 4 من القانون المدني الاختباري" }, ctx);
  const good = fillAvids("«يجب تنفيذ العقد طبقاً لما اشتمل عليه وبطريقة تتفق مع ما يوجبه حسن النية.» ⟦cite:{{law/2090/1:body:4@2090-04-01}}⟧");
  fs.writeFileSync(path.join(workspace, "draft.md"), good);
  const ok = await tool("legal_cite_check").run({ path: "draft.md", matterId: matter.id }, ctx);
  assert.equal(ok.ok, true);
  assert.equal(deps.matters.reviewsOf(matter.id)[0]?.state, "verified");
  const bad = await tool("legal_cite_check").run({ text: "وتنص المادة (99) من القانون المدني الاختباري على ذلك." }, ctx);
  assert.equal(bad.ok, false);
  assert.match(bad.content, /UNCITED_ARTICLE_REFERENCE/);
  assert.match(bad.content, /REFUSAL/);
  const outside = await tool("legal_cite_check").run({ path: "../../etc/passwd" }, ctx);
  assert.equal(outside.ok, false);
  cleanup();
});

test("legal_memo_check combines structure and citations", async () => {
  const { tool, ctx, cleanup } = setup();
  const r = await tool("legal_memo_check").run({ kind: "defense_memo", text: "## الوقائع\nنص." }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.content, /MISSING_CASE/);
  assert.match(r.content, /MISSING_REQUESTS/);
  cleanup();
});

test("contract tools: import, egress-gated clause text, review, redline DOCX", async () => {
  const { tool, ctx, deps, matter, workspace, cleanup } = setup();
  fs.writeFileSync(path.join(workspace, "contract.txt"), SAMPLE_CONTRACT);
  const imp = await tool("contract_import").run({ matterId: matter.id, path: "contract.txt" }, ctx);
  assert.ok(imp.ok, imp.content);
  const contractId = /contractId=(ct-[0-9a-f]+)/.exec(imp.content)?.[1] ?? "";
  const clauses = await tool("contract_clauses").run({ matterId: matter.id, contractId }, ctx);
  assert.match(clauses.content, /غرامة تأخير/);
  const review = await tool("contract_review").run({ matterId: matter.id, contractId, contractType: "services" }, ctx);
  assert.match(review.content, /QA-LIAB-2/);
  const pen = deps.matters.clauses(contractId).find((c) => c.categories.includes("penalty"));
  assert.ok(pen);
  const red = await tool("contract_redline").run({ matterId: matter.id, contractId, outPath: "out/redline.docx", edits: [{ clauseId: pen.id, newText: "في حال التأخير يلتزم الطرف الأول بدفع غرامة بنسبة 10% بحد أقصى." }] }, ctx);
  assert.ok(red.ok, red.content);
  assert.match(red.content, /DRAFT/);
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(workspace, "out/redline.docx")));
  assert.match((await zip.file("word/document.xml")?.async("string")) ?? "", /<w:ins /);
  const escape = await tool("contract_redline").run({ matterId: matter.id, contractId, outPath: "../x.docx", edits: [] }, ctx);
  assert.equal(escape.ok, false);
  const badEdit = await tool("contract_redline").run({ matterId: matter.id, contractId, outPath: "y.docx", edits: [{ clauseId: "cl-nope", newText: "x" }] }, ctx);
  assert.equal(badEdit.ok, false);
  const actions = deps.matters.audit.list({ matterId: matter.id }).map((e) => e.action);
  for (const a of ["contract.import", "egress.decision", "contract.review", "export.draft"]) assert.ok(actions.includes(a as never), a);
  assert.ok(!JSON.stringify(deps.matters.audit.list()).includes("غرامة"), "audit holds no contract text");
  cleanup();
});

test("a cloud run model never receives client text unless the matter opted in", async () => {
  const s = setup("glm-5.3-flash:cloud");
  fs.writeFileSync(path.join(s.workspace, "c.txt"), SAMPLE_CONTRACT);
  const imp = await s.tool("contract_import").run({ matterId: s.matter.id, path: "c.txt" }, s.ctx);
  const contractId = /contractId=(ct-[0-9a-f]+)/.exec(imp.content)?.[1] ?? "";
  const withheld = await s.tool("contract_clauses").run({ matterId: s.matter.id, contractId }, s.ctx);
  assert.match(withheld.content, /TEXT WITHHELD/);
  assert.ok(!withheld.content.includes("غرامة تأخير"));
  s.deps.matters.updateMatter(s.matter.id, { egress: "cloud_redacted" }, "user", true);
  const redacted = await s.tool("contract_clauses").run({ matterId: s.matter.id, contractId }, s.ctx);
  assert.match(redacted.content, /redacted for cloud model/);
  assert.ok(!redacted.content.includes("شركة المثال للتجارة"));
  assert.ok(redacted.content.includes("[طرف-1]"));
  s.cleanup();
});

test("insideWorkspace blocks traversal and absolute paths outside the task", () => {
  const ctx = { cfg: {}, emit: () => {}, workspace: path.join(os.tmpdir(), "ws") } as unknown as ToolContext;
  assert.ok(insideWorkspace(ctx, "a/b.md"));
  assert.equal(insideWorkspace(ctx, "../b.md"), null);
  assert.equal(insideWorkspace(ctx, "/etc/passwd"), null);
  assert.equal(insideWorkspace(ctx, ""), null);
});
