/**
 * H5 — lesson injection: build the prompt block from relevant lessons and append
 * it to the system prompt at task start.
 *
 * Reference: .h2-ref/BUILD_SPEC.md §6.5. Re-implemented independently from the
 * Harness2 idea (no upstream code is copied).
 *
 * The block is capped at maxChars (default 1200; LOAM_LESSONS_MAX_CHARS in
 * src/config.ts) and the whole call is wrapped so a failure in ranking never
 * blocks a task — the caller always gets a { block, ids } pair, with block = ""
 * on any error. Disabled lessons are never injected (listLessons hides them),
 * the relevance floor is minScore (LOAM_LESSON_MIN_SCORE), and every lesson that
 * ends up in the block gets its `uses` counter incremented via markUsed.
 */
import type { Lesson } from "./types.js";
import { listLessons, markUsed, rankLessons } from "./experienceStore.js";

export const LESSON_BLOCK_MAX_CHARS = 1200;

export function buildLessonBlock(lessons: Lesson[], maxChars: number = LESSON_BLOCK_MAX_CHARS): string {
  if (!lessons.length) return "";
  const cap = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : LESSON_BLOCK_MAX_CHARS;
  const lines = ["## Learned from earlier corrections (apply when the cue matches)"];
  for (const l of lessons) {
    const line = `- When ${l.cue.replace(/\.$/, "")}: ${l.lesson}`;
    if (lines.join("\n").length + line.length > cap) break;
    lines.push(line);
  }
  return lines.join("\n");
}

/** Called once per task start. Returns the block to append to the system prompt
 *  and the ids used. Never throws — a failure yields an empty block. */
export function lessonsForTask(o: {
  agentId: string | null;
  domain: string;
  prompt: string;
  vector?: Float32Array;
  enabled: boolean;
  /** Block cap in chars; defaults to LESSON_BLOCK_MAX_CHARS (cfg.lessons.maxChars). */
  maxChars?: number;
  /** Relevance floor; defaults to rankLessons' 0.35 (cfg.lessons.minScore). */
  minScore?: number;
}): { block: string; ids: string[] } {
  try {
    if (!o.enabled) return { block: "", ids: [] };
    const top = rankLessons(
      listLessons({ agentId: o.agentId, domain: o.domain }),
      { text: o.prompt, vector: o.vector },
      5,
      o.minScore,
    );
    const block = buildLessonBlock(top, o.maxChars);
    const ids = top.slice(0, block.split("\n").length - 1).map((l) => l.id);
    if (ids.length) markUsed(ids);
    return { block, ids };
  } catch {
    return { block: "", ids: [] };
  }
}
