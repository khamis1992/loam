/**
 * MiroFish swarm simulation: shared types.
 *
 * This module defines the contract between the swarm pipeline stages
 * (seed -> simulate -> report) and the deterministic test doubles used by the
 * e2e gate. It never imports a provider and never calls a real model: the only
 * entry point for model access is the injectable {@link ModelCaller}.
 */

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
 * The only model boundary the pipeline may use. Production wires this to
 * `chatWithFailover`; tests inject a deterministic double.
 */
export interface ModelCaller {
  call(input: ModelCallInput): Promise<ModelCallOutput>;
}

/** User-selected location, any country/city/region worldwide. */
export interface LocaleLocation {
  country?: string;
  city?: string;
  region?: string;
}

/** One income band expressed in the locale's own currency. */
export interface IncomeBand {
  label: string;
  min: number;
  max: number;
}

/** Everything personas, currency, language and dialect derive from. */
export interface LocaleProfile {
  country: string;
  city: string | null;
  region: string | null;
  /** ISO 4217 currency code, e.g. "QAR", "GBP". */
  currency: string;
  languages: string[];
  dialect: string;
  incomeBands: IncomeBand[];
  demographics: string;
}

/** A scalar variable whose value is varied between simulation rounds. */
export interface SimulationVariable {
  name: string;
  baseline: number;
  scenario: number;
  unit?: string;
}

/** Normalized settings for one swarm run. */
export interface SimulationSettings {
  brief: string;
  docs: string[];
  /** Null when the user did not set a location; the pipeline infers it. */
  location: LocaleLocation | null;
  /** Default 12, max 20 unless explicitly raised; hard cap 100. */
  agents: number;
  rounds: number;
  variable: SimulationVariable | null;
  language: "auto" | "ar" | "en";
  seed: number;
}

/** A simulated persona. All locale-derived fields come from LocaleProfile. */
export interface Persona {
  id: string;
  name: string;
  bio: string;
  persona: string;
  age: number;
  gender: string;
  mbti: string;
  country: string;
  city: string | null;
  profession: string;
  interestedTopics: string[];
  currency: string;
  language: string;
  dialect: string;
  incomeBand: string;
}

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

/** Output of a full seed -> simulate -> report run. */
export interface PipelineResult {
  locale: LocaleProfile;
  personas: Persona[];
  log: SimulationLog;
  report: SwarmReport;
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
