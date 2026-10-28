import assert from "node:assert/strict";
import { test } from "node:test";
import { LegalCorpus, validatePack } from "../corpusStore.js";
import { draftPackFromText, splitArticles } from "../ingest.js";

const RAW = `قانون رقم (3) لسنة 2093 بإصدار قانون التجارة الاختباري
نحن ..., أمير دولة قطر الاختباري,
المادة (1)
يُعمل بأحكام قانون التجارة الاختباري المرافق لهذا القانون.
المادة (2)
يُعمل بهذا القانون من تاريخ نشره في الجريدة الرسمية.
- 1 -
الكتاب الأول
أحكام عامة
المادة 1
تسري أحكام هذا القانون على التجار.
المادة ٢ :
يُعد تاجراً كل من يزاول الأعمال التجارية باسمه ولحسابه.
المادة 2 مكرراً
تُعد الأعمال التجارية بحسب الأصل.
المادة الثالثة
يلتزم التاجر بمسك الدفاتر التجارية.`;

test("splitArticles detects the issuance/body restart, Hindi digits, bis and ordinal labels", () => {
  const { articles, warnings } = splitArticles(RAW);
  assert.deepEqual(articles.map((a) => `${a.part}:${a.label}`), ["issuance:1", "issuance:2", "body:1", "body:٢", "body:2 مكرراً", "body:الثالثة"]);
  assert.equal(articles[2]?.heading, "الكتاب الأول — أحكام عامة");
  assert.ok(!articles.some((a) => a.text.includes("- 1 -")), "page numbers dropped");
  assert.ok(warnings.some((w) => w.includes("preamble")));
});

test("a law without an issuing part is all body; duplicates are reported", () => {
  const { articles, warnings } = splitArticles("المادة 1\nأ\nالمادة 2\nب\nالمادة 2\nج");
  assert.ok(articles.every((a) => a.part === "body"));
  assert.ok(warnings.some((w) => w.includes("duplicate")));
});

test("draft packs never claim verification; import needs a person to sign off", () => {
  const draft = draftPackFromText(
    { type: "law", year: 2093, number: 3, titleAr: "قانون رقم (3) لسنة 2093 بإصدار قانون التجارة الاختباري", publishDate: "2093-02-01" },
    { provenance: "official_gazette", retrievedAt: "2093-02-02", url: "https://example.invalid/gazette/2093/3" },
    RAW,
  );
  assert.equal(draft.pack.source.verifiedBy, undefined);
  assert.ok(validatePack(draft.pack).some((e) => e.includes("verifiedBy")));
  assert.ok(draft.warnings.some((w) => w.includes("effectiveDate")));
  const signed = { ...draft.pack, source: { ...draft.pack.source, verifiedBy: "مراجع الاختبار", verifiedAt: "2093-02-03" } };
  assert.deepEqual(validatePack(signed), []);
  const c = new LegalCorpus(":memory:");
  const res = c.importPack(signed);
  assert.equal(res.articles, 6);
  assert.ok(c.getArticle("law/2093/3:body:2bis"));
  assert.ok(c.getArticle("law/2093/3:issuance:2"));
});
