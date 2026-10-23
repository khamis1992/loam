/**
 * Dependency-free MiroFish bridge.
 *
 * This module holds only the small, model-free pieces the conversational surface
 * (`src/tools/mirofish.ts`) and the async runner (`asyncRunner.ts`) both need:
 * the runtime dependency shape, location coercion, injected-variable parsing and
 * the deterministic locale/entity fallback.
 *
 * Everything that talks to a model lives in `asyncRunner.ts` / `runner.ts`; both
 * files import from here, which keeps the import graph acyclic (the conversational
 * surface must stay synchronous and model-free, so it can never import them).
 */
import type { ModelCaller } from "./model.js";
import { resolveLocale } from "./locale.js";
import { runSeed, ruleBasedPersonas } from "./seed.js";
import type { Config } from "../../config.js";
import type { OllamaClient } from "../../ollama.js";
import type { Emit } from "../../agent/events.js";
import type { EntitySet, SeedResult } from "./types.js";

/** Everything a real swarm run needs from the surrounding Loam process. */
export interface MirofishRuntimeDeps {
  cfg: Config;
  ollama?: OllamaClient;
  workspace: string;
  /** Run event bus; progress events are forwarded here when present. */
  emit?: Emit;
  /** Test seam: a deterministic caller replaces the whole provider chain. */
  caller?: ModelCaller;
  /** Cancellation signal from the surrounding run. */
  signal?: AbortSignal;
}

/** A conversational request the async runner turns into a swarm simulation. */
export interface MirofishRunRequest {
  message: string;
  target?: string;
  maxRounds?: number;
  injectedVariable?: string;
  /** Model-derived language hint ("auto" or a BCP-47 tag). */
  language?: string;
  /** Public simulation id already allocated by the caller. */
  simulationId?: string;
  /** Location extracted by the caller from the message. */
  location?: { city: string | null; country: string | null; region: string | null };
  /** Optional pre-extracted profile so a run can reuse a seed it already paid for. */
  existingPersonas?: SeedResult["personas"];
  /** Optional pre-extracted locale, so the fallback path does not re-resolve it. */
  existingLocale?: SeedResult["locale"];
}

/** A variable pair the user asked to stress (e.g. price 1200 -> 1450). */
export interface VariablePair {
  name: string;
  baseline: string | number;
  scenario: string | number;
}

/** Parse a free-form injected variable into a baseline/scenario pair. */
export function parseInjectedVariable(raw: string | undefined): VariablePair | undefined {
  const text = (raw || "").trim();
  if (!text) return undefined;
  const name =
    text.match(
      /^\s*([A-Za-z_][\w-]*|سعر|السعر|الأسعار|معدل|نسبة|الترافيك|الباقة|خطة|المصاريف|العملاء|التحويل|مدة|الجولات|الوكلاء)\b/,
    )?.[1] ?? undefined;
  const values = text.match(/-?\d+(?:[.,]\d+)?/g)?.map((v) => v.replace(",", ".")) ?? [];
  if (values.length >= 2) {
    return { name: name ?? "value", baseline: toNumberOrString(values[0]!), scenario: toNumberOrString(values[1]!) };
  }
  if (values.length === 1) {
    return { name: name ?? "value", baseline: 0, scenario: toNumberOrString(values[0]!) };
  }
  if (!name) return undefined;
  return { name, baseline: "current", scenario: text };
}

function toNumberOrString(raw: string): string | number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : raw;
}

/**
 * Narrow a nullable extracted location into the `{country?, city?, region?}`
 * shape the seed step accepts, dropping empty/null entries.
 */
export function toLocationSetting(location: {
  city: string | null;
  country: string | null;
  region: string | null;
}): { country?: string; city?: string; region?: string } {
  return {
    ...(location.country ? { country: location.country } : {}),
    ...(location.city ? { city: location.city } : {}),
    ...(location.region ? { region: location.region } : {}),
  };
}

/**
 * Deterministic locale + entity + persona fallback, independent of any model
 * call. This is the honest "no model reachable" path: nothing is invented and
 * the run still completes.
 */
export async function fallbackSeed(
  workspace: string,
  message: string,
  location: { city: string | null; country: string | null; region: string | null },
  agents: number,
): Promise<SeedResult> {
  const setting = toLocationSetting(location);
  const { locale } = await resolveLocale(setting, message, undefined, { workspace });
  const seeded = await runSeed({ brief: message, ...setting, agents, rounds: 1 }, { workspace });
  const personas = ruleBasedPersonas(agents, locale, seeded.entities, 1);
  return { locale, entities: seeded.entities, personas, localeSource: "fallback", modelCalls: 0 };
}

/** Rule-based entity extraction only; the model path lives in `asyncRunner`. */
export async function fallbackEntities(workspace: string, brief: string): Promise<EntitySet> {
  const seeded = await runSeed({ brief, agents: 1, rounds: 1 }, { workspace });
  return seeded.entities;
}
