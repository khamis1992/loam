/**
 * MiroFish swarm simulation: shared types.
 *
 * This module is the single contract between the swarm pipeline stages
 * (seed -> simulate -> report) and the deterministic test doubles used by the
 * e2e gate. It is provider-neutral: no country, currency or language is
 * hard-coded here, and the only model boundary is the injectable
 * {@link ModelCaller} (defined in `./model.js` for the seed/model chain).
 *
 * It carries two families of types that describe the same domain objects:
 *  - seed/locale/persona types (M2) used by `locale.ts` and `seed.ts`;
 *  - pipeline/report types (M7) used by `pipeline.ts` and the e2e gate.
 *
 * `LocaleProfile`, `IncomeBand`, `Persona` and `SimulationSettings` are defined
 * once here as supertypes that satisfy both consumers, so neither family is
 * weakened: every field the seed chain produces is present, and every field the
 * e2e fixtures emit is accepted.
 */
import type { ModelCaller as SeedModelCaller } from "./model.js";

// ---------------------------------------------------------------------------
// Model boundary (M7 pipeline)
// ---------------------------------------------------------------------------

/** The stage a model call belongs to. Drives prompt construction and parsing. */
export type ModelRole = "locale" | "persona" | "simulate" | "report";

/** One request to the injectable model boundary. */
export interface ModelCallInput {
  role: ModelRole;
  /** System instructions for the model. */
  system: string;
  /** The full user prompt (brief, locale, variable value, feed, ...). */
  prompt: string;
  /** When true the caller must return a single JSON object. */
  json: boolean;
  /** Optional per-call timeout in milliseconds. */
  timeoutMs?: number;
}

/** Raw text returned by the model boundary. */
export interface ModelCallOutput {
  text: string;
}

/**
 * The model boundary the pipeline may use. Production wires this to
 * `chatWithFailover`; tests inject a deterministic double. This is a distinct
 * shape from the seed chain's {@link SeedModelCaller}, which carries
 * `temperature`/`timeoutMs` per call.
 */
export interface ModelCaller {
  call(input: ModelCallInput): Promise<ModelCallOutput>;
}

/** Re-export the seed chain's caller so `types.ts` remains a single import site. */
export type { SeedModelCaller };

// ---------------------------------------------------------------------------
// Locale (shared by M2 seed and M7 pipeline)
// ---------------------------------------------------------------------------

/** A location the user explicitly selected. Any country/city/region worldwide. */
export interface LocationSetting {
  country?: string;
  city?: string;
  region?: string;
}

/** Alias kept for callers that spell the setting "LocaleLocation". */
export type LocaleLocation = LocationSetting;

/** One income band expressed in the locale's own currency. */
export interface IncomeBand {
  /** Human label, e.g. "low", "middle", "affluent" (localized is fine). */
  label: string;
  /** Lower bound in local currency (monthly, per household unless noted). */
  min: number;
  /** Upper bound in local currency; omit for the open-ended top band. */
  max?: number;
  /** ISO 4217 currency code the bounds are expressed in. */
  currency: string;
}

/**
 * Resolved, locale-aware context used to build personas and prompts.
 *
 * Every field here is produced by the seed chain (`locale.ts`). The pipeline
 * stage reads the same shape, so the two families share one definition.
 */
export interface LocaleProfile {
  country: string;
  city?: string;
  region?: string;
  /** ISO 4217 currency code (e.g. "QAR", "GBP", "USD"). */
  currency: string;
  /** Languages in order of prominence (BCP-47 tags, e.g. ["ar-QA", "en"]). */
  languages: string[];
  /** Dialect / register note, e.g. "Gulf Arabic", "British English". */
  dialect?: string;
  /** Income bands expressed in the local currency. */
  incomeBands: IncomeBand[];
  /** Short demographic / market notes that shape persona diversity. */
  demographics: string[];
  /** IANA timezone name when known. */
  timezone?: string;
  /** Free-form note about how the locale was resolved. */
  notes?: string;
}

// ---------------------------------------------------------------------------
// Settings / entities (shared by M2 seed and M7 pipeline)
// ---------------------------------------------------------------------------

/** The variable the user wants to stress, e.g. a price change. */
export interface SimulationVariable {
  name: string;
  baseline: string | number;
  /** Alias for `baseline` kept for the M7 pipeline contract. */
  scenario?: string | number;
  unit?: string;
}

/** Full simulation settings accepted by the tool/HTTP layer. */
export interface SimulationSettings {
  brief: string;
  /** Optional uploaded document paths (text/markdown/pdf-text/office). */
  docs?: string[];
  /** Optional user-selected location; inferred from brief/docs when absent. */
  location?: LocationSetting;
  /** Number of simulated agents. Default 12, max 20 unless explicitly raised. */
  agents?: number;
  /** Number of simulation rounds. Default 3. */
  rounds?: number;
  /** Optional variable to vary between rounds (e.g. price 1200 -> 1450). */
  variable?: SimulationVariable | null;
  /** Output language: "auto" (follow locale/user) or a BCP-47 tag. */
  language?: string;
  /** Optional RNG seed for reproducible runs. */
  seed?: number;
}

/** A named thing extracted from the brief/docs (product, competitor, ...). */
export interface EntityRef {
  name: string;
  kind?: string;
  detail?: string;
}

