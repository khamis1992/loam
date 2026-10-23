/**
 * Shared types for the MiroFish swarm simulation.
 *
 * Everything here is provider-neutral: the pipeline only knows about a brief,
 * optional documents, an optional user-selected location, and the
 * locale/entities/personas it derives from them. No country, currency or
 * language is hard-coded outside of test fixtures.
 *
 * The single model boundary is {@link ModelCaller}; `model.ts` owns the
 * provider-backed implementation and every stage talks to the same shape, so a
 * test can inject one deterministic caller for locale / persona / simulate /
 * report at once.
 */

/* -------------------------------------------------------------------------- */
/* Model boundary                                                             */
/* -------------------------------------------------------------------------- */

/** The stage a model call belongs to. Drives prompt construction and parsing. */
export type ModelRole = "locale" | "persona" | "simulate" | "report";

/** One request to the injectable model boundary. */
export interface ModelRequest {
  /** The stage that is asking: "locale" | "persona" | "simulate" | "report".
   *  Optional because a bare `{ system, prompt }` is still a valid call; stages
   *  set it explicitly so the pipeline can attribute every call and a test double
   *  can answer locale / persona / simulate / report separately. */
  role?: ModelRole;
  /** System instructions for the model. */
  system?: string;
  /** The full user prompt (brief, locale, variable value, feed, ...). */
  prompt: string;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Optional JSON schema for providers that support constrained output
   *  (passed through as the provider `format`). */
  jsonSchema?: Record<string, unknown>;
}

/** Raw text returned by the model boundary. */
export interface ModelResponse {
  content: string;
  model?: string;
}

/**
 * Backward-compatible alias for {@link ModelRequest}. Older code and the M7 e2e
 * fake describe one call as `{ role, system, prompt }`; the canonical shape lives
 * above and both names refer to the same contract.
 */
export type ModelCallInput = ModelRequest;

/** Backward-compatible alias for {@link ModelResponse} (`text` instead of `content`). */
export type ModelCallOutput = ModelResponse;

/**
 * The only model boundary the whole pipeline may use. `model.ts` owns the
 * provider-backed implementation; the seed / simulate / report stages all talk
 * to this shape, so a test can inject one deterministic caller for every stage
 * at once. `role` names the stage that is asking, which lets a test double
 * answer locale / persona / simulate / report separately.
 */
export interface ModelCaller {
  chat(request: ModelRequest): Promise<ModelResponse>;
}

/* -------------------------------------------------------------------------- */
/* M2: seed                                                                   */
/* -------------------------------------------------------------------------- */

/** A location the user explicitly selected. Any country/city/region worldwide. */
export interface LocationSetting {
  country?: string;
  city?: string;
  region?: string;
}

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

/** Resolved, locale-aware context used to build personas and prompts. */
export interface LocaleProfile {
  country: string;
  city?: string;
  region?: string;
  /** ISO 4217 currency code (e.g. "QAR", "GBP", "USD"). */
  currency: string;
  /** Languages in order of prominence (BCP-47 tags, e.g. ["ar-QA", "en"]). */
  languages: string[];
  /** Dialect / register note, e.g. "Gulf Arabic", "Egyptian Arabic". */
  dialect?: string;
  /** Income bands expressed in the local currency. */
  incomeBands: IncomeBand[];
  /**
   * Short demographic / market notes that shape persona diversity. A model may
   * answer with one sentence or with a list, so both shapes are accepted and
   * every consumer normalizes with {@link normalizeDemographics}.
   */
  demographics: string[] | string;
  /** IANA timezone name when known. */
  timezone?: string;
  /** Free-form note about how the locale was resolved. */
  notes?: string;
}

/**
 * Normalize {@link LocaleProfile.demographics} to a list. A model may answer
 * with a single sentence or with an array; both are legitimate, and this is the
 * one place that decides which form a consumer sees.
 */
