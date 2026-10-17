import { log } from "../log.js";
import type { Config } from "../config.js";
import type { OllamaClient } from "../ollama.js";
import type { CritiqueResult } from "../eval/types.js";

export interface CritiqueInput {
  cfg: Config;
  ollama: OllamaClient;
  prompt: string;
  finalText: string;
  trace: Array<{ name: string; ok: boolean; ms?: number }>;
  checkpoints: Array<{ type: string; ok: boolean; detail: string }>;
  status: string;
  error?: string;
}

const CRITIC_SYSTEM = [
  "You are the post-task critic for a local autonomous agent.",
  "You receive one episode: the task, the final answer, the tool trace, and GROUND-TRUTH verifier results.",
  "Return ONLY JSON (no markdown):",
  '{"passed": true|false, "score": 0.0-1.0, "reasons": ["2-4 short bullets"], "failure_causes": ["root causes, [] when passed"], "better_plan": "1-3 sentences on how to do it better next time", "lessons": ["short generalizable rules"]}',
  "Rules:",
  '- "passed" must agree with the verifier results (they are ground truth).',
  "- Ground every claim in the observed trace; never invent steps.",
  "- failure_causes must be root causes (wrong tool, missing verification, wrong assumption), not restatements.",
  "- lessons must be reusable beyond this single task. Empty array if the episode taught nothing.",
].join("\n");

function parseCritique(text: string): CritiqueResult | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const toStringArray = (v: unknown): string[] =>
      Array.isArray(v) ? v.map((x) => String(x)).filter((s) => s.trim().length > 0).slice(0, 8) : [];
    let score = typeof raw.score === "number" ? raw.score : 0;
    if (score > 1) score = score / 100;
    return {
      passed: raw.passed === true,
      score: Math.min(Math.max(score, 0), 1),
      reasons: toStringArray(raw.reasons),
      failureCauses: toStringArray(raw.failure_causes),
      betterPlan: typeof raw.better_plan === "string" ? raw.better_plan.slice(0, 2000) : "",
      lessons: toStringArray(raw.lessons),
    };
  } catch {
    return null;
  }
}

export async function critiqueCase(input: CritiqueInput): Promise<CritiqueResult | null> {
  const model = input.cfg.selfImprove.model || input.cfg.model;
  const trace = input.trace
    .slice(-30)
    .map((t) => `- ${t.ok ? "ok" : "FAIL"} ${t.name}${t.ms !== undefined ? ` (${t.ms}ms)` : ""}`)
    .join("\n");
  const checkpoints = input.checkpoints.map((c) => `- ${c.ok ? "ok" : "FAIL"} ${c.type}: ${c.detail}`).join("\n");
  const digest = [
    "TASK:",
    input.prompt.slice(0, 1500),
    "",
    `RUN STATUS: ${input.status}${input.error ? ` (${input.error})` : ""}`,
    "",
    "FINAL ANSWER:",
    input.finalText.slice(0, 3000) || "(no final answer)",
    "",
    "TOOL TRACE:",
    trace || "(no tools were used)",
    "",
    "VERIFIER RESULTS (ground truth):",
    checkpoints || "(none)",
  ].join("\n");

  try {
    const result = await input.ollama.chat({
      model,
      messages: [
        { role: "system", content: CRITIC_SYSTEM },
        { role: "user", content: digest },
      ],
      temperature: 0.1,
      timeoutMs: 180_000,
    });
    const parsed = parseCritique(result.content);
    if (!parsed) log.warn(`critic: unparseable output (${result.content.slice(0, 120)}...)`);
    return parsed;
  } catch (err) {
    log.warn(`critic failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
