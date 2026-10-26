import assert from "node:assert/strict";
import { test } from "node:test";
import { makeAvid } from "../corpusStore.js";
import { searchLaw, type Embedder, type Reranker } from "../retrieval.js";
import { loadFixtureCorpus } from "./helpers.js";

const C = "law/2090/1:body:";

test("direct reference ranks the in-force version first", async () => {
  const r = await searchLaw(loadFixtureCorpus(), "المادة 3 من القانون المدني الاختباري", { asOf: "2092-01-01" });
  assert.equal(r.direct, true);
  assert.equal(r.hits[0]?.avid, makeAvid(`${C}3`, "2091-07-01"));
  assert.equal(r.hits[0]?.status, "in_force");
});

test("as-of before the amendment returns the old text", async () => {
  const r = await searchLaw(loadFixtureCorpus(), "المادة ٣ من القانون المدني الاختباري", { asOf: "2091-01-01" });
  assert.equal(r.hits[0]?.avid, makeAvid(`${C}3`, "2090-04-01"));
});

test("topical lexical search finds the penalty-clause article", async () => {
  const r = await searchLaw(loadFixtureCorpus(), "تخفيض التعويض الاتفاقي", { asOf: "2092-01-01" });
  assert.equal(r.mode, "lexical");
  assert.ok(r.hits.some((h) => h.articleKey === `${C}3`));
  assert.ok(r.hits.every((h) => h.status === "in_force"), "historical versions excluded by default");
});

test("historical versions are returned only on request and are marked", async () => {
  const r = await searchLaw(loadFixtureCorpus(), "التعويض الاتفاقي", { asOf: "2092-01-01", includeHistorical: true, k: 10 });
  assert.ok(r.hits.some((h) => h.status === "historical"));
});

test("unverified-provenance articles are returned as not citable", async () => {
  const r = await searchLaw(loadFixtureCorpus(), "الأجرة المستأجر", { asOf: "2096-01-01" });
  const hit = r.hits.find((h) => h.legKey === "law/2095/5");
  assert.ok(hit);
  assert.equal(hit.citable, false);
});

test("nothing relevant -> noAuthority", async () => {
  const r = await searchLaw(loadFixtureCorpus(), "براءات الاختراع والعلامات التجارية", { asOf: "2092-01-01" });
  assert.equal(r.noAuthority, true);
  assert.equal(r.hits.length, 0);
});

test("lawKey restricts results", async () => {
  const r = await searchLaw(loadFixtureCorpus(), "الدعوى", { asOf: "2088-06-01", lawKey: "decree-law/2088/7" });
  assert.ok(r.hits.length > 0);
  assert.ok(r.hits.every((h) => h.legKey === "decree-law/2088/7"));
});

test("hybrid mode fuses an embedder and applies a reranker without reordering input", async () => {
  const corpus = loadFixtureCorpus();
  const dims = 4;
  const vec = (s: string): number[] => Array.from({ length: dims }, (_v, i) => (s.includes("حسن النية") ? 1 : 0.1) * (i + 1));
  const embedder: Embedder = { embed: async (texts) => texts.map(vec) };
  for (const v of corpus.versionsMissingVector("test-embed", 100)) corpus.putVector(v.avid, "test-embed", Float32Array.from(vec(v.text)));
  let seen = 0;
  const reranker: Reranker = { score: async (_q, cands) => { seen = cands.length; return cands.map((c) => (c.text.includes("حسن النية") ? 1 : 0)); } };
  const r = await searchLaw(corpus, "حسن النية في تنفيذ العقد", { asOf: "2092-01-01", embedder, embedModel: "test-embed", reranker });
  assert.equal(r.mode, "hybrid");
  assert.ok(seen > 0);
  assert.equal(r.hits[0]?.articleKey, `${C}4`);
});
