// Harness2 correction & experience learning: distiller (BUILD_SPEC .h2-ref/BUILD_SPEC.md
// section 6.4, H4). Re-implemented independently from the upstream idea; no code is copied.
import { log } from "../../log.js";
import type { Config } from "../../config.js";
import type { OllamaClient } from "../../ollama.js";
import { type DistillResult, type Confidence, isCompleteLesson } from "./types.js";

export const DISTILL_SYSTEM = [
  "You turn ONE user correction of an AI agent into ONE reusable rule.",
  'Return ONLY JSON: {"cue":"when this situation occurs","lesson":"what the agent must do","evidence":"what in the episode shows it","confidence":"low|medium|high"}',
  "Rules: cue and lesson must generalize beyond this single message; write them in the user's language;",
  "never include secrets, tokens, file contents or personal data; if no reusable rule exists return {}.",
].join("\n");

const MAX_CUE = 300;
const MAX_LESSON = 500;
const MAX_EVIDENCE = 500;

/** Parse the model's strict 4-field JSON answer. Salvages the object out of prose,
 *  fenced markdown and surrounding text (same approach as critic.parseCritique).
 *  Anything incomplete (including a bare `{}`) is rejected, per isCompleteLesson. */
export function parseDistill(text: string): DistillResult | null {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const r = JSON.parse(text.slice(a, b + 1)) as Record<string, unknown>;
    const conf: Confidence = r.confidence === "high" || r.confidence === "low" ? r.confidence : "medium";
    const d = {
      cue: String(r.cue ?? "").slice(0, MAX_CUE),
      lesson: String(r.lesson ?? "").slice(0, MAX_LESSON),
      evidence: String(r.evidence ?? "").slice(0, MAX_EVIDENCE),
      confidence: conf,
    };
    return isCompleteLesson(d) ? d : null;
  } catch {
    return null;
  }
}

export async function distillCorrection(o: {
  cfg: Config;
  ollama: OllamaClient;
  taskPrompt: string;
  priorAssistant: string;
  userText: string;
}): Promise<DistillResult | null> {
  const user = [
    "TASK:",
    o.taskPrompt.slice(0, 2000),
    "",
    "AGENT SAID:",
    o.priorAssistant.slice(0, 3000),
    "",
    "USER CORRECTION:",
    o.userText.slice(0, 2000),
  ].join("\n");
  // Same call shape as critiqueCase (src/learning/critic.ts:76-84): ollama.chat with
  // system + user messages, a low temperature and a generous timeout; no `any`.
  const model = o.cfg.selfImprove.model || o.cfg.model;
  try {
    const r = await o.ollama.chat({
      model,
      messages: [
        { role: "system", content: DISTILL_SYSTEM },
        { role: "user", content: user },
      ],
      temperature: 0.1,
      timeoutMs: 180_000,
    });
    const parsed = parseDistill(r.content);
    if (!parsed) log.warn(`distill: unparseable output (${r.content.slice(0, 120)}...)`);
    return parsed;
  } catch (err) {
    log.warn(`distill failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
