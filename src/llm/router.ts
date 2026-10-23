/**
 * Neo N10: output modes, effort and the model map.
 *
 * The composer exposes two orthogonal choices:
 *
 *   - an output type (Auto / Text / Image / Video / Slides / Website), the
 *     `agent_type` of §4.2, which decides *what pipeline the run targets*;
 *   - an effort level (Fast / Max), the `agent_effort` of §4.2, which decides
 *     *how much depth the models spend*.
 *
 * Both are resolved here into a concrete routing plan: a main model (plus the
 * ordered failover candidates that may serve it) and the tool set the run may
 * use. The preference lists are **model ids only** — never API keys. Keys stay
 * in the environment and are referenced by name through `apiKeyEnv`; resolution
 * against the real providers is delegated to the existing failover module
 * (`src/llm/failover.ts`) and the coding router (`src/llm/codingRouter.ts`),
 * which own cooldowns and the failover walk.
 *
 * Configuration (shares the `routing` key with C17/V14):
 *   `config.json` → `routing.perTool`  — tool name -> model id
 *   `config.json` → `routing.effort`   — fast | max -> model id
 *   env `LOAM_ROUTING_PER_TOOL`, `LOAM_ROUTING_FAST`, `LOAM_ROUTING_MAX`
 */
import type { Config } from "../config.js";
import { codingProviders, matchCoderProvider, usableProviders } from "./codingRouter.js";
import type { FailoverProvider } from "./failover.js";

// ---------------------------------------------------------------------------
// Output types (§4.2 `agent_type`, §8.1 composer row)
// ---------------------------------------------------------------------------

// The vocabulary and the output-type -> mode table live in `src/modes/` so the
// detector (`src/modes/detect.ts`) and the tool narrowing below cannot drift
// apart. They are re-exported here because this module is the historical home
// of the composer selectors and its importers (http.ts, loop.ts, index.ts) keep
// their existing import sites.
export {
  OUTPUT_TYPES,
  OUTPUT_TYPE_MODE,
  isOutputType,
  type OutputType,
} from "../modes/outputTypeMap.js";

import { OUTPUT_TYPE_MODE, isOutputType, type OutputType } from "../modes/outputTypeMap.js";

/** Tools whose presence pins a run to its output type's pipeline. */
export const OUTPUT_TYPE_TOOLS: Record<OutputType, readonly string[]> = {
  auto: [],
  text: ["loam_document", "loam_studio", "office_export"],
  image: ["loam_creative", "loam_canvas", "gen_image"],
  video: ["loam_creative", "loam_canvas", "gen_video", "video_export", "auto_video"],
  slides: ["loam_studio", "office_export"],
  website: ["web_scaffold", "preview_serve", "artifact_publish"],
};

/**
 * Tools every output-type run keeps, pipeline or not.
 *
 * The output type narrows a run to the tools that *produce* its deliverable, but
 * it must never strip the run's own control surface: `finish` (the only tool
 * that emits `done` and runs the workspace verification gates), `think`, the plan
 * tools, `artifact_publish` (every output-type prompt instructs the model to
 * publish its result) and the read/inspection tools the independent verifier
 * intersects with `INSPECTION_TOOLS`. A narrowed set without them is not a
 * stricter run, it is a run that cannot finish, cannot publish and cannot be
 * verified. The write/edit tools are kept because the pipeline tools build their
 * deliverables from workspace files.
 */
export const OUTPUT_TYPE_ESSENTIALS: readonly string[] = [
  "finish",
  "think",
  "plan",
  "phase_set",
  "message",
  "plan_exit",
  "suggest_plan",
  "artifact_publish",
  "file_read",
  "file_list",
  "file_search",
  "file_stat",
  "file_extract_text",
  "file_view_image",
  "file_write",
  "file_edit",
  "file_mkdir",
  "file_multi_edit",
  "grep",
  "glob",
];

/**
 * The system-prompt suffix for one output type. It is deliberately complete:
 * it states the deliverable, the tools that produce it and the acceptance bar,
 * because the same prompt text is handed to small and large models alike.
 */
