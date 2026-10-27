import assert from "node:assert";
import { describe, it } from "node:test";
import { buildEvidenceMatrix, buildMatterTimeline, compareBilingualClauseNumbers, findConflictCandidates, normalizeLegalName, validateLegalSource, type LegalSource } from "../legal/qatar.js";
import type { ArtifactRef } from "../contracts.js";

const ref: ArtifactRef = { taskId: "task", path: "case.docx", kind: "document", revision: 0, contentHash: "b".repeat(64), tenantId: "local" };

describe("Qatar legal intelligence utilities", () => {
  it("requires effective official legal sources", () => {
    const source: LegalSource = {
      id: "source-1", title: "نص رسمي", citation: "مادة 1", sourceUrl: "https://example.gov.qa/law/1", issuer: "جهة رسمية",
      text: "النص الرسمي", effectiveFrom: "2020-01-01", retrievedAt: "2026-01-01", official: true,
    };
    assert.doesNotThrow(() => validateLegalSource(source, new Date("2026-01-02")));
    assert.throws(() => validateLegalSource({ ...source, official: false }, new Date("2026-01-02")), /official/);
    assert.throws(() => validateLegalSource({ ...source, effectiveFrom: "2030-01-01" }, new Date("2026-01-02")), /not effective/);
    assert.throws(() => validateLegalSource({ ...source, sourceUrl: "http://example.gov.qa" }, new Date("2026-01-02")), /HTTPS/);
  });

  it("normalizes Arabic names and returns conflict candidates for human review", () => {
    assert.equal(normalizeLegalName("شركة الإنماء  للمقاولات"), normalizeLegalName("شركه الانماء للمقاولات"));
    const matches = findConflictCandidates(["شركة الإنماء للمقاولات"], [{ matterId: "m1", client: "شركة الانماء للمقاولات", parties: ["طرف آخر"] }]);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.matterId, "m1");
  });

  it("builds a sourced Arabic timeline without inferring legal deadlines", () => {
    const timeline = buildMatterTimeline(ref, [
      { anchor: "1", text: "وقع الطرفان العقد في 12/03/2024." },
      { anchor: "2", text: "أرسل العميل إخطارًا في 5 مايو 2024." },
      { anchor: "3", text: "وصل الرد في 2024-06-10." },
    ]);
    assert.deepEqual(timeline.map((event) => event.date), ["2024-03-12", "2024-05-05", "2024-06-10"]);
    assert.ok(timeline.every((event) => event.source.artifact.path === "case.docx"));
  });

  it("marks unsupported claims and compares bilingual clause numbering", () => {
    const matrix = buildEvidenceMatrix([{ claim: "ادعاء", evidenceSourceIds: ["known", "unknown"] }, { claim: "بلا دليل", evidenceSourceIds: [] }], new Set(["known"]));
    assert.equal(matrix[0]?.status, "supported");
    assert.deepEqual(matrix[0]?.evidenceSourceIds, ["known"]);
    assert.equal(matrix[1]?.status, "missing-evidence");
    const compared = compareBilingualClauseNumbers("البند 1: أ\nالمادة 2: ب", "Clause 1: A\nArticle 3: C");
    assert.deepEqual(compared.missingInArabic, ["3"]);
    assert.deepEqual(compared.missingInEnglish, ["2"]);
  });
});
