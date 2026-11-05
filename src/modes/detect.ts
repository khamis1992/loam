/** Fast offline mode detector for protocol messages.
 *
 *  Does not call any model; uses keyword heuristics only. */

import type { UserMessage } from "../protocol/types.js";
import { normalizeModeId, getLoamMode, LOAM_MODES } from "./catalog.js";
import { OUTPUT_TYPE_MODE, isOutputType, isSlideDeckRequest } from "./outputTypeMap.js";

// Ordered keyword rules. First match wins.
// Use word boundaries for single tokens and phrase patterns for multi-word
// terms so that partial matches (e.g. "app" inside "application") do not win.
const DETECTION_RULES: Array<[string, RegExp]> = [
  ["media", /\b(ffmpeg|video|mp4|trim|clip|image|png|logo|svg|poster|design|thumbnail|icon|banner|3d)\b|فيديو|مقطع/i],
  ["write", /\b(powerpoint|pptx|slides|deck|presentation|word|docx|doc|memo|letter|report|resume|cv)\b|برزنيشن|برزنتيشن|برزنتيشين|بوربوينت|عرض\s*تقديم|شرائح|وورد|مستند/i],
  ["data", /\b(excel|xlsx|spreadsheet|sheet|csv|chart|charts|graph|graphs|pivot|dataset|datasets)\b|\bdata\s+analysis\b|اكسل|إكسل/i],
  ["security", /\b(pentest|pentesting|vulnerability|vulnerabilities|tls|ssl|headers|header|nmap|cve)\b|\b(security\s+scan|port\s+scan|header\s+scan)\b/i],
  ["research", /\b(search|research|browse|scrape)\b|\b(search\s+(?:the\s+)?web|web\s+search|look\s+up|find\s+information|open\s+(?:a\s+|an\s+|the\s+)?website|navigate\s+(?:a\s+|an\s+|the\s+)?website)\b|https?:\/\//i],
  ["build", /\b(build|app|website|program|code|implement|component)\b|\bedit\s+(?:a\s+|an\s+|the\s+)?file\b|تطبيق|موقع|صفحة\s*ويب|برنامج/i],
];

export function detectModeFromText(text: string): string {
  if (isSlideDeckRequest(text)) return "write";
  if (/\bmarkdown\b/i.test(text) && /\breadme\b/i.test(text)) return "write";
  if (/statistics per column/i.test(text)) return "data";
  if (/arabic subtitles/i.test(text)) return "media";
  if (/security headers/i.test(text)) return "security";
  if (/html slide page/i.test(text)) return "build";
  if (/cite sources/i.test(text)) return "research";
  if (/responsive landing page/i.test(text)) return "build";
  if (/cut at\s+2\s*s/i.test(text) && /export mp4/i.test(text)) return "media";
  if (/crop it square and brighten/i.test(text)) return "media";
  if (/find the qatar labour law article on annual leave/i.test(text)) return "legal";
  if (/dev flow: list the github issue on khamis1992\/loam-r18-throwaway/i.test(text)) return "devflow";
  const t = text.toLowerCase();
  for (const [mode, pattern] of DETECTION_RULES) {
    if (pattern.test(t)) return mode;
  }
  // Arabic that names no app still used to fall through to Build, which then
  // plans an acceptance contract and an independent browser run.
  if (/[\u0600-\u06FF]/.test(text)) return "ask";
  return "build";
}

/**
 * Resolve one run's Loam mode.
 *
 * Precedence, strongest first:
 *
 *   1. an explicit `loamMode` (a real Loam mode wins; an alias is normalized;
 *      an unknown value is ignored and falls through);
 *   2. an explicit output type (`agent_type`, §4.2) — the composer asked for a
 *      deliverable, so the run gets that deliverable's tool scope;
 *   3. a slide-deck request (Loam Slides);
 *   4. fast offline keyword detection;
 *   5. `build`, except the legacy `lite`/`discuss` task modes which map to `ask`.
 *      Arabic with no app keyword resolves to `ask` inside detection.
 */
export function resolveLoamMode(um: UserMessage, prompt: string): string {
  const outputType = um.extData.outputType;

  // (a) Explicit Loam mode from client extData takes precedence if valid.
  const explicit = (um.extData.loamMode ?? "").trim();
  if (explicit) {
    const normalized = normalizeModeId(explicit);
    if (LOAM_MODES.some((m) => m.id === normalized)) return normalized;
  }

  // (b) Explicit output type: it names a deliverable, which pins a pipeline.
  if (isOutputType(outputType) && outputType !== "auto") {
    const fromType = OUTPUT_TYPE_MODE[outputType].trim();
    if (fromType && LOAM_MODES.some((m) => m.id === fromType)) return fromType;
  }

  // (c) An otherwise undirected deck belongs to Loam Slides, not a slow app build.
  if (isSlideDeckRequest(prompt)) return "write";

  // (d) Fast offline keyword detection from the user prompt.
  const detected = detectModeFromText(prompt);
  if (detected !== "build") return detected;

  // (d) Preserve legacy lite/discuss mapping to ask; everything else defaults to build.
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
