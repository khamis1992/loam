/**
 * Tests for H5 inject.ts (BUILD_SPEC .h2-ref/BUILD_SPEC.md §11 row H5).
 * Acceptance: block <= 1200 chars; disabled flag -> empty; `uses` incremented;
 * the config knobs (maxChars / minScore) are honoured. LOAM_DATA_DIR is pointed
 * at a fresh temp dir BEFORE any store import so tests never touch real data.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const tmpDir = mkdtempSync(join(process.cwd(), "loam-test-"));
process.env.LOAM_DATA_DIR = tmpDir;

const { LESSON_BLOCK_MAX_CHARS, buildLessonBlock, lessonsForTask } = await import("../inject.js");
const { listLessons } = await import("../experienceStore.js");
const { putEntity, closeDb } = await import("../../../server/sqliteStore.js");
import type { Lesson } from "../types.js";

function makeLesson(overrides: Partial<Lesson>): Lesson {
  const base: Lesson = {
    id: "les_test",
    agentId: null,
    domain: "test",
    source: "correction",
    cue: "when writing Arabic",
    lesson: "use UTF-8 encoding",
    evidence: "user said so",
    confidence: "high",
    sourceRef: "cor_abc",
    uses: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  return { ...base, ...overrides };
}

describe("H5 inject", () => {
  before(() => {
    process.env.LOAM_DATA_DIR = tmpDir;
  });
  after(() => {
    // Close the sqlite handle first: on Windows the open WAL files lock the dir.
    closeDb();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* a leftover temp dir is harmless; never fail the suite on cleanup */
    }
  });

  describe("buildLessonBlock", () => {
    test("empty lessons -> empty string", () => {
      assert.equal(buildLessonBlock([]), "");
    });

    test("formats a single lesson", () => {
      const block = buildLessonBlock([makeLesson({ id: "les_1" })]);
      assert.ok(block.startsWith("## Learned from earlier corrections"));
      assert.ok(block.includes("- When when writing Arabic: use UTF-8 encoding"));
    });

    test("removes trailing period from cue", () => {
      const block = buildLessonBlock([makeLesson({ id: "les_2", cue: "check the code." })]);
      assert.ok(block.includes("- When check the code: use UTF-8 encoding"));
    });

    test("truncates at LESSON_BLOCK_MAX_CHARS", () => {
      const longLesson = makeLesson({
        id: "les_3",
        cue: "x".repeat(600),
        lesson: "y".repeat(600),
      });
      const block = buildLessonBlock([longLesson]);
      assert.ok(block.length <= LESSON_BLOCK_MAX_CHARS);
      assert.equal(block, "## Learned from earlier corrections (apply when the cue matches)");
    });

    test("LESSON_BLOCK_MAX_CHARS is 1200", () => {
      assert.equal(LESSON_BLOCK_MAX_CHARS, 1200);
    });

    test("respects the maxChars override (LOAM_LESSONS_MAX_CHARS knob)", () => {
      const l1 = makeLesson({ id: "les_a", cue: "c".repeat(20), lesson: "l".repeat(20) });
      const l2 = makeLesson({ id: "les_b", cue: "d".repeat(80), lesson: "m".repeat(80) });
      const full = buildLessonBlock([l1, l2]);
      const capped = buildLessonBlock([l1, l2], 200);
      assert.ok(full.length > 200, "precondition: the second lesson exceeds the 200-char cap");
      assert.ok(capped.length <= 200, "capped block must fit the override");
      assert.ok(capped.includes("cccc"), "the first lesson fits and stays");
      assert.ok(!capped.includes("dddd"), "the second lesson is dropped by the cap");
    });
  });

  describe("lessonsForTask", () => {
    test("enabled=false -> empty block and ids", () => {
      const { block, ids } = lessonsForTask({
        agentId: null, domain: "test", prompt: "test", enabled: false,
      });
      assert.equal(block, "");
      assert.deepEqual(ids, []);
    });

    test("no matching lessons -> empty block and ids", () => {
      const { block, ids } = lessonsForTask({
        agentId: null, domain: "no-domain", prompt: "test", enabled: true,
      });
      assert.equal(block, "");
      assert.deepEqual(ids, []);
    });

    test("ranks relevant lessons and increments their uses", () => {
      const l = makeLesson({
        id: "les_real",
        domain: "Arabic",
        cue: "when writing Arabic text",
        lesson: "use UTF-8 encoding",
      });
      putEntity("lessons", l);

      const { block, ids } = lessonsForTask({
        agentId: null, domain: "Arabic", prompt: "write Arabic text in UTF-8", enabled: true,
      });
      assert.ok(block.includes("Arabic"), "block should contain the Arabic lesson");
      assert.deepEqual(ids, ["les_real"]);

      const stored = listLessons({ domain: "Arabic" }).find((x) => x.id === "les_real");
      assert.ok(stored, "lesson still stored after injection");
      assert.equal(stored!.uses, 1, "uses must be incremented once per injection");
      assert.ok(stored!.lastUsedAt, "lastUsedAt is set by markUsed");
    });

    test("disabled lessons are never injected", () => {
      const l = makeLesson({
        id: "les_dis",
        domain: "Disable",
        cue: "when shipping releases",
        lesson: "run the smoke suite",
        disabled: true,
      });
      putEntity("lessons", l);

      const { block, ids } = lessonsForTask({
        agentId: null, domain: "Disable", prompt: "ship the release with the smoke suite", enabled: true,
      });
      assert.equal(block, "", "a disabled lesson must not reach the prompt");
      assert.deepEqual(ids, []);
    });

    test("honours the minScore override (LOAM_LESSON_MIN_SCORE knob)", () => {
      const l = makeLesson({
        id: "les_score",
        domain: "Score",
        cue: "deploy backend",
        lesson: "run migrations first",
      });
      putEntity("lessons", l);

      const loose = lessonsForTask({
        agentId: null, domain: "Score", prompt: "deploy the backend service now", enabled: true, minScore: 0,
      });
      assert.ok(loose.block.length > 0, "minScore 0 keeps the weak-overlap match");

      const strict = lessonsForTask({
        agentId: null, domain: "Score", prompt: "completely unrelated topic like gardening", enabled: true, minScore: 0.99,
      });
      assert.equal(strict.block, "", "minScore 0.99 drops the lesson");
    });

    test("honours the maxChars override and never counts a dropped lesson as used", () => {
      const l = makeLesson({
        id: "les_cap",
        domain: "Cap",
        cue: "c".repeat(300),
        lesson: "l".repeat(300),
      });
      putEntity("lessons", l);

      const { block, ids } = lessonsForTask({
        agentId: null, domain: "Cap", prompt: "c".repeat(50), enabled: true, maxChars: 100,
      });
      assert.ok(block.length <= 100, "block must fit the maxChars override");
      assert.deepEqual(ids, [], "a lesson dropped by the char cap is not counted as used");
    });

    test("never throws on error", () => {
      const result = lessonsForTask({
        agentId: null, domain: "test", prompt: "", enabled: true,
      });
      assert.equal(typeof result.block, "string");
      assert.ok(Array.isArray(result.ids));
    });
  });
});
