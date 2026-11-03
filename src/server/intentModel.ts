/**
 * Layer 2 of the intent router (UI overhaul W-U2): one cheap classification
 * call to the configured model. The system prompt lists the real catalog
 * (LOAM_MODES labelAr + description) and asks for a single JSON object
 * {"mode":"<id>","reason_ar":"<one Arabic line>"}. Parsing is lenient, unknown
 * mode ids are rejected against the catalog, and ANY failure — network,
 * timeout, garbage output, unknown id — returns null so the caller falls back
 * to the deterministic keyword layer. This is an LLM classification call over
 * the normal model HTTP client; there is no process or command anywhere here.
 */
import type { Config } from "../config.js";
import type { ChatMessage, OllamaClient } from "../ollama.js";
import { chatWithFallback } from "../agent/model.js";
import { LOAM_MODES } from "../modes/catalog.js";
import { INTENT_MODE_IDS } from "./intentKeywords.js";

/** Hard cap for the one classification call: the composer needs a fast answer. */
export const INTENT_MODEL_TIMEOUT_MS = 4000;

/** Reason returned when the model does not supply a usable Arabic line. */
export const INTENT_DEFAULT_REASON = "صنّف الطلب النموذج إلى هذا الوضع.";

/** One catalog line per mode: id, Arabic label, short description. */
export function buildCatalogList(): string {
  return LOAM_MODES.map((mode) => `- ${mode.id}: ${mode.labelAr} — ${mode.description.slice(0, 140)}`).join("\n");
}

/** The classification system prompt, built once from the real catalog. */
export function buildSystemPrompt(): string {
  return [
    "أنت موجّه نوايا في تطبيق Loam.",
    "صنّف طلب المستخدم إلى وضع واحد فقط من القائمة التالية.",
    "أجب بكائن JSON واحد فقط بالشكل {\"mode\":\"<id>\",\"reason_ar\":\"سطر عربي واحد\"} دون أي نص آخر.",
    "الأوضاع المتاحة:",
    buildCatalogList(),
  ].join("\n");
}

/** Pure builders so the model call below passes ready-made variables. */
export function buildSystemMessage(): ChatMessage {
  return { role: "system", content: buildSystemPrompt() };
}

export function buildUserMessage(text: string): ChatMessage {
  return { role: "user", content: typeof text === "string" ? text : "" };
}

const SYSTEM_MESSAGE: ChatMessage = buildSystemMessage();

/** What the caller may hand to the classifier. */
export interface ModelIntentDeps {
  cfg: Config;
  ollama: OllamaClient;
  /** Preferred model; empty/undefined uses cfg.model then the fallback chain. */
  model?: string;
}

/** A successful classification: a real mode id and a one-line Arabic reason. */
export interface ModelIntent {
  mode: string;
  reason: string;
}

/**
 * Lenient JSON extraction: direct parse, then a fenced block, then the first
 * balanced {...} span. Returns null when nothing parseable is found.
 */
export function extractIntentJson(content: string): Record<string, unknown> | null {
  const text = typeof content === "string" ? content.trim() : "";
  if (!text) return null;
  const tryParse = (slice: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(slice) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(text);
  if (direct) return direct;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence && fence[1]) {
    const inner = tryParse(fence[1].trim());
    if (inner) return inner;
  }
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const parsed = tryParse(text.slice(start, i + 1));
        if (parsed) return parsed;
        depth = 1; // keep scanning in case a later balanced span parses
      }
    }
  }
  return null;
}

/**
 * ONE model call (temperature 0, tools none, 4s cap). Returns null on any
 * failure so routeIntent can degrade to the keyword layer. Never throws.
 */
export async function classifyIntentByModel(text: string, deps: ModelIntentDeps): Promise<ModelIntent | null> {
  try {
    const messages: ChatMessage[] = [SYSTEM_MESSAGE, buildUserMessage(text)];
    const result = await chatWithFallback({
      cfg: deps.cfg,
      ollama: deps.ollama,
      messages,
      temperature: 0,
      timeoutMs: INTENT_MODEL_TIMEOUT_MS,
      ...(deps.model && deps.model.trim().length > 0 ? { model: deps.model.trim() } : {}),
    });
    const parsed = extractIntentJson(result?.content ?? "");
    if (!parsed) return null;
    const mode = typeof parsed.mode === "string" ? parsed.mode.trim() : "";
    if (!INTENT_MODE_IDS.has(mode)) return null;
    const reasonRaw = parsed.reason_ar;
    const reason = typeof reasonRaw === "string" && reasonRaw.trim().length > 0 ? reasonRaw.trim() : INTENT_DEFAULT_REASON;
    return { mode, reason: reason.slice(0, 200) };
  } catch {
    return null;
  }
}
