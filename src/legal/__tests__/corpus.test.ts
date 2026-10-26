import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { inForce, LegalCorpus, makeAvid, validatePack, type LegalPack } from "../corpusStore.js";
import { searchLaw } from "../retrieval.js";
import { FIXTURE_DIR, loadFixtureCorpus } from "./helpers.js";

const C = "law/2090/1:body:";
const readPack = (f: string): LegalPack => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "corpus", f), "utf8")) as LegalPack;

test("fixture corpus loads with versions and statuses", () => {
  const c = loadFixtureCorpus();
  const s = c.stats();
  assert.equal(s.legislations, 5);
  assert.equal(s.articles, 14);
  assert.equal(s.versions, 15);
  assert.equal(c.getLegislation("law/2090/1")?.status, "partially_repealed");
  assert.equal(c.getLegislation("decree-law/2088/7")?.status, "repealed");
  assert.equal(c.getLegislation("decree-law/2088/7")?.repealedBy, "law/2089/8");
});

test("as-of resolution follows the amendment chain", () => {
  const c = loadFixtureCorpus();
  const before = c.versionAt(`${C}3`, "2091-06-30");
  const after = c.versionAt(`${C}3`, "2091-07-01");
  assert.equal(before?.avid, makeAvid(`${C}3`, "2090-04-01"));
  assert.equal(after?.avid, makeAvid(`${C}3`, "2091-07-01"));
  assert.equal(before?.effectiveTo, "2091-07-01");
  assert.equal(after?.introducedBy, "law/2091/2");
  assert.equal(c.versionAt(`${C}3bis`, "2091-06-30"), undefined, "inserted article does not exist before its date");
  assert.equal(c.versionAt(`${C}5`, "2091-07-01"), undefined, "repealed article has no in-force version");
  assert.ok(c.versionAt(`${C}5`, "2091-06-30"));
  const chain = c.amendmentsOf(`${C}3`);
  assert.equal(chain.length, 1);
  assert.equal(chain[0]?.kind, "replace");
  const r = c.resolve(makeAvid(`${C}3`, "2090-04-01"), "2092-01-01");
  assert.equal(r?.inForceAt, false);
  assert.equal(r?.laterVersions.length, 1);
});

test("inForce uses an inclusive start and exclusive end", () => {
  assert.equal(inForce({ effectiveFrom: "2090-01-01", effectiveTo: "2091-01-01" }, "2090-01-01"), true);
  assert.equal(inForce({ effectiveFrom: "2090-01-01", effectiveTo: "2091-01-01" }, "2091-01-01"), false);
  assert.equal(inForce({ effectiveFrom: "2090-01-01", effectiveTo: null }, "2999-01-01"), true);
});

test("labels are canonical: Hindi digits and ordinal words", () => {
  const c = loadFixtureCorpus();
  assert.ok(c.getArticle(`${C}5`), "١ ٥ stored as 5");
  assert.ok(c.getArticle(`${C}50`), "الخمسون stored as 50");
  assert.ok(c.getArticle("law/2090/1:issuance:1"));
});

test("re-importing the identical pack is a no-op; a changed pack is refused", () => {
  const c = loadFixtureCorpus();
  const pack = readPack("01-civil-test.json");
  const again = c.importPack(pack);
  assert.equal(again.created, false);
  assert.equal(c.stats().versions, 15);
  const changed = structuredClone(pack);
  const first = changed.articles[0];
  assert.ok(first);
  first.text = `${first.text} (نص معدّل)`;
  assert.throws(() => c.importPack(changed));
});

test("validatePack requires verifiedBy for official provenance and valid dates/labels", () => {
  const pack = readPack("01-civil-test.json");
  const bad = structuredClone(pack);
  delete bad.source.verifiedBy;
  assert.ok(validatePack(bad).some((e) => e.includes("verifiedBy")));
  const bad2 = structuredClone(pack);
  bad2.legislation.effectiveDate = "2090-02-30";
  assert.ok(validatePack(bad2).some((e) => e.includes("effectiveDate")));
  const bad3 = structuredClone(pack);
  bad3.articles.push({ label: "xyz", text: "نص" });
  assert.ok(validatePack(bad3).some((e) => e.includes("not a valid article label")));
  assert.deepEqual(validatePack(pack), []);
});

test("correctVersionText keeps the avid, records who corrected it and reindexes", async () => {
  const c = loadFixtureCorpus();
  const avid = makeAvid(`${C}4`, "2090-04-01");
  const v = c.correctVersionText(avid, "يجب تنفيذ العقد طبقاً لما اشتمل عليه وبطريقة تتفق مع ما يوجبه حسن النية والأمانة.", "مراجع الاختبار");
  assert.equal(v.avid, avid);
  assert.ok(v.text.endsWith("والأمانة."));
  assert.equal(c.getVersion(avid)?.source.verifiedBy, "مراجع الاختبار");
  const r = await searchLaw(c, "الأمانة", { asOf: "2092-01-01" });
  assert.equal(r.hits[0]?.avid, avid, "new wording is searchable");
});

test("a corpus file on disk round-trips", () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "legal-corpus-"));
  const file = path.join(dir, "qatar-law.db");
  const c1 = new LegalCorpus(file);
  c1.importPack(readPack("01-civil-test.json"));
  c1.close();
  const c2 = new LegalCorpus(file);
  assert.equal(c2.stats().legislations, 1);
  c2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
