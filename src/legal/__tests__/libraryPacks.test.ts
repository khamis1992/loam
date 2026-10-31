import assert from "node:assert/strict";
import { test } from "node:test";
import { LegalCorpus, validatePack } from "../corpusStore.js";
import { libraryMarkdownToPack } from "../libraryPacks.js";

const MD = `# قانون رقم (14) لسنة 2004 بإصدار قانون العمل

- التصنيف: قانون العمل
- الرقم/السنة: 14 / 2004
- النوع: قانون — الحالة على الميزان: قيد التطبيق
- تاريخ النشر: 2004-05-19 — الجريدة الرسمية: الجريدة الرسمية - العدد 9 لسنة 2004
- رابط الميزان: https://almeezan.qa/legislations/x

## النص الكامل

### مواد الإصدار

**مادة 1 (إصدار) ملغاة**

نص ملغى.

**مادة 2 (إصدار) معدلة**

نص الإصدار الثاني.

### الفصل الأول

**مادة 1**

نص المادة الأولى.

**مادة 18  معدلة ملغاة**

ملغاة.

**مادة 18 (مكرر)**

نص مكرر.

**مادة 18 (مكرراً)**

نسخة مكررة.

**مادة 77 (77 مكرراً)**

نص 77 مكرراً.
`;

test("core-law markdown -> research_snapshot pack, verifiedBy empty, repealed skipped, duplicates dropped", () => {
  const r = libraryMarkdownToPack("12_labour.md", MD, "2026-10-31");
  assert.ok(r.pack);
  assert.equal(r.pack.source.provenance, "research_snapshot");
  assert.equal(r.pack.source.verifiedBy, undefined);
  assert.equal(r.pack.legislation.number, 14);
  assert.equal(r.pack.legislation.publishDate, "2004-05-19");
  assert.deepEqual(r.pack.articles.map((a) => `${a.part}:${a.label}`), ["issuance:2", "body:1", "body:18 مكرر", "body:77 مكرراً"]);
  assert.deepEqual(r.amended, ["إصدار 2"]);
  assert.ok(r.skipped.includes("إصدار 1") && r.skipped.includes("18"));
  assert.ok(r.warnings.some((w) => w.includes("duplicate")));
  assert.deepEqual(validatePack(r.pack), []);
});

test("pack imports into the corpus and is flagged research_snapshot", () => {
  const { pack } = libraryMarkdownToPack("12_labour.md", MD, "2026-10-31");
  const corpus = new LegalCorpus(":memory:");
  const res = corpus.importPack(pack!);
  assert.equal(res.articles, 4);
  assert.ok(res.warnings.some((w) => w.includes("research_snapshot")));
  corpus.close();
});

test("pointer files without number/year are skipped", () => {
  const r = libraryMarkdownToPack("03_evidence_law.md", "# قانون الإثبات\n\n- آخر تحقق: 2026-10-31\n", "2026-10-31");
  assert.equal(r.pack, null);
});
