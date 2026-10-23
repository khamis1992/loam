/**
 * H2 tests for src/learning/harness/experienceStore.ts (BUILD_SPEC 6.2).
 * node:test; no model API is called (the embedder is a deterministic fake).
 *
 * The data dir must be a temp dir set BEFORE sqliteStore is imported: the store
 * caches the node:sqlite connection in a module-level variable (sqliteStore.ts:10),
 * so a late import would reuse whatever connection an earlier test opened.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { OllamaEmbedder } from "../../../memory/embeddings.js";
import type { DistillResult, LessonSource } from "../types.js";

let tmpDir = "";
let closeDb: () => void;
let store: typeof import("../experienceStore.js");
let audit: typeof import("../../../server/learning.js");

/** Deterministic bag-of-words embedder: near-identical text -> high cosine. */
class FakeEmbedder {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(vectorFor);
  }
  async embedOne(text: string): Promise<number[]> {
    return vectorFor(text);
  }
}

function vectorFor(text: string): number[] {
  const v = new Array<number>(32).fill(0);
  for (const ch of text.toLowerCase()) {
    const i = ch.charCodeAt(0) % 32;
    v[i] = (v[i] ?? 0) + 1;
  }
  return v;
}

const fakeEmbedder = new FakeEmbedder() as unknown as OllamaEmbedder;

function lesson(n: number, overrides: Partial<DistillResult> = {}): DistillResult {
  return {
    cue: `when the user asks about topic ${n}`,
    lesson: `always answer topic ${n} with the verified source.`,
    evidence: `the episode for topic ${n} showed the agent guessed.`,
    confidence: "medium",
    ...overrides,
  };
}

const SOURCES: LessonSource[] = ["correction", "critic", "selfplay"];

