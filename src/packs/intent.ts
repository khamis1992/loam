import { PACK_MANIFESTS } from "./registry.js";
import { presentationRequest } from "../agent/planner.js";
import type { PackId } from "./types.js";

export interface PackIntentInput {
  studioGoal?: unknown;
  outputType?: unknown;
  loamMode?: unknown;
  prompt?: unknown;
  localEdit?: boolean;
}

const GOAL_PACK: Readonly<Record<string, PackId>> = {
  slides: "loam-slides",
  video: "loam-video",
  websites: "loam-build",
  image: "loam-image",
  audio: "loam-audio",
  document: "loam-office",
  spreadsheet: "loam-office",
  visualization: "loam-office",
  research: "loam-research",
  schedule: "loam-schedule",
  "mobile-app": "loam-mobile",
  "game-development": "loam-game",
};

export function packIdForGoal(goal: unknown): PackId | undefined {
  return typeof goal === "string" ? GOAL_PACK[goal.trim()] : undefined;
}

export function packIdForOutputType(outputType: unknown): PackId | undefined {
  if (outputType === "slides") return "loam-slides";
  if (outputType === "video") return "loam-video";
  if (outputType === "website") return "loam-build";
  if (outputType === "image") return "loam-image";
  return undefined;
}

function packIdForModeAndPrompt(mode: unknown, prompt: unknown): PackId | undefined {
  const text = typeof prompt === "string" ? prompt : "";
  if (mode === "write" && (presentationRequest(text) || /عرض(?:ًا|اً)?\s*تقديمي|برزنتيشن|شرائح|slides?|pptx/i.test(text))) return "loam-slides";
  if (mode === "write" && /docx|document|مستند|تقرير/i.test(text)) return "loam-office";
  if (mode === "build" && /website|web page|landing|موقع|صفحة ويب/i.test(text)) return "loam-build";
  if (mode === "media" && /video|mp4|مونتاج|فيديو|مقطع/i.test(text)) return "loam-video";
  if (mode === "media" && /audio|music|tts|صوت|موسيقى|أغنية/i.test(text)) return "loam-audio";
  if (mode === "media" && /image|logo|صورة|صور|شعار|تصميم/i.test(text)) return "loam-image";
  if (mode === "data" && /xlsx|spreadsheet|جدول|ورقة عمل/i.test(text)) return "loam-office";
  return undefined;
}

export function resolvePackId(input: PackIntentInput & { packId?: unknown }): PackId | undefined {
  if (typeof input.packId === "string" && PACK_MANIFESTS[input.packId as PackId]) return input.packId as PackId;
  const fromGoal = packIdForGoal(input.studioGoal);
  if (fromGoal) return fromGoal;
  const fromOutput = packIdForOutputType(input.outputType);
  if (fromOutput) return fromOutput;
  const fromPrompt = packIdForModeAndPrompt(input.loamMode, input.prompt);
  if (fromPrompt) return fromPrompt;
  if (input.loamMode === "research") return "loam-research";
  if (input.loamMode === "automate") return "loam-schedule";
  if (input.localEdit === true) return "loam-localfile";
  return undefined;
}