export function outputTypeSuffix(type: OutputType): string {
  switch (type) {
    case "auto":
      return "";
    case "text":
      return "Output type: text document. Produce a single well-structured document in the task workspace and cite its sources. Use the document/studio tools to build it and publish it as an artifact when it is complete.";
    case "image":
      return "Output type: image. Produce the requested image(s) as workspace files and publish them as artifacts. Describe what you generated and the prompt or settings you used so the result is reproducible.";
    case "video":
      return "Output type: video. Produce the requested video as a workspace file and publish it as an artifact. Keep narration, timing and assets consistent, and verify the exported file before finishing.";
    case "slides":
      return "Output type: slides. Produce a presentation: a title slide, a clear narrative arc and a closing slide, each with speaker notes. Use the slides pipeline (loam_studio with kind \"presentation\") and publish the deck as an artifact.";
    case "website":
      return "Output type: website. Produce a runnable web app in the task workspace, serve it with the preview tools, and verify it in the browser before finishing. Publish the build as an artifact.";
  }
}

/**
 * The tool set an output-type run may use: its pipeline tools plus the run
 * essentials, intersected with what is actually registered (mode-filtered
 * upstream). Deterministic and deduplicated; `auto` yields nothing so an
 * unspecified run keeps its whole scope untouched.
 */
export function outputTypeTools(type: OutputType, registered: readonly string[]): string[] {
  if (type === "auto") return [];
  const available = new Set(registered);
  const out: string[] = [];
  for (const name of [...OUTPUT_TYPE_TOOLS[type], ...OUTPUT_TYPE_ESSENTIALS]) {
    if (available.has(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Effort (§4.2 `agent_effort`: Fast | Max)
// ---------------------------------------------------------------------------

export const EFFORT_LEVELS = ["fast", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Legacy step budgets already used by the task runner; kept as the Fast floor. */
const EFFORT_STEP_BUDGETS: Record<EffortLevel, number> = { fast: 24, max: 80 };

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value.toLowerCase());
}

/** Normalize any effort spelling ("Fast", "MAX", "quick") to fast|max|"". */
export function normalizeEffort(value: unknown): EffortLevel | "" {
  if (typeof value !== "string") return "";
  const v = value.trim().toLowerCase();
  if (v === "fast" || v === "quick" || v === "low" || v === "lite") return "fast";
  if (v === "max" || v === "maximum" || v === "best") return "max";
  return "";
}

/** Steps a run may take at one effort level. */
export function effortStepBudget(level: EffortLevel): number {
  return EFFORT_STEP_BUDGETS[level];
}

// ---------------------------------------------------------------------------
// The model map
// ---------------------------------------------------------------------------

/** One entry of the routing map: a model id, strongest first. */
export interface RoutingMapEntry {
  /** Concrete model id (`provider.model`). Empty entry = "use the fallback". */
  model: string;
}

export interface RoutingConfig {
  /** tool name -> model id (strongest first). */
  perTool?: Record<string, string>;
  /** effort level -> model id. */
  effort?: Partial<Record<EffortLevel, string>>;
}

export interface RoutingPlan {
  /** The model the run starts with. */
  model: string;
  /** Ordered candidate providers that may serve this run. */
  providers: FailoverProvider[];
  /** True when the main model came from the coding chain rather than a map. */
  coding: boolean;
  /** The tool whose per-tool entry selected the model, when one did. */
  tool?: string;
  /** The effort level that selected the model, when one did. */
  effort?: EffortLevel;
  /** Output type resolved for this run. */
  outputType: OutputType;
  /** Model ids to fan the same prompt out to as sibling canvas nodes (A/B). */
  siblings: string[];
}

export interface RoutingResolveInput {
  cfg: Config;
  /** The run's output type; "auto" when the composer left it unset. */
  outputType?: OutputType | "";
  /** The run's effort level; "" when unset. */
  effort?: EffortLevel | "";
  /** Tool the run is about to call; picks the per-tool entry when present. */
  tool?: string;
  env?: Record<string, string | undefined>;
}

function envChain(env: Record<string, string | undefined>, key: string): string[] {
  const raw = env[key];
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(/[,\s]+/)) {
    const id = part.trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The configured per-tool map: config first, env overlay second. */
export function perToolModels(cfg: Config, env: Record<string, string | undefined> = process.env): Record<string, string> {
  const map: Record<string, string> = {};
  const raw = cfg.routing?.perTool;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [tool, value] of Object.entries(raw)) {
      if (typeof value === "string" && value.trim()) map[tool] = value.trim();
    }
  }
  for (const entry of envChain(env, "LOAM_ROUTING_PER_TOOL")) {
    const [tool, model] = entry.split("=");
    if (tool && model) map[tool] = model;
  }
  return map;
}

/** The configured effort map: config first, env overlay second. */
export function effortModels(cfg: Config, env: Record<string, string | undefined> = process.env): Partial<Record<EffortLevel, string>> {
  const map: Partial<Record<EffortLevel, string>> = {};
  const raw = cfg.routing?.effort;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [level, value] of Object.entries(raw)) {
      const key = normalizeEffort(level);
      if (key && typeof value === "string" && value.trim()) map[key] = value.trim();
    }
  }
  const fast = env.LOAM_ROUTING_FAST;
  if (fast && fast.trim()) map.fast = fast.trim();
  const max = env.LOAM_ROUTING_MAX;
  if (max && max.trim()) map.max = max.trim();
  return map;
}