export function normalizeDemographics(demographics: LocaleProfile["demographics"]): string[] {
  if (Array.isArray(demographics)) return demographics;
  const text = (demographics ?? "").trim();
  if (!text) return [];
  return text
    .split(/[;\n]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** The variable the user wants to stress, e.g. a price change. */
export interface SimulationVariable {
  name: string;
  baseline: string | number;
  scenario: string | number;
  /** Optional unit, e.g. "QAR / month". */
  unit?: string;
}

/** Full simulation settings accepted by the tool/HTTP layer. */
export interface SimulationSettings {
  brief: string;
  /** Optional uploaded document paths (text/markdown/pdf-text/office). */
  docs?: string[];
  /** Optional user-selected location; inferred from brief/docs when absent. */
  location?: LocationSetting | null;
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

/** One simulated customer/agent persona. */
export interface Persona {
  id: string;
  name: string;
  age: number;
  gender: string;
  /** Nationality/cultural background, realistic for the locale. */
  nationality: string;
  country: string;
  city?: string;
  /** Income band label from the locale profile. */
  incomeBand: string;
  /** Representative monthly income in local currency. */
  incomeAmount: number;
  currency: string;
  /** Household composition, e.g. "single", "family of four". */
  household: string;
  occupation: string;
  /** Primary channel (e.g. "Instagram", "X", "word of mouth"). */
  channel: string;
  /** Baseline attitude toward the product category, e.g. "skeptical". */
  attitude: string;
  /** Everyday habits that shape how they discover and buy. */
  habits: string[];
  /** Diet / consumption preferences when relevant. */
  diet?: string;
  /** Language the persona primarily uses. */
  language: string;
  dialect?: string;
  /** Short first-person bio used as the agent's system prompt seed. */
  bio: string;
  /** Free-form secondary trait label (e.g. "pragmatic subscriber"). */
  persona?: string;
  /** MBTI-style four-letter trait, when the seed produced one. */
  mbti?: string;
  /** Topics this persona cares about. */
  interestedTopics?: string[];
  /** Non-native languages the persona may also speak. */
  languages?: string[];
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

/* -------------------------------------------------------------------------- */
/* M3: simulation loop                                                        */
/* -------------------------------------------------------------------------- */

/** The six things a simulated agent can do in one round. */
export type AgentAction = "post" | "comment" | "share" | "ignore" | "buy" | "cancel";

/** Which arm of a variable comparison a turn belongs to. */
export type ArmId = "baseline" | "scenario";

/** The structured output of one agent-turn. */
export interface AgentTurnOutput {
  action: AgentAction;
  text: string;
  /** -1 (hostile) .. 1 (enthusiastic). */
  stance: number;
  /** 0 (will never buy) .. 1 (will buy immediately). */
  purchaseIntent: number;
  reasons: string[];
  /** Optional list of agent ids this post was shared with. */
  sharedWith?: string[];
}

/** One recorded agent-turn, including its model-call outcome. */
export interface AgentTurnEvent extends AgentTurnOutput {
  round: number;
  agentId: string;
  agentName: string;
  arm: ArmId;
  model?: string;
  latencyMs: number;
  /** False when the model call failed: the turn is logged, never fabricated. */
  ok: boolean;
  error?: string;
}

/** Who an agent follows and how much reach it has. */
export interface SocialGraph {
  follows: Map<string, string[]>;
  influence: Map<string, number>;
}

/** Opinion spread computed from one round's recorded outputs. */
export interface RoundMetrics {
  round: number;
  arm: ArmId;
  agentsActed: number;
  agentsSkipped: number;
  meanIntent: number;
  stanceDistribution: { negative: number; neutral: number; positive: number };
  actionCounts: Record<AgentAction, number>;
  shareCascades: { count: number; totalShares: number; maxDepth: number };
  topThemes: Array<{ theme: string; count: number }>;
}

/** One arm of a simulation (baseline or scenario). */
export interface SimulationArmResult {
  arm: ArmId;
  rounds: RoundMetrics[];
  turns: AgentTurnEvent[];
  calls: number;
  failures: number;
  skipped: number;
}

/** Baseline vs scenario comparison computed from the two arms' outputs. */
export interface ArmComparison {
  variable?: SimulationVariable;
  baselineMeanIntent: number;
  scenarioMeanIntent: number;
  intentDelta: number;
  baselinePositiveShare: number;
  scenarioPositiveShare: number;
  positiveShareDelta: number;
  baselineBuyRate: number;
  scenarioBuyRate: number;
  buyRateDelta: number;
}

/** Progress events emitted while a simulation runs. */
export type SimulationProgressEvent =
  | { type: "simulation_start"; sessionId: string; agents: number; rounds: number; arms: ArmId[] }
  | { type: "simulation_round_start"; sessionId: string; arm: ArmId; round: number; totalRounds: number }
  | { type: "simulation_agent"; sessionId: string; arm: ArmId; round: number; agentId: string; agentName: string; ok: boolean; action?: AgentAction; error?: string }
  | { type: "simulation_round"; sessionId: string; arm: ArmId; round: number; totalRounds: number; metrics: RoundMetrics }
  | { type: "simulation_arm_done"; sessionId: string; arm: ArmId; calls: number; failures: number }
  | { type: "simulation_done"; sessionId: string; agents: number; rounds: number; modelCalls: number; failures: number; comparison?: ArmComparison };

/** The complete result of a simulation run. */
export interface SimulationResult {
  sessionId: string;
  seed: number;
  agents: number;
  rounds: number;
  arms: SimulationArmResult[];
  comparison?: ArmComparison;
  logPath: string;
  metricsPath: string;
  modelCalls: number;
  failures: number;
}

/* -------------------------------------------------------------------------- */
/* M4: report stage                                                           */
/* -------------------------------------------------------------------------- */

/** One purchase-price fact derived from the seed's entity extraction. */
export interface ReportPrice {
  /** The amount as written in the brief, e.g. 1200. */
  amount: number;
  /** ISO 4217 currency code (from the locale, or the brief's price). */
  currency: string;
  /** Billing period when the brief gave one, e.g. "month". */
  period?: string;
  /** Free-text label, e.g. "new keto plan" when the brief named it. */
  label?: string;
}

/** The baseline-vs-scenario comparison of the varied variable. */
export interface ReportDelta {
  variable: SimulationVariable;
  /** Rendered arm values, e.g. "QAR 1,200" -> "QAR 1,450". */
  baselineLabel: string;
  scenarioLabel: string;
  /** Scenario minus baseline, in the same unit as the variable. */
  valueDelta: string;
  baselineIntent: number;
  scenarioIntent: number;
  intentDelta: number;
  baselineStance: number;
  scenarioStance: number;
  stanceDelta: number;
  /** Per-round mean intent for each arm, so a report can show the trend. */
  baselineIntentByRound: number[];
  scenarioIntentByRound: number[];
}

/** How one persona segment split between the two arms. */
export interface PersonaSegment {
  /** Segment key: persona id, or the persona's income band label. */
  key: string;
  /** Human-readable segment label (persona name or band). */
  label: string;
  count: number;
  baselineIntent: number;
  scenarioIntent: number;
  intentDelta: number;
  baselineStance: number;
  scenarioStance: number;
  /** Segment share of the whole swarm, 0..1. */
  share: number;
}

/** A verbatim quote cited by the report, taken from the recorded log. */
export interface ReportQuote {
  agentId: string;
  agentName: string;
  arm: ArmId;
  round: number;
  action: AgentAction;
  /** The persona's own text, verbatim from the log. */
  text: string;
  /** The persona's stance/purchase intent at the time, for context. */
  stance: number;
  purchaseIntent: number;
}

/** The numbers the report is allowed to claim, all computed from the log. */
export interface ReportMetrics {
  agents: number;
  rounds: number;
  modelCalls: number;
  failures: number;
  /** Mean purchase intent across every logged turn, 0..1. */
  purchaseIntent: number;
  /** Mean stance across every logged turn, -1..1. */
  meanStance: number;
  /** Share of turns whose stance is above +0.2, 0..1. */
  positiveShare: number;
  /** Share of turns that ended in a purchase, 0..1. */
  buyRate: number;
  /** Share of turns that ended in a cancellation, 0..1. */
  cancelRate: number;
  /** Per-round mean purchase intent, in round order. */
  intentByRound: number[];
  /** Per-round mean stance, in round order. */
  stanceByRound: number[];
  /** Action mix across every logged turn. */
  actionCounts: Record<AgentAction, number>;
}

/**
 * Version stamped into every fact block handed to the report model. A report
 * that quotes a number absent from its own facts block is rejected by
 * {@link validateReportNumbers}, so bumping this on a format change makes stale
 * caches visibly incompatible.
 */
export const REPORT_FACTS_VERSION = "mirofish-facts-v1";

/** A numbered note attached to a report (a follow-up answer, a correction, ...). */
export interface ReportNote {
  id: string;
  /** The question or request that produced the note. */
  question: string;
  /** The model-written answer, constrained to the same facts as the report. */
  answer: string;
  /** Numbers the answer is allowed to use. */
  allowedNumbers: string[];
  createdAt: string;
}

/** The final swarm report. Every number comes from the log, never a constant. */
export interface SwarmReport {
  version: string;
  title: string;
  markdown: string;
  summary: string;
  purchaseIntent: number;
  meanStance: number;
  rounds: number;
  agents: number;
  metrics: ReportMetrics;
  quotes: ReportQuote[];
  /** Local-currency prices the report talks about. */
  prices: ReportPrice[];
  /** Baseline-vs-scenario deltas, when a variable was varied. */
  delta?: ReportDelta;
  /** Per-persona-segment breakdown in the locale's own currency terms. */
  segments: PersonaSegment[];
  /** The disclaimer the report must carry. */
  disclaimer: string;
  /** Where the report markdown and the raw log were written. */
  paths: { markdown: string; log: string; metrics: string };
}

/** Output of a full seed -> simulate -> report run. */
export interface PipelineResult {
  settings: SimulationSettings;
  locale: LocaleProfile;
  entities: EntitySet;
  personas: Persona[];
  simulation: SimulationResult;
  report: SwarmReport;
  /** Every model call made, in order, for auditing. */
  modelCalls: Array<{ role: ModelRole; model?: string; ok: boolean; latencyMs: number; error?: string }>;
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
  concurrency?: number;
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
