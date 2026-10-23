/**
 * H10 tests for src/learning/harness/probe.ts (BUILD_SPEC §9 D).
 *
 * Acceptance: "with fake runner, the better-scoring block is kept; ≤ 2 extra
 * rollouts asserted". No model API is called — the runner is a fake.
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import {
  MAX_EXTRA_ROLLOUTS,
  LESSON_BLOCK_MAX_CHARS,
  buildLessonBlock,
  buildCandidates,
  probe,
} from "../probe.js";
import type { Lesson } from "../types.js";

const baseLesson = (over: Partial<Lesson>): Lesson => ({
  id: "les_001",
  agentId: null,
  domain: "content-ar",
  source: "correction",
  cue: "عند كتابة محتوى عربي",
  lesson: "اكتب اسم التطبي بالعربي «نتريو» وليس Nutrio",
  evidence: "المستخدم صحّح كتابة الاسم",
  confidence: "high",
  sourceRef: "cor_001",
  uses: 1,
  createdAt: "2026-10-23T00:00:00.000Z",
  ...over,
});

describe("buildLessonBlock", () => {
  it("returns empty for no lessons", () => {
    assert.equal(buildLessonBlock([]), "");
  });

  it("builds a block with the header and each lesson", () => {
    const l: Lesson = baseLesson({});
    const block = buildLessonBlock([l]);
    assert.ok(block.startsWith("## Learned from earlier corrections"));
    assert.match(block, /عند كتابة محتوى عربي/);
    assert.match(block, /نتريو/);
  });

  it("caps total length at LESSON_BLOCK_MAX_CHARS", () => {
    const big: Lesson[] = [];
    for (let i = 0; i < 100; i++) big.push(baseLesson({ id: `les_${i}`, lesson: "x".repeat(200) }));
    const block = buildLessonBlock(big);
    assert.ok(block.length <= LESSON_BLOCK_MAX_CHARS);
  });
});

describe("buildCandidates", () => {
  it("generates INV (all) and DOM (domain-filtered) blocks", () => {
    const lessons: Lesson[] = [
      baseLesson({ id: "a", domain: "content-ar" }),
      baseLesson({ id: "b", domain: "design", cue: "عند التصميم", lesson: "استخدم التصميم" }),
    ];
    const { inv, dom } = buildCandidates(lessons, "content-ar");
    // INV includes both
    assert.match(inv, /عند كتابة محتوى عربي/); // content-ar lesson
    assert.match(inv, /عند التصميم/); // design lesson
    // DOM only includes the matching domain
    assert.match(dom, /عند كتابة محتوى عربي/); // content-ar lesson present
    assert.doesNotMatch(dom, /عند التصميم/); // design lesson excluded
  });

  it("DOM is empty when no lessons match the domain", () => {
    const lessons: Lesson[] = [baseLesson({ id: "a", domain: "other" })];
    const { inv, dom } = buildCandidates(lessons, "content-ar");
    assert.match(inv, /عند كتابة محتوى عربي/);
    assert.equal(dom, "");
  });
});

describe("probe", () => {
  it("keeps the better-scoring block with exactly 2 extra rollouts", async () => {
    const lessons: Lesson[] = [
      baseLesson({ id: "a", domain: "design", cue: "عند التصميم", lesson: "استخدم التصميم" }),
      baseLesson({ id: "b", domain: "content-ar" }),
    ];
    let calls = 0;
    const runner = async (prompt: string): Promise<number> => {
      calls++;
      assert.match(prompt, /Learned from earlier corrections/);
      // INV includes both lessons (design + content-ar)
      // DOM only includes content-ar lessons (filtering out design)
      // So INV is longer → lower score in this mock
      if (prompt.includes("عند التصميم")) return 0.3; // INV lower due to extra content
      return 0.7; // DOM higher
    };
    const { inv, dom, chosen, invScore, domScore, extraRollouts } = await probe({
      lessons,
      domain: "content-ar",
      runner,
    });
    assert.equal(calls, 2);
    assert.equal(extraRollouts, MAX_EXTRA_ROLLOUTS);
    assert.equal(chosen, dom, "DOM should be chosen when it scores higher");
    assert.equal(domScore, 0.7);
    assert.equal(invScore, 0.3);
  });

  it("keeps the DOM block when it scores higher than INV", async () => {
    const lessons: Lesson[] = [
      baseLesson({ id: "a", domain: "content-ar", cue: "عند كتابة محتوى عربي" }),
      baseLesson({ id: "b", domain: "design", cue: "عند التصميم", lesson: "استخدم التصميم" }),
    ];
    const runner = async (prompt: string): Promise<number> => {
      if (prompt.includes("عند التصميم")) return 0.8; // INV higher
      return 0.4; // DOM lower
    };
    const result = await probe({ lessons, domain: "content-ar", runner });
    assert.equal(result.extraRollouts, 2);
    assert.equal(result.chosen, result.inv, "INV should be chosen when it scores higher");
    assert.equal(result.invScore, 0.8);
    assert.equal(result.domScore, 0.4);
  });

  it("keeps the base (empty chosen) on a tie", async () => {
    const lessons: Lesson[] = [baseLesson({})];
    const runner = async (_prompt: string): Promise<number> => 0.5; // both score same
    const result = await probe({ lessons, domain: "content-ar", runner });
    assert.equal(result.invScore, 0.5);
    assert.equal(result.domScore, 0.5);
    assert.equal(result.chosen, "", "on a tie the base (empty) block is kept");
    assert.equal(result.extraRollouts, 2);
  });

  it("respects maxExtraRollouts override", async () => {
    const lessons: Lesson[] = [baseLesson({})];
    let calls = 0;
    const runner = async (): Promise<number> => {
      calls++;
      return 0.5;
    };
    const result = await probe({ lessons, domain: "content-ar", runner, maxExtraRollouts: 1 });
    assert.equal(result.extraRollouts, 1);
    assert.equal(calls, 1);
    assert.equal(result.domScore, 0, "only one rollout ran");
  });

  it("never exceeds MAX_EXTRA_ROLLOUTS", async () => {
    const lessons: Lesson[] = [baseLesson({})];
    let calls = 0;
    const runner = async (): Promise<number> => {
      calls++;
      return 0.5;
    };
    await probe({ lessons, domain: "content-ar", runner });
    assert.equal(calls, MAX_EXTRA_ROLLOUTS);
  });

  it("does not mutate the input lessons array", async () => {
    const lessons: Lesson[] = [baseLesson({})];
    const before = JSON.stringify(lessons);
    const runner = async (): Promise<number> => 0.5;
    await probe({ lessons, domain: "content-ar", runner });
    assert.equal(JSON.stringify(lessons), before, "input lessons must be unchanged");
  });

  it("works with an empty lesson list", async () => {
    let calls = 0;
    const runner = async (): Promise<number> => {
      calls++;
      return 0.5;
    };
    const result = await probe({ lessons: [], domain: "content-ar", runner });
    assert.equal(result.inv, "");
    assert.equal(result.dom, "");
    assert.equal(result.chosen, "", "no lessons means base block on tie");
    assert.equal(result.extraRollouts, 2);
  });
});