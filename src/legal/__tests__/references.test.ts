import assert from "node:assert/strict";
import { test } from "node:test";
import { findArticleMentions, findLawMentions, sentenceSpans } from "../references.js";

test("single, abbreviated, ordinal and Hindi-digit article mentions", () => {
  const labels = findArticleMentions("نصت المادة (171) وم ٣ والمادة الخمسون والمادة ١٢ مكرراً").map((m) => m.labels);
  assert.deepEqual(labels, [["171"], ["3"], ["50"], ["12bis"]]);
});

test("lists and ranges expand; ranges are capped", () => {
  assert.deepEqual(findArticleMentions("المواد 1 و2 و5").map((m) => m.labels)[0], ["1", "2", "5"]);
  assert.deepEqual(findArticleMentions("المواد من 3 إلى 6")[0]?.labels, ["3", "4", "5", "6"]);
  const big = findArticleMentions("المواد من 1 إلى 500")[0]?.labels ?? [];
  assert.ok(big.length <= 60);
});

test("English article mentions", () => {
  assert.deepEqual(findArticleMentions("Article 2 and Articles 4 and 5").map((m) => m.labels), [["2"], ["4", "5"]]);
});

test("mention spans map back to original text", () => {
  const text = "وفقاً للمادة (٣) من القانون";
  const m = findArticleMentions(text)[0];
  assert.ok(m);
  assert.equal(text.slice(m.start, m.end), m.raw);
  assert.ok(!m.raw.endsWith(" "));
});

test("law mentions with prefixes, types and Hindi digits", () => {
  const laws = findLawMentions("وفقاً للقانون رقم (99) لسنة 2093 والمرسوم بقانون رقم ٧ لسنة ٢٠٨٨ وبالقرار الأميري رقم 5 لسنة 2001 and Law No. 14 of 2004");
  assert.deepEqual(laws.map((l) => [l.type, l.number, l.year]), [["law", 99, 2093], ["decree-law", 7, 2088], ["emiri-decision", 5, 2001], ["law", 14, 2004]]);
});

test("sentence splitting skips decimals and the م. / Art. abbreviations only", () => {
  assert.equal(sentenceSpans("نسبة 1.5 بالمائة. ثم").length, 2);
  assert.equal(sentenceSpans("انظر م. 3 من القانون. ثم").length, 2);
  assert.equal(sentenceSpans("See Art. 3. Then").length, 2);
  assert.equal(sentenceSpans("أقرّ الخصم. ثم").length, 2, "a word ending in م is not the abbreviation");
});
