/**
 * Which model may see what. Pure functions; the run builder (src/index.ts,
 * legal mode) and every legal tool that calls a model go through them.
 *
 *  - Public law text (corpus) may go to any configured model.
 *  - Matter/contract text goes to a LOCAL approved model by default. A local
 *    model is one without the ":cloud" suffix served from a loopback Ollama URL
 *    AND present in `approvedLocalModels` (Khamis: only qwen3.6:35b-a3b).
 *  - A cloud model sees matter text only if the matter's egress policy (set in
 *    the UI by the user, never by a tool) is cloud_redacted (redaction applied)
 *    or cloud_full. Privileged matters never go to the cloud redacted-only.
 *  - Failover/A-B arms are disabled for legal runs so a provider outage can
 *    never silently re-route client text to a cloud provider.
 */
import type { Matter } from "./types.js";

export type PayloadKind = "law_text" | "matter_text" | "contract_text";

export interface EgressConfig {
  localModel: string;
  approvedLocalModels: readonly string[];
  ollamaUrl: string;
}

export type EgressDecision =
  | { allow: true; redact: boolean; model: string; reason: string }
  | { allow: false; reason: string; fallbackModel: string | null };

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isLoopbackUrl(url: string): boolean {
  try { return LOOPBACK.has(new URL(url).hostname); } catch { return false; }
}

export function isLocalModel(model: string, cfg: EgressConfig): boolean {
  return !model.endsWith(":cloud") && isLoopbackUrl(cfg.ollamaUrl);
}

export function isApprovedLocal(model: string, cfg: EgressConfig): boolean {
  return isLocalModel(model, cfg) && cfg.approvedLocalModels.includes(model);
}

export function decideEgress(
  matter: Pick<Matter, "confidentiality" | "egress"> | null,
  model: string,
  payload: PayloadKind,
  cfg: EgressConfig,
): EgressDecision {
  const fallback = isApprovedLocal(cfg.localModel, cfg) ? cfg.localModel : null;
  if (isLocalModel(model, cfg)) {
    if (isApprovedLocal(model, cfg)) return { allow: true, redact: false, model, reason: "approved local model" };
    return { allow: false, reason: `local model "${model}" is not in the approved list`, fallbackModel: fallback };
  }
  if (payload === "law_text") return { allow: true, redact: false, model, reason: "public law text" };
  if (!matter) return { allow: false, reason: "client text without a matter never leaves the machine", fallbackModel: fallback };
  if (matter.confidentiality === "public") return { allow: true, redact: false, model, reason: "matter marked public" };
  switch (matter.egress) {
    case "local_only":
      return { allow: false, reason: "matter egress is local_only", fallbackModel: fallback };
    case "cloud_redacted":
      if (matter.confidentiality === "privileged") return { allow: false, reason: "privileged matter: redaction alone is not enough", fallbackModel: fallback };
      return { allow: true, redact: true, model, reason: "matter opted in to redacted cloud processing" };
    case "cloud_full":
      return { allow: true, redact: false, model, reason: "matter opted in to full cloud processing" };
  }
}

export interface LegalRunModel {
  model: string;
  disableFailover: true;
  abModels: string[];
  redact: boolean;
  reason: string;
}

/**
 * Model for a legal-mode run. Throws when neither the chosen model nor the
 * approved local fallback may see the matter (e.g. Ollama URL not loopback).
 */
export function resolveLegalRunModel(
  matter: Pick<Matter, "confidentiality" | "egress"> | null,
  chosenModel: string,
  cfg: EgressConfig,
): LegalRunModel {
  const d = decideEgress(matter, chosenModel, "matter_text", cfg);
  if (d.allow) return { model: d.model, disableFailover: true, abModels: [], redact: d.redact, reason: d.reason };
  if (d.fallbackModel) {
    return { model: d.fallbackModel, disableFailover: true, abModels: [], redact: false, reason: `${d.reason}; using approved local model` };
  }
  throw new Error(`legal run blocked: ${d.reason}, and no approved local model is available`);
}