/** A price point extracted from the brief/docs. */
export interface PricePoint {
  product?: string;
  amount: number;
  /** ISO 4217 currency code. */
  currency: string;
  /** Billing period, e.g. "month", "year", "one-time". */
  period?: string;
}

/** The structured facts the seed step pulls out of the brief + docs. */
export interface EntitySet {
  products: EntityRef[];
  prices: PricePoint[];
  competitors: EntityRef[];
  audiences: string[];
  variable?: SimulationVariable;
  /** One-paragraph neutral summary of the target product/market. */
  summary?: string;
}

// ---------------------------------------------------------------------------
// Persona (supertype satisfying both the M2 seed and the M7 pipeline)
// ---------------------------------------------------------------------------

/**
 * One simulated customer/agent persona.
 *
 * Fields produced by the seed chain (M2) and the fields emitted by the pipeline
 * e2e gate (M7) are merged here. Fields owned by only one stage are optional so
 * each stage can populate the subset it produces without weakening the other.
 */
export interface Persona {
  id: string;
  name: string;
  /** Short first-person bio used as the agent's system prompt seed. */
  bio: string;
  age: number;
  gender: string;
  country: string;
  city?: string;
  /** Income band label from the locale profile. */
  incomeBand: string;
  currency: string;
  /** Language the persona primarily uses. */
  language: string;

  /** Nationality/cultural background, realistic for the locale (M2 seed). */
  nationality?: string;
  /** Representative monthly income in local currency (M2 seed). */
  incomeAmount?: number;
  /** Household composition, e.g. "single", "family of four" (M2 seed). */
  household?: string;
  /** Occupation/profession (M2 seed). */
  occupation?: string;
  /** Primary channel (e.g. "Instagram", "X", "word of mouth") (M2 seed). */
  channel?: string;
  /** Baseline attitude toward the product category (M2 seed). */
  attitude?: string;
  /** Everyday habits that shape how they discover and buy (M2 seed). */
  habits?: string[];

  /** Diet / consumption preferences when relevant (M2 seed). */
  diet?: string;
  dialect?: string;

  /** Seed-style persona descriptor (M2). */
  persona?: string;
  /** M7 pipeline field: MBTI-style personality descriptor. */
  mbti?: string;
  /** M7 pipeline alias for `occupation`. */
  profession?: string;
  /** M7 pipeline alias for `habits` (topics the persona cares about). */
  interestedTopics?: string[];
}

// ---------------------------------------------------------------------------
// Simulation log / report (M7 pipeline)
// ---------------------------------------------------------------------------

export type SimulationAction = "post" | "comment" | "like" | "repost" | "follow";

/** One logged agent action within a round. */
export interface SimulationEvent {
  round: number;
  agentId: string;
  action: SimulationAction;
  text: string;
  /** -1 (against) .. 1 (for). */
  stance: number;
  /** 0 (no intent) .. 1 (strong intent). */
  purchaseIntent: number;
  sharedWith: string[];
}

/** Aggregated metrics for one round, computed from the event log only. */
export interface RoundMetrics {
  round: number;
  meanStance: number;
  meanPurchaseIntent: number;
  engagement: number;
  opinionSpread: number;
}

/** The JSONL-backed event log plus per-round aggregates. */
export interface SimulationLog {
  events: SimulationEvent[];
  rounds: RoundMetrics[];
}

/** A verbatim agent quote cited by the report. */
export interface ReportQuote {
  agentId: string;
  agentName: string;
  text: string;
}

/** The final swarm report. Numbers are computed from the log, not hard-coded. */
export interface SwarmReport {
  title: string;
  markdown: string;
  summary: string;
  purchaseIntent: number;
  meanStance: number;
  rounds: number;
  agents: number;
  metrics: Record<string, number>;
  quotes: ReportQuote[];
  disclaimer: string;
}

/** The complete output of the M2 seed step. */
export interface SeedResult {
  locale: LocaleProfile;
  entities: EntitySet;
  personas: Persona[];
  /** How the locale was resolved: user setting, model inference, or fallback. */
  localeSource: "user" | "inferred" | "fallback";
  /** Number of model calls actually made. */
  modelCalls: number;
}

/** Output of a full seed -> simulate -> report run. */
export interface PipelineResult {
  locale: LocaleProfile;
  personas: Persona[];
  log: SimulationLog;
  report: SwarmReport;
  /** Seed-step facts (M2) carried alongside the pipeline result. */
  entities?: EntitySet;
}

/** Input to the core pipeline. */
export interface PipelineInput {
  settings: SimulationSettings;
  caller: ModelCaller;
  workspace: string;
  /** RAM-light default: 2 concurrent model calls. */
  concurrency?: number;
  onProgress?: (event: { stage: string; message: string }) => void;
}

/**
 * The conversational entry point shared by the `mirofish_chat` tool and the e2e
 * gate. When `settings` is omitted the pipeline derives them from the message
 * and target (seed stage).
 */
export interface MirofishChatRequest {
  workspace: string;
  message: string;
  target?: string;
  settings?: SimulationSettings;
  caller: ModelCaller;
  onProgress?: (event: { stage: string; message: string }) => void;
}

/** Thrown when a pipeline stage has not been implemented yet. */
export class MirofishPipelineUnavailableError extends Error {
  readonly stage: string;
  constructor(stage: string) {
    super(`MiroFish pipeline stage "${stage}" is not implemented yet`);
    this.name = "MirofishPipelineUnavailableError";
    this.stage = stage;
  }
}
