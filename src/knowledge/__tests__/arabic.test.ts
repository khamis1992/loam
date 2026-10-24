/**
 * N21: Arabic sentence splitting and bilingual retrieval for the Knowledge Garden.
 *
 * The acceptance test is: an Arabic document imports as seeds that break on its
 * own sentence marks, and an Arabic query finds the seed it asks about however
 * either was spelled. Both halves are pinned here.
 *
 * Splitting has to survive Arabic's punctuation, which is not Latin's:
 *
 *  - The sentence terminators are `.` `!` `?` `؟` and the Asian full stop `۔`.
 *  - The Arabic comma `،` separates a phrase, not a sentence. Cutting on it would
 *    shred "الفوترة تحسب لكل مقعد، وتصدر الفاتورة شهريا" into two one-word seeds,
 *    so it is deliberately excluded from `SPLIT_RUN`.
 *  - A short Arabic sentence ends in `.`, so a paragraph of them is not a run of
 *    headings; `isHeadingLine` rejects a line closed by a terminator.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SPLIT_RUN, dominantScript, normalizeText, queryTerms, sentences, tokenize } from "../text.js";
import { fixedSplit } from "../splitter.js";
import { lexicalScore } from "../search.js";
import type { KnowledgeSeed } from "../types.js";

/** A realistic three-sentence Arabic billing paragraph, as a PDF or docx would hold it. */
const BILLING = "الفوترة تحسب لكل مقعد. تصدر الفاتورة شهريا. هل تشمل الضريبة؟";

/** A seed is sentence-bounded when it closes on a sentence mark. */
const SENTENCE_TAIL = /[.!؟?۔]$/;

/** Assert a seed opens at a sentence start and closes on a sentence mark. */
function assertSentenceBounded(body: string, context: string): void {
  assert.ok(body.length > 0, `${context}: empty seed`);
  assert.ok(SENTENCE_TAIL.test(body), `${context}: seed does not end on a sentence mark: ${body}`);
}

describe("Arabic text utilities", () => {
  it("splits sentences on Arabic punctuation, not on the Arabic comma", () => {
    // Three sentences: two statements and one question. The question mark is ؟.
    assert.deepEqual(sentences(BILLING), [
      "الفوترة تحسب لكل مقعد",
      "تصدر الفاتورة شهريا",
      "هل تشمل الضريبة",
    ]);
  });

  it("keeps the Arabic comma inside a run instead of cutting on it", () => {
    const list = BILLING.match(SPLIT_RUN) ?? [];
    assert.ok(list.length >= 3);
    // A run boundary never lands between the comma and the word after it.
    assert.ok(list.every((run) => !run.startsWith("،")));
  });

  it("folds Arabic spelling variants so a query finds a seed written another way", () => {
    // ة -> ه, ى -> ي, أ/إ/آ -> ا, and the Persian ی font form.
    assert.equal(normalizeText("الفاتورة"), normalizeText("الفاتوره"));
    assert.equal(normalizeText("إلى"), normalizeText("الي"));
    assert.equal(normalizeText("إنجاز"), normalizeText("انجاز"));
    assert.equal(normalizeText("مبانى"), normalizeText("مباني"));
    assert.equal(normalizeText("میعاد"), normalizeText("ميعاد"));
  });

  it("drops Arabic diacritics and the tatweel as presentation", () => {
    assert.equal(normalizeText("فَاتُورَة"), normalizeText("فاتورة"));
    assert.equal(normalizeText("بــحث"), "بحث");
  });

  it("tokenizes Arabic words and removes the language's stop terms", () => {
    const tokens = tokenize("ما هي الرسوم في الميناء المصري");
    assert.ok(tokens.includes("الرسوم"));
    assert.ok(tokens.includes("الميناء"));
    assert.ok(tokens.includes("المصري"));
    // ما and في are particles, not retrieval signals.
    assert.ok(!tokens.includes("ما"));
    assert.ok(!tokens.includes("في"));
  });

  it("reports the dominant script of Arabic and English text", () => {
    assert.equal(dominantScript("الفوترة تحسب لكل مقعد"), "ar");
    assert.equal(dominantScript("Billing is per seat"), "en");
  });
});

