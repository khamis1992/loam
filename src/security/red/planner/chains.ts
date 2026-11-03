/**
 * Attack-chain reasoning (Supremacy M5.2): the model proposes multi-step
 * exploit chains from existing findings. Each chain step is a gated hypothesis;
 * the model only proposes, the evidence gate confirms.
 */
import type { OllamaClient } from "../../../ollama.js";

export interface ChainStep {
  step: number;
  description: string;
  usesFindingId?: string;
  target: string;
  capability: string;
}

export interface AttackChain {
  steps: ChainStep[];
  rationale: string;
}

const CHAIN_PROMPT = (findings: string, surface: string) => `You are a red-team attack-chain planner. Given confirmed findings and an attack surface, propose up to 3 chained exploitation steps. Each step must reference a finding or the surface. Output ONLY a JSON array of objects with fields: step (number), description (string), usesFindingId (string|null), target (string), capability (string). No explanation.

Findings:
${findings}

Attack surface:
${surface}`;

export async function proposeAttackChain(
  findings: Array<{ id: string; check: string; title: string; target: string; severity: string }>,
  surface: { hosts: number; paths: number; techs: string[] },
  model: { chat: OllamaClient["chat"] },
): Promise<AttackChain> {
  if (!findings.length) return { steps: [], rationale: "no findings to chain" };
  const findingsText = findings.map((f) => `- ${f.id}: [${f.severity}] ${f.title} @ ${f.target} (${f.check})`).join("\n");
  const surfaceText = `${surface.hosts} hosts, ${surface.paths} paths, techs: ${surface.techs.join(", ")}`;
  const result = await model.chat({
    model: "loam",
    messages: [{ role: "user", content: CHAIN_PROMPT(findingsText, surfaceText) }],
    temperature: 0.2,
    timeoutMs: 90_000,
  });
  let steps: ChainStep[] = [];
  try {
    const text = result.content.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    const parsed = JSON.parse(text) as ChainStep[];
    if (Array.isArray(parsed)) steps = parsed.filter((s) => typeof s.step === "number" && typeof s.description === "string" && typeof s.target === "string").slice(0, 3);
  } catch { /* invalid JSON → empty chain */ }
  return { steps, rationale: steps.length ? `${steps.length}-step chain proposed` : "no valid chain steps parsed" };
}
