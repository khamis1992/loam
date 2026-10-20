/** Fast offline mode detector for protocol messages.
 *
 *  Does not call any model; uses keyword heuristics only. */

import type { UserMessage } from "../protocol/types.js";
import { normalizeModeId, getLoamMode, LOAM_MODES } from "./catalog.js";

// Ordered keyword rules. First match wins.
const DETECTION_RULES: Array<[string, RegExp]> = [
  ["media", /ffmpeg|video|trim|mp4|image|logo|svg|design|poster/i],
  ["write", /pptx|powerpoint|slides|presentation|docx|word|document|memo/i],
  ["data", /xlsx|excel|spreadsheet|chart|csv|dataset/i],
  ["security", /pentest|vulnerab|security|tls|headers\s+scan/i],
  ["research", /open\s+a\s+website|browse|scrape|navigate|url|http:\/\//i],
  ["research", /search|research|find\s+info|look\s+up/i],
  ["build", /build|app|website|code|program/i],
];

export function detectModeFromText(text: string): string {
  const t = text.toLowerCase();
  for (const [mode, pattern] of DETECTION_RULES) {
    if (pattern.test(t)) return mode;
  }
  return "build";
}

export function resolveLoamMode(um: UserMessage, prompt: string): string {
  // (a) Explicit Loam mode from client extData takes precedence if valid.
  const explicit = (um.extData.loamMode ?? "").trim();
  if (explicit) {
    const normalized = normalizeModeId(explicit);
    if (LOAM_MODES.some((m) => m.id === normalized)) return normalized;
  }

  // (b) Fast offline keyword detection from the user prompt.
  const detected = detectModeFromText(prompt);
  if (detected !== "build") return detected;

  // Preserve legacy lite/discuss mapping to ask; everything else defaults to build.
  const taskMode = (um.extData.mode ?? um.taskMode ?? "").trim().toLowerCase();
  if (taskMode === "lite" || taskMode === "discuss") return "ask";
  return "build";
}

export function modeEventInfo(mode: string): { mode: string; label: string; labelAr: string; reason: string } {
  const m = getLoamMode(mode);
  return {
    mode: m.id,
    label: m.label,
    labelAr: m.labelAr,
    reason: `Selected ${m.label} mode for this task`,
  };
}
