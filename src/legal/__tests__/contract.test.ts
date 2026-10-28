import assert from "node:assert/strict";
import { test } from "node:test";
import JSZip from "jszip";
import { classifyClause, contractLanguage, isClauseHeading, segmentContract } from "../contract/clauses.js";
import { DEFAULT_QATAR_PLAYBOOK, reviewContract, validatePlaybook } from "../contract/playbook.js";
import { buildRedlineDocx, wordDiff } from "../contract/redline.js";
import { loadFixtureCorpus } from "./helpers.js";

export const SAMPLE_CONTRACT = [
  "عقد تقديم خدمات",
  "إنه في يوم 2092/01/10 تم الاتفاق بين شركة الاختبار للخدمات وشركة المثال للتجارة.",
  "البند الأول: موضوع العقد",
  "يلتزم الطرف الأول بتقديم خدمات الصيانة للطرف الثاني.",
  "البند الثاني: المقابل المالي",
  "يدفع الطرف الثاني مبلغ مائة ألف ريال قطري خلال ثلاثين يوماً من تاريخ الفاتورة.",
  "البند الثالث: الشرط الجزائي",
  "في حال التأخير يلتزم الطرف الأول بدفع غرامة تأخير بنسبة 30% من قيمة العقد.",
  "البند الرابع: المسؤولية",
  "لا يكون الطرف الأول مسؤولاً عن أي أضرار مهما كان سببها.",
  "البند الخامس: القانون الواجب التطبيق",
  "يخضع هذا العقد لقوانين إنجلترا وويلز.",
  "البند السادس: البيانات",
  "يزوّد الطرف الثاني الطرف الأول بالبيانات الشخصية لموظفيه ورقم الهوية لكل منهم.",
].join("\n");

test("clause headings: Arabic ordinals, numbered and English; sub-numbers are not headings", () => {
  assert.ok(isClauseHeading("البند الأول: موضوع العقد"));
  assert.ok(isClauseHeading("المادة (3) - الشرط الجزائي"));
  assert.ok(isClauseHeading("Clause 4 – Liability"));
  assert.ok(!isClauseHeading("1.1 يلتزم الطرف الأول"));
});

test("segmentation keeps the preamble and classifies clauses", () => {
  const clauses = segmentContract("ct-test", SAMPLE_CONTRACT);
  assert.equal(clauses[0]?.heading, "التمهيد");
  assert.equal(clauses.length, 7);
  assert.ok(clauses.find((c) => c.heading.includes("الشرط الجزائي"))?.categories.includes("penalty"));
  assert.ok(clauses.find((c) => c.heading.includes("القانون الواجب"))?.categories.includes("governing_law"));
  assert.deepEqual(classifyClause("Governing law", "This Agreement is governed by the laws of the State of Qatar."), ["governing_law"]);
  assert.equal(contractLanguage(SAMPLE_CONTRACT), "ar");
});

test("playbook flags the risky clauses with no invented authorities", async () => {
  const corpus = loadFixtureCorpus();
  const clauses = segmentContract("ct-test", SAMPLE_CONTRACT);
  const findings = await reviewContract(clauses, DEFAULT_QATAR_PLAYBOOK, { corpus, asOf: "2092-01-01", contractType: "services", fullText: SAMPLE_CONTRACT });
  const ids = new Set(findings.map((f) => f.ruleId));
  for (const id of ["QA-GL-1", "QA-PEN-1", "QA-LIAB-2", "QA-DR-0", "QA-LIAB-1", "QA-FM-0", "QA-LANG-0", "QA-DP-0"]) assert.ok(ids.has(id), `expected ${id}`);
  assert.ok(!ids.has("QA-GL-0"), "a governing-law clause exists");
  assert.ok(!clauses.some((c) => c.categories.includes("data_protection")), "mentioning personal data is not a protection clause");
  const liab2 = findings.find((f) => f.ruleId === "QA-LIAB-2");
  const art50 = corpus.versionAt("law/2090/1:body:50", "2092-01-01")?.avid;
  assert.ok(art50 && liab2?.suggestedAuthorities.includes(art50), "exemption rule suggests the no-exemption-for-fraud article");
  assert.equal(findings[0]?.severity, "high", "sorted by severity");
  const known = new Set(corpus.listLegislations().flatMap((l) => corpus.articlesOf(l.key).flatMap((a) => corpus.versionsOf(a.key).map((v) => v.avid))));
  for (const f of findings) {
    for (const a of [...f.authorities, ...f.suggestedAuthorities]) assert.ok(known.has(a), `authority ${a} must exist in the corpus`);
  }
  const pen = findings.find((f) => f.ruleId === "QA-PEN-1");
  assert.match(pen?.explanationAr ?? "", /30/);
  assert.ok((pen?.suggestedAuthorities.length ?? 0) > 0, "penalty rule finds the fixture's penalty-clause article");
});

