/**
 * H3 tests for src/learning/harness/correctionDetector.ts (BUILD_SPEC 6.3).
 * node:test; no model API is called and nothing is persisted.
 *
 * Arabic literals are written with the file-edit tool only (never a shell redirect):
 * the Windows shell corrupts non-ASCII into mojibake.
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import { detectCorrection, CORRECTION_THRESHOLD, type DetectResult } from "../correctionDetector.js";

/** A realistic prior assistant turn, so "no prior assistant" is a separate case. */
const PRIOR = "Sure! Here is the summary you asked for. Let me know if you want more detail.";

function detect(userText: string, priorAssistant: string | null = PRIOR): DetectResult {
  return detectCorrection({ priorAssistant, userText });
}

describe("detectCorrection - Arabic fixtures", () => {
  it("accepts the Gulf correction «لا، قلت لك اكتب اسم نتريو بالعربي «نتريو» مو Nutrio»", () => {
    const r = detect("لا، قلت لك اكتب اسم نتريو بالعربي «نتريو» مو Nutrio");
    assert.equal(r.isCorrection, true, JSON.stringify(r));
    // One cue is reported per pattern (BUILD_SPEC 6.3): the Arabic pattern matches its
    // first alternative, the opening negation.
    assert.ok(r.matched.length > 0);
    assert.ok(r.matched.some((m) => m.includes("لا")), `expected the opening لا, got ${JSON.stringify(r.matched)}`);
  });

  it("accepts a plain negation opener «لا، مو كذا»", () => {
    const r = detect("لا، مو كذا يا صديقي");
    assert.equal(r.isCorrection, true);
    assert.ok(r.matched.length > 0);
  });

  it("accepts «غلط» (wrong)", () => {
    assert.equal(detect("هذا غلط، رجاءً صحصحه").isCorrection, true);
  });

  it("accepts «المفروض» (you were supposed to)", () => {
    assert.equal(detect("المفروض تكتب الاسم بالعربي").isCorrection, true);
  });

  it("accepts «بدال» (instead of)", () => {
    assert.equal(detect("بدال ما تكتب بالانجليزي، اكتبها بالعربي").isCorrection, true);
  });

  it("accepts «مرة ثانية» (again)", () => {
    assert.equal(detect("مرة ثانية، لا تضف العلامة التجارية").isCorrection, true);
  });

  it("accepts a question-style Gulf correction «ليش سويت كذا؟»", () => {
    assert.equal(detect("ليش سويت كذا؟").isCorrection, true);
  });
});

describe("detectCorrection - English fixtures", () => {
  it("accepts «no, that's not what I asked»", () => {
    const r = detect("no, that's not what I asked for");
    assert.equal(r.isCorrection, true);
    assert.ok(r.matched.some((m) => m.startsWith("no")));
  });

  it("accepts «wrong, try again»", () => {
    const r = detect("wrong, try again");
    assert.equal(r.isCorrection, true);
    assert.ok(r.matched.includes("wrong"));
  });

  it("accepts «I told you to keep it short»", () => {
    assert.equal(detect("I told you to keep it short").isCorrection, true);
  });

  it("accepts «instead, use the Arabic name»", () => {
    assert.equal(detect("instead, use the Arabic name").isCorrection, true);
  });
});

describe("detectCorrection - negative fixtures (must not be corrections)", () => {
  it("rejects gratitude «thanks, perfect»", () => {
    const r = detect("thanks, perfect!");
    assert.equal(r.isCorrection, false);
    // No cue matched, so the only contribution is the short-message bonus (0.1).
    assert.equal(r.matched.length, 0);
    assert.ok(r.score < CORRECTION_THRESHOLD, `score must stay under the threshold, got ${r.score}`);
  });

  it("rejects a neutral follow-up «ok, continue with the next section»", () => {
    assert.equal(detect("ok, continue with the next section").isCorrection, false);
  });

  it("rejects a long, neutral elaboration that is well over the short-message prior", () => {
    const long = `ok so here is what I think about the whole thing. ${"We could also add more detail later on. ".repeat(30)}`;
    assert.ok(long.length >= 400, "fixture must exceed the short-correction window");
    assert.equal(detect(long).isCorrection, false);
  });

  it("rejects a message with no negation cue at all", () => {
    assert.equal(detect("can you make the title a bit bolder?").isCorrection, false);
  });
});

describe("detectCorrection - gating on a prior assistant turn", () => {
  it("rejects a correction-looking message when there is no prior assistant turn", () => {
    const r = detect("لا، قلت لك اكتب اسم نتريو بالعربي", null);
    assert.equal(r.isCorrection, false);
    assert.equal(r.score, 0);
    assert.deepEqual(r.matched, []);
  });

  it("rejects a correction-looking message when the prior assistant turn is empty", () => {
    assert.equal(detect("no, that's not what I asked", "   ").isCorrection, false);
  });

  it("rejects a blank user message even with a prior assistant turn", () => {
    assert.equal(detect("   ").isCorrection, false);
    assert.equal(detect("").isCorrection, false);
  });
});

describe("detectCorrection - score contract", () => {
  it("never exceeds 1 even with every bonus stacked", () => {
    const r = detect("لا، غلط، قلت لك");
    assert.ok(r.score <= 1, `score must be capped, got ${r.score}`);
    assert.equal(r.isCorrection, true);
  });

  it("reports a score at or above the threshold exactly when isCorrection is true", () => {
    for (const text of [
      "لا، قلت لك",
      "wrong",
      "thanks, perfect!",
      "ok, continue",
      "المفروض",
      "instead",
    ]) {
      const r = detect(text);
      assert.equal(r.isCorrection, r.score >= CORRECTION_THRESHOLD, `${text}: ${r.score}`);
    }
  });

  it("returns the matched cues so a caller can audit the decision", () => {
    const r = detect("no, that's not what I asked");
    assert.ok(Array.isArray(r.matched));
    assert.ok(r.matched.every((m) => typeof m === "string"));
  });
});