/**
 * Ordered providers for a model preference list. Entries are matched against
 * the enabled failover providers by model id, then provider id, then substring;
 * a matched but keyless cloud provider is dropped. Unknown entries fall through
 * to the coding chain, which is the existing "strongest available" answer.
 */
export function providersForModels(cfg: Config, models: string[], env: Record<string, string | undefined> = process.env): FailoverProvider[] {
  if (models.length === 0) return [];
  const enabled = (cfg.failover?.providers ?? []).filter((p) => p.enabled);
  const usable = usableProviders(cfg, env);
  const matched: FailoverProvider[] = [];
  for (const model of models) {
    const provider = matchCoderProvider(model, enabled);
    if (provider && usable.includes(provider) && !matched.includes(provider)) matched.push(provider);
  }
  return matched;
}

/** The fallback chain: the coding chain when routing is on, else every usable provider. */
export function fallbackProviders(cfg: Config, env: Record<string, string | undefined> = process.env): FailoverProvider[] {
  if (cfg.coding?.enabled === false) return usableProviders(cfg, env);
  return codingProviders(cfg, env);
}

function firstUsableModel(cfg: Config, models: string[], env: Record<string, string | undefined>): string {
  const providers = providersForModels(cfg, models, env);
  return providers[0]?.model ?? (models[0] || "");
}

/**
 * A model id from the map is only usable when an enabled, keyed provider serves
 * it. A configured-but-unserved id must not become the run's model: the plan
 * degrades to the coding chain instead, so a half-configured map is a no-op
 * rather than a run that no provider can answer.
 */
function usableModel(cfg: Config, model: string, env: Record<string, string | undefined>): string | undefined {
  return providersForModels(cfg, [model], env).length > 0 ? model : undefined;
}

/**
 * True when the routing map asks for nothing at all.
 *
 * An empty map means "leave the run alone": the loop keeps using the local client
 * with the same model preference order it always had (`opts.model` -> `cfg.model`
 * -> `cfg.fallbackModel`), and it must never be silently re-pointed at the coding
 * chain, which can name a different model that a remote provider serves.
 */
export function routingMapEmpty(cfg: Config, env: Record<string, string | undefined> = process.env): boolean {
  return Object.keys(perToolModels(cfg, env)).length === 0 && Object.keys(effortModels(cfg, env)).length === 0;
}

/**
 * Resolve one run's routing plan.
 *
 * Precedence: per-tool entry > effort entry > coding chain. `auto` never forces
 * a model, so an unspecified run behaves exactly as it did before N10.
 */
