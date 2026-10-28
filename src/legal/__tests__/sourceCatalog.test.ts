import assert from "node:assert/strict";
import { test } from "node:test";
import { OFFICIAL_GAZETTE_URL, OFFICIAL_SOURCE_CANDIDATES } from "../corpus/sourceCatalog.js";

test("official source candidates are unique, traceable and unverified until human review", () => {
  const keys = OFFICIAL_SOURCE_CANDIDATES.map((candidate) => `${candidate.legislation.type}/${candidate.legislation.year}/${candidate.legislation.number}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.includes("law/2004/22"));
  assert.ok(keys.includes("law/2016/13"));
  for (const candidate of OFFICIAL_SOURCE_CANDIDATES) {
    const url = new URL(candidate.source.url!);
    assert.equal(url.protocol, "https:");
    assert.equal(url.hostname, "almeezan.qa");
    assert.equal("verifiedBy" in candidate.source, false);
    assert.equal("verifiedAt" in candidate.source, false);
    assert.ok(candidate.reviewNotes.length > 0);
  }
  assert.equal(new URL(OFFICIAL_GAZETTE_URL).hostname, "officialgazette.gov.qa");
  assert.ok(OFFICIAL_SOURCE_CANDIDATES.find((candidate) => candidate.legislation.number === 27)?.reviewNotes.some((note) => note.includes("three-year")));
});
