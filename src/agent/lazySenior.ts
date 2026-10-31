/**
 * lazy-senior (Ponytail BUILD_SPEC P2): the levelled coding discipline.
 *
 * The active level comes from the session override (`/lazy` chat command)
 * first, then the durable `codingDiscipline` setting, and defaults to
 * `full`. The block is injected into the system prompt only for build-mode
 * toolsets — `off` injects nothing, so the off prompt stays byte-identical
 * to the baseline (P2 exit criterion).
 */
import { getSettings } from "../server/settings.js";

export type LazySeniorLevel = "off" | "lite" | "full" | "ultra";

const LEVELS: readonly LazySeniorLevel[] = ["off", "lite", "full", "ultra"];

/** Session overrides set by `/lazy` chat command; keyed by the task/session id. */
const sessionLevels = new Map<string, LazySeniorLevel>();

export function normalizeLazySeniorLevel(raw: unknown): LazySeniorLevel | null {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return (LEVELS as readonly string[]).includes(value) ? (value as LazySeniorLevel) : null;
}

/** Matches the chat command that starts with a slash, then a level word.
 *  Anything else returns null and the prompt runs as a normal request. */
export function parseLazyCommand(text: string): LazySeniorLevel | null {
  return normalizeLazySeniorLevel(/^\/lazy\s+(\S+)\s*$/i.exec(text.trim())?.[1]);
}

export function setSessionLevel(sessionId: string, level: LazySeniorLevel): void {
  sessionLevels.set(sessionId, level);
}

export function clearSessionLevel(sessionId: string): void {
  sessionLevels.delete(sessionId);
}

/** Session override wins; otherwise the durable setting; missing is `full`. */
export function resolveLazySeniorLevel(sessionId?: string): LazySeniorLevel {
  const override = sessionId ? sessionLevels.get(sessionId) : undefined;
  if (override) return override;
  return getSettings().codingDiscipline ?? "full";
}

/**
 * Build-mode toolset signature (Ponytail §3.2: only modes with WRITE tools —
 * build and App Builder): a write tool plus a tool only build exposes.
 * Research/Write/Data/Media have write tools but no build marker; Dev Flow
 * has the writes but no build marker either; Security/Red Team have shell
 * but no file-write pair.
 */
export function isBuildToolset(toolNames: readonly string[]): boolean {
  const hasWrite = toolNames.includes("file_write") || toolNames.includes("file_edit");
  const buildMarker = toolNames.some((name) => name === "code_session" || name === "app_task_create" || name === "preview_serve");
  return hasWrite && buildMarker;
}

const LEVEL_LINE: Record<Exclude<LazySeniorLevel, "off">, string> = {
  lite: "- lite: build exactly what was asked, and name the smaller option in one line.",
  full: "- full: take the first ladder rung that fully solves the request — need, existing code, standard library, installed dependency, one line, minimum diff — and never climb higher.",
  ultra: "- ultra: before building, question any part of the request the stated need does not justify; push back once with the cheaper plan, then build what was confirmed.",
};

/** One-line reply text for the level chat command; bilingual like the UI copy. */
export function lazyLevelAnnouncement(level: LazySeniorLevel): string {
  const label = { off: "off / إيقاف", lite: "lite / مختصر", full: "full / كامل", ultra: "ultra / أقصى" }[level];
  if (level === "off") {
    return `تم إيقاف انضباط lazy-senior لهذه الجلسة (${label}). Coding discipline is off for this session; future build tasks run without the ladder block.`;
  }
  return `مستوى انضباط lazy-senior لهذه الجلسة: ${label}. Applied to this session's future build tasks; the durable setting is unchanged.`;
}

/** The injected prompt block, or null when nothing should be added. */
export function lazySeniorBlock(level: LazySeniorLevel, toolNames: readonly string[]): string | null {
  if (level === "off" || !isBuildToolset(toolNames)) return null;
  return [
    "### 8.0 Decision order (lazy-senior, level: " + level + ")",
    "When writing code, apply the active lazy-senior level before §8.1. The level narrows how a change is chosen; it never weakens §8.1–§8.5.",
    LEVEL_LINE[level],
    "- Be lazy about the solution, never about the change: every caller of a changed symbol is updated, non-trivial logic ships with one test, and the reply ends with one line: `Skipped: <what was left out>. Risk: <what that costs, and when to upgrade>.` A known limit is stated as `shortcut: <limit>, <when to upgrade>`.",
    "- Never cut, at any level: input validation, error handling around data loss, security checks, accessibility.",
  ].join("\n");
}
