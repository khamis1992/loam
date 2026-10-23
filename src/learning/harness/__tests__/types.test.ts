/**
 * H1 tests for src/learning/harness/types.ts (BUILD_SPEC 6.1).
 * node:test; no model API is called.
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import { isCompleteLesson, domainOf, type DistillResult } from "../types.js";

const complete: DistillResult = {
  cue: "when the user corrects the summary",
  lesson: "re-read the source before answering.",
  evidence: "the user said the summary missed section 2.",
  confidence: "medium",
};

describe("isCompleteLesson", () => {
  it("accepts a lesson with all three fields non-empty", () => {
    assert.equal(isCompleteLesson(complete), true);
  });

  it("rejects null and undefined", () => {
    assert.equal(isCompleteLesson(null), false);
    assert.equal(isCompleteLesson(undefined), false);
  });

  it("rejects an empty object", () => {
    assert.equal(isCompleteLesson({}), false);
  });

  it("rejects an empty cue", () => {
    assert.equal(isCompleteLesson({ ...complete, cue: "" }), false);
  });

  it("rejects a whitespace-only cue", () => {
    assert.equal(isCompleteLesson({ ...complete, cue: "   " }), false);
  });

  it("rejects an empty lesson", () => {
    assert.equal(isCompleteLesson({ ...complete, lesson: "" }), false);
  });

  it("rejects an empty evidence", () => {
    assert.equal(isCompleteLesson({ ...complete, evidence: "" }), false);
  });

  it("rejects a missing evidence field", () => {
    const { evidence: _evidence, ...rest } = complete;
    assert.equal(isCompleteLesson(rest), false);
  });

  it("rejects a non-string field", () => {
    assert.equal(isCompleteLesson({ ...complete, cue: 42 as unknown as string }), false);
  });

  it("narrows the type so the fields are usable", () => {
    const d: Partial<DistillResult> = { ...complete };
    if (isCompleteLesson(d)) {
      assert.equal(d.cue.trim().length > 0, true);
      assert.equal(d.lesson.trim().length > 0, true);
      assert.equal(d.evidence.trim().length > 0, true);
    }
  });
});

describe("domainOf", () => {
  it("collapses a slash path into one token", () => {
    assert.equal(domainOf("A / B"), "a__b");
  });

  it("maps an empty string to general", () => {
    assert.equal(domainOf(""), "general");
  });

  it("maps undefined and null to general", () => {
    assert.equal(domainOf(undefined), "general");
    assert.equal(domainOf(null), "general");
  });

  it("maps a whitespace-only string to general", () => {
    assert.equal(domainOf("   "), "general");
  });

  it("lowercases and hyphenates spaces", () => {
    assert.equal(domainOf("  Web App  "), "web-app");
  });

  it("treats a backslash separator as a domain join", () => {
    assert.equal(domainOf("Web\\Docs"), "web__docs");
  });

  it("never produces a path separator", () => {
    assert.equal(domainOf("a/b\\c").includes("/"), false);
  });
});
