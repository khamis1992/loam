/**
 * Config transform for a legal-mode run (applied in src/index.ts right after
 * `effectiveCfg` is built, ~line 349 at 5227df4).
 *
 * Every path by which Loam can silently change the model is closed, because
 * each one could carry client text to a cloud provider (all OBSERVED at 5227df4):
 *  - src/agent/model.ts candidateModels(): preferred -> cfg.model -> cfg.fallbackModel
 *    (cfg.model defaults to "glm-5.3-flash:cloud");
 *  - cfg.failover.providers (defaults include "glm-5.3:cloud" and the
 *    openai-compatible "opencode-go" endpoint);
 *  - cfg.coding (C17 coding router, enabled by default, uses the failover order);
 *  - cfg.routing (N10 per-tool / effort model map) and A/B arms (modelAbChain);
 *  - cfg.memory.autoStore (default false) is forced off defensively.
 * The run must also use a plain local OllamaClient, never the runtime-wide
 * FailoverClient (src/llm/failover.ts:406), whose chat() walks the provider chain.
 */
import { resolveLegalRunModel, type EgressConfig } from "./egress.js";
import { redactForCloud } from "./redact.js";
import type { Matter } from "./types.js";

export interface RunConfigSubset {
  model: string;
  fallbackModel: string;
  ollamaUrl: string;
  failover?: { providers: Array<{ id: string; model: string; enabled: boolean }> };
  coding?: { enabled: boolean; chain: string[]; logEdits: boolean };
  routing?: { perTool?: Record<string, string>; effort?: Record<string, string | undefined> };
  memory: { enabled: boolean; model: string; autoStore?: boolean };
}

export interface LegalRunPlan<C extends RunConfigSubset> {
  cfg: C;
  model: string;
  abModels: string[];
  redact: boolean;
  /** Companion-memory capture stays off for legal runs (client facts must not leak into general memory). */
  captureMemory: false;
  reason: string;
}

export function legalRunConfig<C extends RunConfigSubset>(
  cfg: C, chosenModel: string, matter: Pick<Matter, "confidentiality" | "egress"> | null, egress: EgressConfig,
): LegalRunPlan<C> {
  const r = resolveLegalRunModel(matter, chosenModel, egress);
  const out: C = {
    ...cfg,
    model: r.model,
    fallbackModel: r.model,
    ...(cfg.failover ? { failover: { providers: cfg.failover.providers.map((p) => ({ ...p, enabled: false })) } } : {}),
    ...(cfg.coding ? { coding: { ...cfg.coding, enabled: false, chain: [] } } : {}),
    routing: { perTool: {}, effort: {} },
    // Defensive: at 5227df4 autoStore is only reported (http.ts:1023), but a future auto-store
    // path must never copy matter facts into the general companion memory.
    memory: { ...cfg.memory, autoStore: false },
  };
  return { cfg: out, model: r.model, abModels: [], redact: r.redact, captureMemory: false, reason: r.reason };
}

export function assertLegalPromptAllowed(prompt: string, matter: Pick<Matter, "parties"> | null, plan: Pick<LegalRunPlan<RunConfigSubset>, "redact">): void {
  if (!plan.redact || !matter) return;
  const redacted = redactForCloud(prompt, matter.parties);
  if (redacted.text !== prompt) throw new Error("legal cloud_redacted run blocked: the prompt contains a party name or identifier; move the facts to the protected matter documents");
}
