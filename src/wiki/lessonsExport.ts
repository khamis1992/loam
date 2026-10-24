import { listLessons } from "../learning/harness/experienceStore.js";
import type { Lesson } from "../learning/harness/types.js";
import { writePage } from "./store.js";

const oneLine = (s: string, max: number): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export function renderLessonPage(l: Lesson): string {
  return [
    `# ${oneLine(l.lesson, 100)}`,
    "",
    `- Domain: ${l.domain}`,
    `- Source: ${l.source}`,
    `- Confidence: ${l.confidence}`,
    `- Agent: ${l.agentId ?? "global"}`,
    "",
    "## When",
    "",
    l.cue,
    "",
    "## Do",
    "",
    l.lesson,
    "",
    "## Evidence",
    "",
    l.evidence,
    "",
  ].join("\n");
}

/**
 * One-way export of the Harness2 lesson store into `lesson` wiki pages. The wiki never
 * feeds back into the store. Page ids are the lesson ids, so a repeat run refreshes in place.
 */
export function exportLessons(root: string, lessons: Lesson[] = listLessons()): number {
  let n = 0;
  for (const l of lessons) {
    if (l.disabled) continue;
    const id = l.id.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 80);
    if (!id) continue;
    writePage(root, {
      kind: "lesson",
      id,
      title: oneLine(l.lesson, 120),
      body: renderLessonPage(l),
      tags: ["lesson", l.domain, l.confidence],
    });
    n++;
  }
  return n;
}
