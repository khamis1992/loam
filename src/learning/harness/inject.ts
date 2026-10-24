import { type Lesson } from "./types.js";
import { listLessons, rankLessons, markUsed } from "./experienceStore.js";

export const LESSON_BLOCK_MAX_CHARS = 1200;

export function buildLessonBlock(lessons: Lesson[]): string {
  if (!lessons.length) return "";
  const lines = ["## Learned from earlier corrections (apply when the cue matches)"];
  for (const l of lessons) {
    const line = `- When ${l.cue.replace(/\.$/, "")}: ${l.lesson}`;
    if (lines.join("\n").length + line.length > LESSON_BLOCK_MAX_CHARS) break;
    lines.push(line);
  }
  return lines.join("\n");
}

/** Called once per task start. Returns the block to append to the system prompt and the ids used. */
export function lessonsForTask(o: { agentId: string | null; domain: string; prompt: string; vector?: Float32Array; enabled: boolean }):
  { block: string; ids: string[] } {
  if (!o.enabled) return { block: "", ids: [] };
  const top = rankLessons(listLessons({ agentId: o.agentId, domain: o.domain }), { text: o.prompt, vector: o.vector });
  const block = buildLessonBlock(top);
  const ids = top.slice(0, block.split("\n").length - 1).map((l) => l.id);
  if (ids.length) markUsed(ids);
  return { block, ids };
}

/** Helper to append the lesson block to a system prompt safely. */
export function appendLessonBlock(systemPrompt: string, block: string): string {
  if (!block) return systemPrompt;
  return systemPrompt + "\n\n" + block;
}