describe("experienceStore", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-experience-"));
    process.env.LOAM_DATA_DIR = tmpDir;
    const sqlite = await import("../../../server/sqliteStore.js");
    closeDb = sqlite.closeDb;
    audit = await import("../../../server/learning.js");
    store = await import("../experienceStore.js");
  });

  after(() => {
    try { closeDb(); } catch { /* already closed */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("add -> list returns exactly that lesson", async () => {
    const les = await store.addLesson({
      agentId: null,
      domain: "docs",
      source: "correction",
      sourceRef: "cor_seed",
      d: lesson(1),
    });
    assert.ok(les, "a complete lesson is stored");
    const all = store.listLessons({ domain: "docs" });
    assert.equal(all.length, 1);
    assert.equal(all[0]?.id, les?.id);
    assert.equal(all[0]?.lesson, lesson(1).lesson);
    assert.equal(all[0]?.uses, 0);
    assert.equal(all[0]?.disabled, undefined);
  });

  it("writes the section 8 lesson_added audit line", async () => {
    const entries = audit.readLearning(50) as Array<Record<string, unknown>>;
    const hit = entries.find((e) => e.kind === "lesson_added");
    assert.ok(hit, "the audit sink received a lesson_added line");
    assert.equal(typeof hit?.lessonId, "string");
    assert.equal(hit?.domain, "docs");
    assert.ok(SOURCES.includes(hit?.source as LessonSource));
  });

  it("stores a normalized base64 vector when an embedder is given", async () => {
    const les = await store.addLesson({
      agentId: null,
      domain: "vectors",
      source: "critic",
      sourceRef: "task-v",
      d: lesson(7),
      embedder: fakeEmbedder,
    });
    assert.ok(les?.vector && typeof les.dim === "number" && les.dim === 32);
    const stored = store.listLessons({ domain: "vectors" });
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.dim, 32);
  });

  it("keeps the lesson when embedding fails (lexical fallback)", async () => {
    const failing = {
      async embedOne(): Promise<number[]> {
        throw new Error("no model");
      },
    } as unknown as OllamaEmbedder;
    const les = await store.addLesson({
      agentId: null,
      domain: "noembed",
      source: "selfplay",
      sourceRef: "task-n",
      d: lesson(8),
      embedder: failing,
    });
    assert.ok(les, "the lesson is stored even without a vector");
    assert.equal(les?.vector, undefined);
    assert.equal(les?.dim, undefined);
  });

  it("does not re-add a duplicate lesson", async () => {
    const first = await store.addLesson({
      agentId: null,
      domain: "dedupe",
      source: "correction",
      sourceRef: "cor_a",
      d: lesson(2),
    });
    const second = await store.addLesson({
      agentId: null,
      domain: "dedupe",
      source: "correction",
      sourceRef: "cor_b",
      d: lesson(2, { evidence: "a different episode, same rule" }),
    });
    assert.equal(second?.id, first?.id, "the duplicate returns the stored lesson");
    assert.equal(store.listLessons({ domain: "dedupe" }).length, 1);
  });

  it("rejects an incomplete lesson (missing evidence)", async () => {
    const les = await store.addLesson({
      agentId: null,
      domain: "incomplete",
      source: "critic",
      sourceRef: "task-i",
      d: lesson(3, { evidence: "  " }),
    });
    assert.equal(les, null);
    assert.equal(store.listLessons({ domain: "incomplete" }).length, 0);
  });

  it("rejects a lesson that looks like it contains a secret", async () => {
    const secret = `use the key sk-${"a".repeat(24)} for the api`;
    const les = await store.addLesson({
      agentId: null,
      domain: "secrets",
      source: "correction",
      sourceRef: "cor_s",
      d: lesson(4, { lesson: secret }),
    });
    assert.equal(les, null, "nothing is stored");
    assert.equal(store.listLessons({ domain: "secrets", includeDisabled: true }).length, 0);
  });

  it("prunes a domain to MAX_LESSONS_PER_DOMAIN, dropping low-confidence first", async () => {
    for (let i = 0; i < store.MAX_LESSONS_PER_DOMAIN + 1; i++) {
      await store.addLesson({
        agentId: null,
        domain: "prune",
        source: "correction",
        sourceRef: `cor_${i}`,
        d: lesson(i, { confidence: i < 3 ? "high" : "low" }),
      });
    }
    const all = store.listLessons({ domain: "prune" });
    assert.equal(all.length, store.MAX_LESSONS_PER_DOMAIN);
    // The three high-confidence lessons survive the prune.
    assert.equal(all.filter((l) => l.confidence === "high").length, 3);
  });

  it("scopes lessons by agent and always includes global (agentId null) lessons", async () => {
    await store.addLesson({
      agentId: "agent-1",
      domain: "agents",
      source: "critic",
      sourceRef: "task-a1",
      d: lesson(11),
    });
    assert.equal(store.listLessons({ agentId: "agent-1", domain: "agents" }).length, 1);
    assert.equal(store.listLessons({ agentId: "agent-2", domain: "agents" }).length, 0);
    await store.addLesson({
      agentId: null,
      domain: "agents",
      source: "selfplay",
      sourceRef: "task-g",
      d: lesson(12),
    });
    assert.equal(store.listLessons({ agentId: "agent-2", domain: "agents" }).length, 1);
    assert.equal(store.listLessons({ domain: "agents" }).length, 2);
  });

  it("delete -> the lesson is gone and the next get returns 404", async () => {
    const les = await store.addLesson({
      agentId: null,
      domain: "delete",
      source: "correction",
      sourceRef: "cor_d",
      d: lesson(5),
    });
    assert.ok(les);
    assert.equal(store.deleteLesson(les!.id), true);
    assert.equal(store.listLessons({ domain: "delete" }).length, 0);
    // The REST layer maps a second delete to 404 (nothing left to remove).
    assert.equal(store.deleteLesson(les!.id), false);
  });

  it("disabled lessons are hidden from listLessons unless includeDisabled", async () => {
    const les = await store.addLesson({
      agentId: null,
      domain: "disabled",
      source: "correction",
      sourceRef: "cor_x",
      d: lesson(6),
    });
    assert.ok(les);
    const off = store.setLessonDisabled(les!.id, true);
    assert.equal(off?.disabled, true);
    assert.equal(store.listLessons({ domain: "disabled" }).length, 0);
    assert.equal(store.listLessons({ domain: "disabled", includeDisabled: true }).length, 1);
    const on = store.setLessonDisabled(les!.id, false);
    assert.equal(on?.disabled, false);
    assert.equal(store.listLessons({ domain: "disabled" }).length, 1);
    assert.equal(store.setLessonDisabled("les_missing", true), null, "a missing row is a 404");
  });

  it("markUsed increments uses and stamps lastUsedAt", async () => {
    const les = await store.addLesson({
      agentId: null,
      domain: "uses",
      source: "correction",
      sourceRef: "cor_u",
      d: lesson(9),
    });
    assert.ok(les);
    store.markUsed([les!.id, les!.id, "les_missing"]);
    const after = store.listLessons({ domain: "uses" })[0];
    assert.equal(after?.uses, 2);
    assert.equal(typeof after?.lastUsedAt, "string");
  });

  it("records a correction event, clipped to 4000 chars", () => {
    const ev = store.recordCorrection({
      agentId: null,
      taskId: "task-1",
      domain: "docs",
      priorAssistant: "a".repeat(5000),
      userText: "لا، قلت لك اكتب الاسم بالعربي",
    });
    assert.ok(ev.id.startsWith("cor_"));
    assert.equal(ev.priorAssistant.length, 4000);
    assert.equal(ev.userText.includes("بالعربي"), true);
    assert.equal(store.listCorrections({ taskId: "task-1" }).length, 1);
  });

  it("ranks by token overlap when no vector is available", async () => {
    await store.addLesson({
      agentId: null,
      domain: "rank",
      source: "correction",
      sourceRef: "cor_r1",
      d: { cue: "when generating arabic marketing copy", lesson: "write the brand name in arabic", evidence: "the user corrected the transliteration", confidence: "high" },
    });
    await store.addLesson({
      agentId: null,
      domain: "rank",
      source: "correction",
      sourceRef: "cor_r2",
      d: { cue: "when debugging node sqlite errors", lesson: "read the prepared statement error first", evidence: "the trace showed a syntax error", confidence: "high" },
    });
    const top = store.rankLessons(store.listLessons({ domain: "rank" }), { text: "arabic marketing copy for the brand" });
    assert.equal(top.length, 1);
    assert.equal(top[0]?.sourceRef, "cor_r1");
  });

  it("ranks by cosine when a matching vector is supplied", async () => {
    await store.addLesson({
      agentId: null,
      domain: "rankvec",
      source: "critic",
      sourceRef: "task-rv",
      d: { cue: "arabic content generation", lesson: "use the arabic brand name", evidence: "the episode was about arabic copy", confidence: "high" },
      embedder: fakeEmbedder,
    });
    const candidates = store.listLessons({ domain: "rankvec" });
    const top = store.rankLessons(candidates, { text: "unrelated words", vector: Float32Array.from(vectorFor("arabic content brand name copy")) });
    assert.equal(top.length, 1);
    assert.equal(top[0]?.sourceRef, "task-rv");
  });
});