export function resolveRouting(input: RoutingResolveInput): RoutingPlan {
  const { cfg } = input;
  const env = input.env ?? process.env;
  const outputType: OutputType = isOutputType(input.outputType) ? input.outputType : "auto";
  const effort: EffortLevel | "" = normalizeEffort(input.effort ?? "");
  const perTool = perToolModels(cfg, env);
  const effortMap = effortModels(cfg, env);

  const tool = input.tool?.trim();
  const toolModel = tool ? perTool[tool] : undefined;
  if (toolModel) {
    const planEffort: EffortLevel | undefined = effort || undefined;
    const providers = providersForModels(cfg, [toolModel], env);
    // An unusable tool model is not a route at all: fall through to the effort
    // entry, and from there to the coding chain.
    if (usableModel(cfg, toolModel, env)) {
      return {
        model: providers[0]?.model ?? toolModel,
        providers: providers.length > 0 ? providers : fallbackProviders(cfg, env),
        coding: false,
        tool,
        ...(planEffort ? { effort: planEffort } : {}),
        outputType,
        siblings: [],
      };
    }
  }

  const effortModel = effort ? effortMap[effort] : undefined;
  const servedEffortModel = effortModel ? usableModel(cfg, effortModel, env) : undefined;
  if (servedEffortModel) {
    const planEffort: EffortLevel | undefined = effort || undefined;
    const providers = providersForModels(cfg, [servedEffortModel], env);
    return {
      model: providers[0]?.model ?? servedEffortModel,
      providers: providers.length > 0 ? providers : fallbackProviders(cfg, env),
      coding: false,
      ...(planEffort ? { effort: planEffort } : {}),
      outputType,
      siblings: [],
    };
  }

  // No map entry matched. When the map is empty the run is left exactly as it
  // was before N10: the local client keeps the loop's own model preference order
  // and no provider chain is forced on it. Only a *configured but unusable* entry
  // (a half-configured map) degrades to the coding chain, which is the existing
  // "strongest available" answer.
  const hasEffortEntry = effort ? effortMap[effort] !== undefined : false;
  if (routingMapEmpty(cfg, env)) {
    return {
      model: cfg.model,
      providers: [],
      coding: false,
      outputType,
      siblings: [],
    };
  }
  // An effort entry that names a model no provider serves is a half-configured
  // map: degrade to the coding chain rather than to a model nothing can answer.
  if (hasEffortEntry) {
    const chain = fallbackProviders(cfg, env);
    return {
      model: chain[0]?.model ?? cfg.model,
      providers: chain,
      coding: true,
      ...(effort ? { effort } : {}),
      outputType,
      siblings: [],
    };
  }
  const chain = fallbackProviders(cfg, env);
  const model = chain[0]?.model ?? cfg.model;
  return { model, providers: chain, coding: true, ...(effort ? { effort } : {}), outputType, siblings: [] };
}

/**
 * Multi-model A/B: the same prompt handed to 2-4 models as sibling canvas
 * nodes. Returns the distinct model ids to fan out to (the caller's own model
 * is included first when it is one of them).
 */
export function modelAbChain(input: RoutingResolveInput, count: number): string[] {
  const plan = resolveRouting(input);
  const perTool = perToolModels(input.cfg, input.env ?? process.env);
  const effortMap = effortModels(input.cfg, input.env ?? process.env);
  const candidates: string[] = [];
  const push = (model: string): void => {
    if (model && !candidates.includes(model)) candidates.push(model);
  };
  push(plan.model);
  // Every configured per-tool model is a candidate: a specialist generator is a
  // natural A/B arm even when the run has not called that tool yet.
  for (const model of Object.values(perTool)) push(model);
  const level = normalizeEffort(input.effort ?? "");
  if (level) push(effortMap[level] ?? "");
  const wanted = Math.max(2, Math.min(4, Math.round(count)));
  if (candidates.length === 0) return [];
  return candidates.slice(0, wanted);
}

/** Which provider serves a model id, for callers that need the client boundary. */
export function providerForModel(cfg: Config, model: string, env: Record<string, string | undefined> = process.env): FailoverProvider | undefined {
  const providers = providersForModels(cfg, [model], env);
  return providers[0] ?? fallbackProviders(cfg, env).find((p) => p.model === model);
}

/** The model id a run should report as its routing decision (canvas label). */
export function routingLabel(plan: RoutingPlan): string {
  if (plan.tool) return `${plan.model} (${plan.tool})`;
  if (plan.effort) return `${plan.model} (${plan.effort})`;
  return plan.coding ? `${plan.model} (coding)` : plan.model;
}

/** First usable model id from a list, else the config default. */
export function firstModel(cfg: Config, models: string[]): string {
  return firstUsableModel(cfg, models, process.env) || cfg.model;
}
