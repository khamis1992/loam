import crypto from "node:crypto";
import { stripSecrets } from "./redact.js";

/** Capture pipeline for session-end memory candidates (ideas from agentmemory: 5-min SHA dedup, <private> strip).
 *  Loam differences: secrets are STRIPPED here (capture is automatic) while explicit memory_store keeps assertNoSecret
 *  rejection; instruction-like text is rejected so a prompt-injected run cannot persist commands into memory. */
export interface CaptureCandidate { text: string; kind?: string; tags?: string[]; sessionId?: string; source: "agent" | "user"; }
export type CaptureOutcome = { ok: true; text: string; kind: string; hash: string } | { ok: false; reason: "duplicate" | "empty" | "instruction_like" | "too_long" };

export const DEDUP_WINDOW_MS = 5 * 60_000;
const recent = new Map<string, number>();
const MAX_CHARS = 2000;

const INSTRUCTION_LIKE = [
  /\b(ignore|disregard)\s+(all\s+)?(previous|prior|above)\s+(instructions|rules)\b/i,
  /\b(always|never|from\s+now\s+on)\b[^.\n]{0,80}\b(run|execute|send|upload|install|disable|delete)\b/i,
  /(تجاهل\s+(جميع|كل)?\s*التعليمات|من\s+الآن\s+فصاعداً?\s+(نفّ?ذ|أرسل|احذف))/u,
  /<\|im_start\|>|\[INST\]|<<SYS>>/,
];

export function stripPrivate(text: string): string {
  return text.replace(/<private>[\s\S]*?<\/private>/gi, "[private]").replace(/<private>[\s\S]*$/i, "[private]");
}

/** Heuristic kind when the agent did not give one; salience follows the kind (hybrid.ts SALIENCE). */
export function classifyKind(text: string): string {
  const t = text.toLowerCase();
  // Latin words use \b; Arabic has no \w characters in JS regex, so Arabic stems are matched without \b.
  const has = (latin: RegExp, arabic: RegExp) => latin.test(t) || arabic.test(t);
  if (has(/\b(prefer|prefers|likes|wants)\b/, /(يفضّ?ل|يحب|يريد|تفضيل)/u)) return "preference";
  if (has(/\b(architecture|module|schema|database|ipc|electron)\b/, /(بنية|معمارية|قاعدة\s+البيانات|وحدة)/u)) return "architecture";
  if (has(/\b(bug|error|fails?|failed|crash|exception)\b/, /(خطأ|عطل|فشل|انهيار)/u)) return "bug";
  if (has(/\b(workflow|steps|process)\b/, /(خطوات|سير\s+العمل)/u)) return "workflow";
  if (has(/\b(pattern|convention)\b/, /(نمط|اصطلاح)/u)) return "pattern";
  return "fact";
}

export function prepareCapture(c: CaptureCandidate, now = Date.now()): CaptureOutcome {
  const cleaned = stripSecrets(stripPrivate(c.text)).replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned === "[private]") return { ok: false, reason: "empty" };
  if (cleaned.length > MAX_CHARS) return { ok: false, reason: "too_long" };
  if (c.source === "agent" && INSTRUCTION_LIKE.some((re) => re.test(cleaned))) return { ok: false, reason: "instruction_like" };
  const hash = crypto.createHash("sha256").update(`${c.sessionId ?? ""}\0${cleaned.toLowerCase()}`).digest("hex");
  for (const [h, t] of recent) if (now - t > DEDUP_WINDOW_MS) recent.delete(h);
  if (recent.has(hash)) return { ok: false, reason: "duplicate" };
  recent.set(hash, now);
  return { ok: true, text: cleaned, kind: c.kind ?? classifyKind(cleaned), hash };
}
