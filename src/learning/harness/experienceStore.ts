/**
 * H2 — experience store: persist and retrieve lessons and correction events.
 * Reference: .h2-ref/BUILD_SPEC.md section 6.2. Re-implemented independently from
 * the Harness2 idea (no upstream code is copied).
 *
 * Adaptations forced by the real code (docs/re/harness2-H0.md):
 *  - [U1] `OllamaEmbedder.embed(texts)` is the BATCH method; a single text uses
 *    `embedOne(text)` (src/memory/embeddings.ts:48). The spec's `embed(string)`
 *    does not exist, so `embedOne` is used and failures are swallowed (the vector
 *    is optional; `rankLessons` has a lexical fallback).
 *  - [U7] the secret guard is the existing `assertNoSecret` (src/memory/redact.ts:38),
 *    which is a strict superset of the spec's regex. `addLesson` rejects (returns
 *    null) instead of letting the throw escape into a background hook.
 *  - the existing audit sink `appendLearning` (src/server/learning.ts:29) is
 *    appended with the section 8 `lesson_added` shape.
 *  - `deleteLesson`/`setLessonDisabled`/`markUsed` return `null` when the row is
 *    gone, so "delete -> 404 on next get" is expressible without throwing.
 */
import {
  allEntities,
  getEntity,
  putEntity,
  removeEntity,
} from "../../server/sqliteStore.js";
import { normalize, toBase64, fromBase64, dot, type OllamaEmbedder } from "../../memory/embeddings.js";
import { appendLearning } from "../../server/learning.js";
import { assertNoSecret } from "../../memory/redact.js";
import {
  type CorrectionEvent,
  type DistillResult,
  type Lesson,
  type LessonSource,
  isCompleteLesson,
} from "./types.js";

const L = "lessons";
const C = "corrections";

const id = (p: string) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const MAX_LESSONS_PER_DOMAIN = 50;

/** Keep the most recent 4000 characters of a transcript slice. */
function clip(text: string): string {
  return text.slice(0, 4000);
}

export function recordCorrection(e: Omit<CorrectionEvent, "id" | "at">): CorrectionEvent {
  const ev: CorrectionEvent = {
    ...e,
    id: id("cor"),
    at: new Date().toISOString(),
    priorAssistant: clip(e.priorAssistant),
    userText: clip(e.userText),
  };
  putEntity(C, ev);
  return ev;
}

export async function addLesson(args: {
  agentId: string | null;
  domain: string;
  source: LessonSource;
  sourceRef: string;
  d: DistillResult;
  embedder?: OllamaEmbedder;
}): Promise<Lesson | null> {
  if (!isCompleteLesson(args.d)) return null;
  // Secret hygiene (BUILD_SPEC section 10): reject, never store or leak.
  try {
    assertNoSecret(args.d.cue);
    assertNoSecret(args.d.lesson);
    assertNoSecret(args.d.evidence);
  } catch {
    return null;
  }
  const cue = args.d.cue.trim();
  const lesson = args.d.lesson.trim();
  const evidence = args.d.evidence.trim();

  const existing = listLessons({ agentId: args.agentId, domain: args.domain });
  const dup = existing.find((l) => l.lesson.toLowerCase() === lesson.toLowerCase());
  if (dup) return dup;

  const les: Lesson = {
    id: id("les"),
    agentId: args.agentId,
    domain: args.domain,
    source: args.source,
    sourceRef: args.sourceRef,
    cue,
    lesson,
    evidence,
    confidence: args.d.confidence,
    uses: 0,
    createdAt: new Date().toISOString(),
  };

  if (args.embedder) {
    try {
      const v = normalize(await args.embedder.embedOne(`${cue}\n${lesson}`));
      les.dim = v.length;
      les.vector = toBase64(v);
    } catch {
      /* embedding optional; lexical fallback in rankLessons */
    }
  }

  putEntity(L, les);
  pruneDomain(args.agentId, args.domain);
  appendLearning({
    at: les.createdAt,
    kind: "lesson_added",
    lessonId: les.id,
    source: les.source,
    domain: les.domain,
  });
  return les;
}

export function listLessons(
  f: { agentId?: string | null; domain?: string; includeDisabled?: boolean } = {},
): Lesson[] {
  return allEntities<Lesson>(L)
    .filter((l) => f.agentId === undefined || l.agentId === f.agentId || l.agentId === null)
    .filter((l) => f.domain === undefined || l.domain === f.domain)
    .filter((l) => f.includeDisabled || !l.disabled)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function listCorrections(f: { taskId?: string; domain?: string } = {}): CorrectionEvent[] {
  return allEntities<CorrectionEvent>(C)
    .filter((e) => f.taskId === undefined || e.taskId === f.taskId)
    .filter((e) => f.domain === undefined || e.domain === f.domain)
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** Returns false when the row is already gone (the REST layer maps that to 404). */
export function deleteLesson(lessonId: string): boolean {
  return removeEntity(L, lessonId);
}

export function setLessonDisabled(lessonId: string, disabled: boolean): Lesson | null {
  const l = getEntity<Lesson>(L, lessonId);
  if (!l) return null;
  l.disabled = disabled;
  putEntity(L, l);
  return l;
}

export function markUsed(ids: string[]): void {
  const now = new Date().toISOString();
  for (const i of ids) {
    const l = getEntity<Lesson>(L, i);
    if (l) {
      l.uses++;
      l.lastUsedAt = now;
      putEntity(L, l);
    }
  }
}

/** Keep the newest MAX_LESSONS_PER_DOMAIN per (agent, domain); drop low-confidence,
 *  never-used entries first. */
function pruneDomain(agentId: string | null, domain: string): void {
  const all = allEntities<Lesson>(L).filter((l) => l.agentId === agentId && l.domain === domain);
  if (all.length <= MAX_LESSONS_PER_DOMAIN) return;
  const rank = (l: Lesson) => ({ low: 0, medium: 1, high: 2 })[l.confidence] * 10 + Math.min(l.uses, 9);
  all.sort((a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt));
  for (const l of all.slice(0, all.length - MAX_LESSONS_PER_DOMAIN)) removeEntity(L, l.id);
}

const TOKENS = /[^\p{L}\p{N}]+/u;

/** Score = cosine (when both vectors exist) else token overlap. Returns the top-k
 *  with score >= minScore. */
export function rankLessons(
  candidates: Lesson[],
  query: { text: string; vector?: Float32Array },
  k = 5,
  minScore = 0.35,
): Lesson[] {
  const toks = new Set(
    query.text
      .toLowerCase()
      .split(TOKENS)
      .filter((t) => t.length > 2),
  );
  const scored = candidates.map((l) => {
    let s = 0;
    if (query.vector && l.vector && l.dim === query.vector.length) {
      s = dot(query.vector, fromBase64(l.vector, l.dim));
    } else {
      const lt = `${l.cue} ${l.lesson}`
        .toLowerCase()
        .split(TOKENS)
        .filter((t) => t.length > 2);
      const hit = lt.filter((t) => toks.has(t)).length;
      s = lt.length ? hit / Math.sqrt(lt.length * Math.max(toks.size, 1)) : 0;
    }
    return { l, s };
  });
  return scored
    .filter((x) => x.s >= minScore)
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map((x) => x.l);
}
