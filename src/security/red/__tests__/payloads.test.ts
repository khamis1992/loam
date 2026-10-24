/**
 * Payload corpus tests (RED_TEAM_BUILD_SPEC §6.7).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getPayloads, transformPayload, wordlist, PAYLOAD_CORPUS, type Payload } from "../payloads/payloads.js";

describe("payload corpus", () => {
  it("covers every vuln class with at least 3 payloads", () => {
    const classes: Payload["class"][] = ["xss", "sqli", "ssrf", "xxe", "ssti", "cmdi", "lfi", "redirect", "deser", "upload"];
    for (const cls of classes) {
      assert.ok(getPayloads(cls).length >= 3, `${cls} needs >= 3 payloads`);
    }
    assert.ok(PAYLOAD_CORPUS.every((p) => p.id && p.template && Array.isArray(p.tags)));
    assert.equal(new Set(PAYLOAD_CORPUS.map((p) => p.id)).size, PAYLOAD_CORPUS.length, "ids unique");
  });

  it("filters by tag", () => {
    const blind = getPayloads("sqli", { tags: ["blind"] });
    assert.ok(blind.length >= 2);
    assert.ok(blind.every((p) => p.tags.includes("blind")));
  });

  it("transforms are correct and pure", () => {
    const p = getPayloads("xss")[0]!;
    const before = p.template;
    assert.equal(transformPayload(p, "url"), encodeURIComponent(before));
    assert.equal(transformPayload(p, "double"), encodeURIComponent(encodeURIComponent(before)));
    assert.ok(transformPayload(p, "html").includes("&lt;"));
    assert.equal(Buffer.from(transformPayload(p, "base64"), "base64").toString("utf8"), before);
    assert.ok(transformPayload(p, "unicode").startsWith("\\u003c"));
    assert.equal(p.template, before, "original untouched");
  });

  it("wordlists are non-empty and copied per call", () => {
    const dirs = wordlist("dirs");
    assert.ok(dirs.length >= 40);
    assert.ok(dirs.includes(".env"));
    assert.notEqual(dirs, wordlist("dirs"), "each call returns a fresh copy");
    assert.ok(wordlist("params").length > 0);
    assert.ok(wordlist("vhosts").length > 0);
  });
});
