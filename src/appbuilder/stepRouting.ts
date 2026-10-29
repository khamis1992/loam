// src/appbuilder/stepRouting.ts
import type { Config } from "../config.js";
import { resolveTierModel, type ModelTier } from "../server/modelTiers.js";
import { providerForModel } from "../llm/router.js";
import type { AppRoleId, AppProject } from "./types.js";

export type StepClass = "plan" | "code" | "fast" | "vision";

export type AppStep =
  | "clarify" | "plan" | "assign" | "finish"        // lead
  | "design-doc" | "implement" | "fix"              // engineer
  | "role-work"                                     // product, architect, data, research, seo
  | "visual-review" | "version-title" | "wiki";     // system steps

export function stepClass(role: AppRoleId | "system", step: AppStep): StepClass {
  if (step === "visual-review") return "vision";
  if (step === "version-title" || step === "wiki") return "fast";
  if (role === "lead") return "plan";
  if (role === "engineer" || role === "data") return "code";
  return "plan";
}

/** Tier used per class when the project setting is "auto". */
export const AUTO_TIER: Record<StepClass, ModelTier> = {
  plan: "max",
  code: "max",
  fast: "standard",
  vision: "max",
};

const LOCAL_HOSTS = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i;

/** True only for models served by a remote provider. The local Ollama model never qualifies. */
export function isCloudModel(cfg: Config, model: string): boolean {
  if (!model) return false;
  if (model.endsWith(":cloud")) return true;
  const p = providerForModel(cfg, model);
  if (!p || !p.enabled) return false;
  if (p.kind === "ollama") return false;
  try { return !LOCAL_HOSTS.test(new URL(p.baseUrl).hostname); } catch { return false; }
}

export interface StepModel { model: string; tier: ModelTier; flex: boolean; class: StepClass }

export class NoCloudModelError extends Error {
  constructor() { super("no_cloud_model: App Builder needs a cloud model. Set one under Settings → Models."); this.name = "NoCloudModelError"; }
}

/**
 * Picks the model for one step. Order tried: the chosen tier, then max, then standard, then flex.
 * The first cloud model wins. Throws NoCloudModelError if none is cloud.
 */
export function modelForStep(cfg: Config, project: AppProject, role: AppRoleId | "system", step: AppStep): StepModel {
  const cls = stepClass(role, step);
  const chosen: ModelTier = cls === "fast" || cls === "vision" || project.settings.defaultTier === "auto"
    ? AUTO_TIER[cls]
    : project.settings.defaultTier;
  const order: ModelTier[] = [chosen, "max", "standard", "flex"].filter((t, i, a) => a.indexOf(t) === i) as ModelTier[];
  if (cls === "vision" && cfg.vision.model && isCloudModel(cfg, cfg.vision.model)) {
    return { model: cfg.vision.model, tier: "max", flex: false, class: cls };
  }
  for (const tier of order) {
    const r = resolveTierModel(cfg, tier);
    if (isCloudModel(cfg, r.model)) return { model: r.model, tier, flex: r.flex, class: cls };
  }
  throw new NoCloudModelError();
}
