/**
 * Golden anti-hallucination set: 40 cases over the FICTIONAL fixture corpus.
 * Each case pins the verdict, every non-OK check status (in order) and every
 * warning code. 22 cases must fail: fabricated ids, articles, laws and quotes,
 * superseded/repealed/not-yet-in-force text, unverified sources.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { verifyDocument } from "../verify.js";
import { FIXTURE_DIR, fillAvids, loadFixtureCorpus } from "./helpers.js";

interface GoldenCase {
  id: string; title: string; asOf: string; text: string; ledger?: string[];
  expect: { verdict: "pass" | "pass_with_warnings" | "fail"; statuses: string[]; warnings: string[]; unverifiedMarkers: number };
}

const cases = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "golden", "cases.json"), "utf8")) as GoldenCase[];
const corpus = loadFixtureCorpus();

test("golden set has at least 40 cases and at least 20 must-fail cases", () => {
  assert.ok(cases.length >= 40);
  assert.ok(cases.filter((c) => c.expect.verdict === "fail").length >= 20);
});

for (const c of cases) {
  test(`${c.id} ${c.title}`, () => {
    const r = verifyDocument(corpus, fillAvids(c.text), { asOf: c.asOf, ...(c.ledger ? { ledger: new Set(c.ledger) } : {}) });
    assert.equal(r.verdict, c.expect.verdict);
    assert.deepEqual(r.checks.map((x) => x.status).filter((s) => s !== "OK"), c.expect.statuses);
    assert.deepEqual(r.warnings.map((w) => w.code), c.expect.warnings);
    assert.equal(r.counts.unverifiedMarkers, c.expect.unverifiedMarkers);
    if (r.verdict === "fail") assert.equal(r.renderedDocument, undefined, "a failing draft is never rendered");
    else {
      assert.ok(r.renderedDocument);
      assert.ok(!/⟦|\[\[(?:cite|ref):|QL-[0-9a-f]{10}/u.test(r.renderedDocument), "rendered text has no internal tokens");
    }
  });
}

test("rendered citation is formal Arabic and names the amending law for amended text", () => {
  const text = fillAvids("«يجوز للمتعاقدين أن يحددا مقدماً قيمة التعويض بالنص عليها في العقد، ويجوز للقاضي أن يخفض التعويض الاتفاقي إذا أثبت المدين أن التقدير كان مبالغاً فيه إلى درجة كبيرة.» ⟦cite:{{law/2090/1:body:3@2091-07-01}}⟧");
  const r = verifyDocument(corpus, text, { asOf: "2092-01-01" });
  assert.equal(r.verdict, "pass");
  assert.match(r.renderedDocument ?? "", /المادة \(3\) من القانون المدني الاختباري/u);
  assert.match(r.renderedDocument ?? "", /المستبدلة بموجب/u);
});

test("a mismatch hint names the version the quote actually matches", () => {
  const text = fillAvids("«يجوز للمتعاقدين أن يحددا مقدماً قيمة التعويض بالنص عليها في العقد، ويجوز للقاضي أن يخفض التعويض الاتفاقي إذا أثبت المدين أن التقدير كان مبالغاً فيه إلى درجة كبيرة.» ⟦cite:{{law/2090/1:body:3@2090-04-01}}⟧");
  const r = verifyDocument(corpus, text, { asOf: "2092-01-01" });
  assert.match(r.checks[0]?.messageAr ?? "", /يطابق نسخة أخرى/u);
});
