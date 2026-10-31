/**
 * The intent router (UI overhaul W-U2): one entry point that decides which
 * Loam mode a free-text request should run in, plus the effort sizing the
 * swarm pipeline uses.
 *
 * Order of resolution:
 *   1. empty/whitespace text -> "ask" immediately (no model call);
 *   2. Layer 2 model (src/server/intentModel.ts) — ONE cheap classification
 *      call; a null result (timeout, garbage, unknown id) falls through;
 *   3. Layer 1 keywords (src/server/intentKeywords.ts) — deterministic Arabic
 *      + English seed scoring, "ask" below the confidence threshold.
 *
 * routeIntent NEVER throws: any unexpected error degrades to the "ask"
 * default with the keyword source, so the composer always gets a decision.
 */
import type { Config } from "../config.js";
import type { OllamaClient } from "../ollama.js";
import { classifyEffort, type EffortDecision } from "../swarm/effort.js";
import { classifyIntentByKeywords } from "./intentKeywords.js";
import { classifyIntentByModel, INTENT_DEFAULT_REASON } from "./intentModel.js";

/** The decision the composer and the endpoint both consume. */
export interface IntentDecision {
  mode: string;
  effort: EffortDecision;
  reason: string;
  source: "model" | "keywords";
}

/** What routeIntent needs; the HTTP layer passes deps.cfg and deps.ollama. */
export interface IntentRouterDeps {
  cfg: Config;
  ollama: OllamaClient;
  model?: string;
}

const ASK_FALLBACK_REASON = "لم نتعرف على نمط الطلب بوضوح، فاخترنا وضع «استكشف» افتراضيًا.";
const KEYWORD_REASON_PREFIX = "طابقت الكلمات المفتاحية:";

/** Builds the keyword-layer Arabic reason line from the matched seeds. */
export function keywordReason(matched: string[]): string {
  const shown = matched.slice(0, 3).join("، ");
  return shown.length > 0 ? KEYWORD_REASON_PREFIX + " " + shown : KEYWORD_REASON_PREFIX + " " + "طلب صريح";
}

/** Routes one request. Always resolves; never rejects. */
export async function routeIntent(text: string, deps: IntentRouterDeps): Promise<IntentDecision> {
  const trimmed = typeof text === "string" ? text.trim() : "";
  try {
    if (!trimmed) {
      return { mode: "ask", effort: classifyEffort(""), reason: ASK_FALLBACK_REASON, source: "keywords" };
    }
    const model = await classifyIntentByModel(trimmed, deps);
    if (model) {
      return { mode: model.mode, effort: classifyEffort(trimmed), reason: model.reason, source: "model" };
    }
    const keywords = classifyIntentByKeywords(trimmed);
    if (keywords.mode !== "ask") {
      return { mode: keywords.mode, effort: classifyEffort(trimmed), reason: keywordReason(keywords.matched), source: "keywords" };
    }
    return { mode: "ask", effort: classifyEffort(trimmed), reason: ASK_FALLBACK_REASON, source: "keywords" };
  } catch {
    return { mode: "ask", effort: classifyEffort(""), reason: INTENT_DEFAULT_REASON, source: "keywords" };
  }
}