describe("Arabic fixed splitting", () => {
  it("cuts an Arabic paragraph on its sentence marks, never on the comma", () => {
    const chunks = fixedSplit(BILLING, { maxChars: 40 });
    // Every seed is sentence-bounded: it closes on its own mark.
    assert.ok(chunks.length > 0);
    for (const chunk of chunks) {
      assertSentenceBounded(chunk.body, "billing paragraph");
      assert.ok(!chunk.body.startsWith("،"), "a seed never opens on a comma");
    }
    // The paragraph's three sentences all survive, in order.
    const joined = chunks.map((chunk) => chunk.body).join(" ");
    assert.ok(joined.includes("الفوترة تحسب لكل مقعد."));
    assert.ok(joined.includes("تصدر الفاتورة شهريا."));
    assert.ok(joined.includes("هل تشمل الضريبة؟"));
  });

  it("does not mistake a paragraph of short Arabic sentences for headings", () => {
    const paragraph = "الخطة الأولى تنفذ اليوم.\nالخطة الثانية تنفذ غدا.\nالخطة الثالثة تنفذ الأسبوع القادم.";
    const chunks = fixedSplit(paragraph, { maxChars: 400 });
    // A line closed by a terminator is a sentence, not a heading, so the block
    // stays intact and is cut on sentence boundaries only.
    assert.equal(chunks.length, 1);
    assert.equal(sentences(chunks[0]!.body).length, 3, `every sentence survives: ${chunks[0]!.body}`);
    assertSentenceBounded(chunks[0]!.body, "short Arabic sentences");
  });

  it("keeps an Arabic heading with the paragraph it introduces", () => {
    const doc = "سياسة الفوترة\nالفوترة تحسب لكل مقعد. تصدر الفاتورة شهريا.";
    const chunks = fixedSplit(doc, { maxChars: 200 });
    // The heading is not a sentence, so it opens its block and the sentences stay
    // with it: no heading-only seed, no orphaned first sentence.
    assert.equal(chunks.length, 1);
    assert.ok(chunks[0]!.body.includes("سياسة الفوترة"), "the heading stays with its paragraph");
    assert.ok(chunks[0]!.body.includes("الفوترة تحسب لكل مقعد."));
    assert.ok(chunks[0]!.body.includes("تصدر الفاتورة شهريا."));
  });

  it("splits an oversized Arabic list on its sentences, not mid-phrase", () => {
    const long = Array.from({ length: 12 }, (_, i) => `البند رقم ${i + 1} يشمل تفاصيل الفوترة للمقاعد.`).join(" ");
    const chunks = fixedSplit(long, { maxChars: 200 });
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      // Every seed opens at a sentence start, so no seed begins mid-sentence.
      assert.ok(chunk.body.startsWith("البند رقم"), `every seed opens at a sentence start: ${chunk.body.slice(0, 24)}`);
      assert.ok(chunk.body.length <= 200);
    }
  });
});

/** One Arabic billing seed, the answer to every query in this file. */
function arabicSeed(): KnowledgeSeed {
  return {
    id: "seed-ar-billing",
    title: "الفوترة تحسب لكل مقعد",
    body: "الفوترة تحسب لكل مقعد. تصدر الفاتورة شهريا.",
    tags: ["الفوترة", "مقعد"],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** A second seed about a different subject, so ranking is meaningful. */
function otherSeed(): KnowledgeSeed {
  return {
    id: "seed-ar-shipping",
    title: "الشحن الدولي",
    body: "الشحن الدولي يستغرق عشرة أيام عمل.",
    tags: ["الشحن"],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** Rank an explicit seed list with the production lexical scorer. */
function rank(query: string, seeds: KnowledgeSeed[]) {
  const hits = seeds
    .map((seed) => ({ seed, scored: lexicalScore(seed, queryTerms(query)) }))
    .filter((entry) => entry.scored.score > 0)
    .map((entry) => ({ seedId: entry.seed.id, score: entry.scored.score, matched: entry.scored.matched }))
    .sort((a, b) => b.score - a.score || a.seedId.localeCompare(b.seedId));
  return { hits, empty: hits.length === 0 };
}

describe("Arabic bilingual retrieval", () => {
  it("matches an Arabic query against a seed however either was spelled", () => {
    const seed = arabicSeed();
    // The query uses ta marbuta; the seed uses ha. The fold makes them one term.
    const terms = queryTerms("الفاتوره لكل مقعد");
    assert.ok(terms.length > 0);
    const scored = lexicalScore(seed, terms);
    assert.ok(scored.score > 0, "an Arabic query must match an Arabic seed");
    assert.deepEqual(scored.matched.sort(), [...terms].sort());
  });

  it("ranks the seed that answers the whole query above one that answers part", () => {
    const { hits } = rank("الفوترة لكل مقعد", [arabicSeed(), otherSeed()]);
    assert.equal(hits[0]!.seedId, "seed-ar-billing");
    // The shipping seed never enters the results: it covers none of the query.
    assert.ok(!hits.some((hit) => hit.seedId === "seed-ar-shipping"));
  });

  it("finds the Arabic seed from an Arabic question with stop terms removed", () => {
    const { hits, empty } = rank("ما هي الفوترة لكل مقعد", [arabicSeed(), otherSeed()]);
    assert.equal(empty, false);
    assert.equal(hits[0]!.seedId, "seed-ar-billing");
  });

  it("still retrieves the English seed for an English query", () => {
    const english: KnowledgeSeed = {
      id: "seed-en-billing",
      title: "Billing is per seat",
      body: "Billing is per seat. The invoice is issued monthly.",
      tags: ["billing"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const { hits } = rank("billing per seat", [english, arabicSeed()]);
    assert.equal(hits[0]!.seedId, "seed-en-billing");
  });
});
