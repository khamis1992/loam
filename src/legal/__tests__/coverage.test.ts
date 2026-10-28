import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LegalCorpus, type LegalPack } from "../corpusStore.js";
import { searchLaw } from "../retrieval.js";
import { verifyDocument } from "../verify.js";
import { FIXTURE_DIR } from "./helpers.js";

function corpusWithVerifiedLaw(): LegalCorpus {
  const corpus = new LegalCorpus(":memory:");
  const pack = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "corpus", "01-civil-test.json"), "utf8")) as LegalPack;
  pack.source.verifiedAt = "2026-10-26T00:00:00Z";
  corpus.importPack(pack);
  return corpus;
}

test("coverage distinguishes unconfigured, incomplete and complete corpora", async () => {
  const corpus = corpusWithVerifiedLaw();
  assert.equal(corpus.coverage({ asOf: "2026-10-26", now: new Date("2026-10-26T00:00:00Z") }).status, "unconfigured");
  const missing = await searchLaw(corpus, "عبارة لا تطابق أي نص", { asOf: "2026-10-26" });
  assert.equal(missing.authorityReason, "COVERAGE_UNCONFIGURED");
  corpus.setCoverageManifest([
    { legKey: "law/2090/1", titleAr: "القانون المدني الاختباري", requiredFor: ["contract_review"] },
    { legKey: "law/2099/99", titleAr: "قانون مفقود اختباري", requiredFor: ["contract_review"] },
  ]);
  const incomplete = corpus.coverage({ asOf: "2026-10-26", matterKind: "contract_review", now: new Date("2026-10-26T00:00:00Z") });
  assert.equal(incomplete.status, "incomplete");
  assert.deepEqual(incomplete.issues.map((i) => i.reason), ["missing"]);
  corpus.setCoverageManifest([{ legKey: "law/2090/1", titleAr: "القانون المدني الاختباري", requiredFor: ["contract_review"] }]);
  assert.equal(corpus.coverage({ asOf: "2026-10-26", matterKind: "contract_review", now: new Date("2026-10-26T00:00:00Z") }).status, "complete");
  const noMatch = await searchLaw(corpus, "عبارة لا تطابق أي نص", { asOf: "2026-10-26", matterKind: "contract_review" });
  assert.equal(noMatch.authorityReason, "NO_MATCH");
  assert.equal(noMatch.coverage.status, "complete");
  corpus.close();
});

test("coverage rejects stale and unverified required sources", () => {
  const corpus = corpusWithVerifiedLaw();
  corpus.setCoverageManifest([{ legKey: "law/2090/1", titleAr: "القانون المدني الاختباري", requiredFor: ["research"], maxReviewAgeDays: 1 }]);
  assert.equal(corpus.coverage({ asOf: "2026-11-01", now: new Date("2026-11-01T00:00:00Z") }).issues[0]?.reason, "stale");
  corpus.close();
  const unverified = new LegalCorpus(":memory:");
  const pack = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "corpus", "01-civil-test.json"), "utf8")) as LegalPack;
  unverified.importPack(pack);
  unverified.setCoverageManifest([{ legKey: "law/2090/1", titleAr: "القانون المدني الاختباري", requiredFor: ["research"] }]);
  assert.equal(unverified.coverage({ asOf: "2026-10-26" }).issues[0]?.reason, "unverified");
  unverified.close();
});

test("snapshots are stable and every search and verification names its snapshot", async () => {
  const corpus = corpusWithVerifiedLaw();
  const first = corpus.snapshot({ persist: true });
  assert.equal(corpus.snapshot({ persist: false }).id, first.id);
  assert.equal((corpus.db.prepare("SELECT COUNT(*) AS n FROM corpus_snapshots").get() as { n: number } | undefined)?.n, 1);
  const found = await searchLaw(corpus, "العقد شريعة المتعاقدين", { asOf: "2090-05-01" });
  assert.equal(found.corpusSnapshotId, first.id);
  const avid = found.hits[0]!.avid;
  const report = verifyDocument(corpus, `«${found.hits[0]!.text}» ⟦cite:${avid}⟧`, { asOf: "2090-05-01" });
  assert.equal(report.corpusSnapshotId, first.id);
  assert.equal(report.coverage.status, "unconfigured");
  corpus.close();
});