test("personal data without a data-protection clause is flagged", async () => {
  const text = "عقد توريد\nيقدم المورد أسماء العاملين وأرقام الهوية والبيانات الشخصية لهم.\nالبند الأول: الموضوع\nتوريد مواد.";
  const findings = await reviewContract(segmentContract("ct-2", text), DEFAULT_QATAR_PLAYBOOK, { corpus: loadFixtureCorpus(), asOf: "2092-01-01", contractType: "sale", fullText: text });
  assert.ok(findings.some((f) => f.ruleId === "QA-DP-0"));
  assert.ok(findings.some((f) => f.ruleId === "QA-GL-0"));
});

test("validatePlaybook rejects bad regexes and duplicate ids", () => {
  assert.deepEqual(validatePlaybook(DEFAULT_QATAR_PLAYBOOK), []);
  const bad = structuredClone(DEFAULT_QATAR_PLAYBOOK);
  const r0 = bad.rules[0];
  assert.ok(r0);
  bad.rules.push({ ...r0, check: { type: "forbid_pattern", category: "any", pattern: "([" } });
  const errs = validatePlaybook(bad);
  assert.ok(errs.some((e) => e.includes("duplicate")));
  assert.ok(errs.some((e) => e.includes("regular expression")));
});

test("wordDiff is minimal and lossless", () => {
  const a = "يدفع الطرف الثاني غرامة بنسبة 30% من قيمة العقد.";
  const b = "يدفع الطرف الثاني غرامة بنسبة 10% من قيمة العقد بحد أقصى.";
  const ops = wordDiff(a, b);
  assert.equal(ops.filter((o) => o.op !== "ins").map((o) => o.text).join(""), a);
  assert.equal(ops.filter((o) => o.op !== "del").map((o) => o.text).join(""), b);
  assert.ok(ops.some((o) => o.op === "del" && o.text.includes("30%")));
});

test("redline DOCX contains real tracked changes, RTL paragraphs and the draft watermark", async () => {
  const clauses = segmentContract("ct-test", SAMPLE_CONTRACT);
  const pen = clauses.find((c) => c.categories.includes("penalty"));
  assert.ok(pen);
  const buf = await buildRedlineDocx(clauses, [{ clauseId: pen.id, newText: "في حال التأخير يلتزم الطرف الأول بدفع غرامة تأخير بنسبة 10% من قيمة العقد بحد أقصى." }], {
    title: "عقد تقديم خدمات", author: "Loam", date: "2092-01-10T09:00:00.000Z", rtl: true, draft: true,
  });
  const zip = await JSZip.loadAsync(buf);
  const doc = await zip.file("word/document.xml")?.async("string");
  assert.ok(doc);
  assert.match(doc, /<w:ins /);
  assert.match(doc, /<w:del /);
  assert.match(doc, /<w:delText[^>]*>[^<]*30%/);
  assert.match(doc, /<w:bidi\/>/);
  assert.match(doc, /<w:rtl\/>/);
  const headers = await Promise.all(Object.keys(zip.files).filter((f) => /^word\/header\d*\.xml$/.test(f)).map((f) => zip.file(f)?.async("string")));
  assert.ok(headers.some((h) => (h ?? "").includes("مسودة للمراجعة")));
  const final = await buildRedlineDocx(clauses, [], { title: "x", author: "Loam", date: "2092-01-10T09:00:00.000Z", rtl: true, draft: false });
  const fz = await JSZip.loadAsync(final);
  const fh = await Promise.all(Object.keys(fz.files).filter((f) => /^word\/header\d*\.xml$/.test(f)).map((f) => fz.file(f)?.async("string")));
  assert.ok(!fh.some((h) => (h ?? "").includes("مسودة للمراجعة")));
});
