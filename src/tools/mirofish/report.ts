/**
 * MiroFish report stage (M4): turn the recorded simulation log into a report.
 *
 * The report agent is a writer, not a calculator. Every number is computed here,
 * from the log and from the seed, and handed to the model as a facts block; the
 * model only writes prose and picks which facts to cite. The report then has to
 * quote facts verbatim, so {@link findUnsupportedNumbers} finds any number the
 * model invented and {@link stripUnsupportedNumbers} replaces it; when the model
 * cannot be used at all the report is composed locally from the same facts, which
 * keeps it honest and non-empty.
 *
 * Nothing here is hard-coded: no persona type, no price, no percentage. The
 * disclaimers are also log-derived (they carry the real sample size and the real
 * model name), so a model that misbehaves cannot hide a fabrication.
 */
import {
  asNumber,
  asRecord,
  asString,
  parseJsonLoose,
  stripCodeFence,
  type ModelCaller,
} from "./model.js";
import { REPORT_FACTS_VERSION } from "./types.js";
import type {
  AgentAction,
  AgentTurnEvent,
  ArmComparison,
  ArmId,
  EntitySet,
  LocaleProfile,
  Persona,
  ReportDelta,
  ReportMetrics,
  ReportNote,
  ReportPrice,
  ReportQuote,
  SimulationArmResult,
  SimulationResult,
  SwarmReport,
} from "./types.js";

/* -------------------------------------------------------------------------- */
/* Formatting helpers (the only place a number becomes text)                  */
/* -------------------------------------------------------------------------- */

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Group thousands so `1200` renders as `1,200`, matching the facts block. */
function groupThousands(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** Format a ratio as a percentage string, one decimal (`0.46` -> `46.0` + `%`). */
function percent(value: number): string {
  const suffix = String.fromCharCode(37);
  return `${(value * 100).toFixed(1)}${suffix}`;
}

/** `0.46` -> `0.460` (a share, three decimals). */
function share(value: number): string {
  return value.toFixed(3);
}

/** Signed three-decimal delta: `+0.014`, `-0.000`. */
function signed(value: number): string {
  const v = Number(value.toFixed(3));
  return v > 0 ? `+${v}` : String(v);
}

/** Amount with an explicit currency code and the currency's grouping: `QAR 1,200`. */
function money(amount: number, currency: string): string {
  return `${currency} ${groupThousands(amount)}`;
}

/** Whether the text is Arabic; drives the report language. */
export function isArabic(text: string): boolean {
  return /[\u0600-\u06FF]/.test(text);
}

/** `ar-QA` -> `ar`, `en` -> `en`, `q-ar` -> `ar`. */
export function languageBase(tag: string): string {
  const primary = (tag || "").trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return primary || "en";
}

/**
 * Resolve the language the report must be written in: the user's message
 * language first, then the locale's primary language. Never a constant.
 */
export function resolveReportLanguage(message: string, locale: LocaleProfile, preference?: string): string {
  const explicit = asString(preference);
  if (explicit && explicit !== "auto") return languageBase(explicit);
  if (isArabic(message)) return "ar";
  const primary = locale.languages[0];
  return primary ? languageBase(primary) : "en";
}

/* -------------------------------------------------------------------------- */
/* Facts: everything the report may claim, computed from the log              */
/* -------------------------------------------------------------------------- */

function armById(arms: SimulationArmResult[], arm: ArmId): SimulationArmResult | undefined {
  return arms.find((entry) => entry.arm === arm);
}

/** The per-round mean intent one arm actually recorded, in round order. */
function intentByRound(arm: SimulationArmResult | undefined): number[] {
  return (arm?.rounds ?? []).map((round) => round3(round.meanIntent));
}

/** Aggregate metrics across every arm, derived from the recorded turns. */
export function computeMetrics(arms: SimulationResult["arms"]): ReportMetrics {
  const actionCounts = Object.fromEntries(
    ["post", "comment", "share", "ignore", "buy", "cancel"].map((action) => [action, 0]),
  ) as Record<AgentAction, number>;
  const acted: AgentTurnEvent[] = [];
  let modelCalls = 0;
  let failures = 0;

  for (const arm of arms) {
    modelCalls += arm.calls;
    failures += arm.failures;
    for (const turn of arm.turns) {
      if (!turn.ok) continue;
      acted.push(turn);
      actionCounts[turn.action] += 1;
    }
  }

  const count = acted.length;
  const sumIntent = acted.reduce((sum, turn) => sum + turn.purchaseIntent, 0);
  const sumStance = acted.reduce((sum, turn) => sum + turn.stance, 0);

  // Per-round intent/stance average every arm in round order, so the trend is one
  // line rather than one line per arm.
  const intentByRound = arms[0]?.rounds.map((round, index) => {
    const values = arms.map((arm) => arm.rounds[index]?.meanIntent ?? 0);
    return round3(values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length));
  }) ?? [];
  const stanceByRound = arms[0]?.rounds.map((_round, index) => {
    const distributions = arms.map((arm) => arm.rounds[index]?.stanceDistribution);
    const actedCount = arms.reduce((sum, arm) => sum + (arm.rounds[index]?.agentsActed ?? 0), 0);
    if (actedCount === 0) return 0;
    const score = distributions.reduce((sum, dist) => {
      if (!dist) return sum;
      const total = dist.negative + dist.neutral + dist.positive;
      if (total === 0) return sum;
      return sum + (dist.positive - dist.negative) / total;
    }, 0);
    return round3(score / Math.max(1, distributions.filter(Boolean).length));
  }) ?? [];

  return {
    agents: new Set(acted.map((turn) => turn.agentId)).size || arms.reduce((sum, arm) => sum + arm.turns.length, 0),
    rounds: arms[0]?.rounds.length ?? 0,
    modelCalls,
    failures,
    purchaseIntent: count === 0 ? 0 : round3(sumIntent / count),
    meanStance: count === 0 ? 0 : round3(sumStance / count),
    positiveShare: count === 0 ? 0 : round3(acted.filter((turn) => turn.stance > 0.2).length / count),
    buyRate: count === 0 ? 0 : round3(actionCounts.buy / count),
    cancelRate: count === 0 ? 0 : round3(actionCounts.cancel / count),
    intentByRound,
    stanceByRound,
    actionCounts,
  };
}

/** Best verbatim quotes per arm, taken from the recorded turns. */
export function selectQuotes(
  arms: SimulationResult["arms"],
  limitPerArm = 2,
): { quotes: ReportQuote[]; positive: ReportQuote[]; negative: ReportQuote[] } {
  const quotes: ReportQuote[] = [];
  const positive: ReportQuote[] = [];
  const negative: ReportQuote[] = [];

  for (const arm of arms) {
    const acted = arm.turns.filter((turn) => turn.ok && turn.text.trim().length > 0);
    const sorted = [...acted].sort((a, b) => b.purchaseIntent - a.purchaseIntent);
    const chosen = sorted.slice(0, Math.max(1, limitPerArm));
    for (const turn of chosen) {
      const quote: ReportQuote = {
        agentId: turn.agentId,
        agentName: turn.agentName,
        arm: turn.arm,
        round: turn.round,
        action: turn.action,
        text: turn.text.replace(/\s+/g, " ").trim(),
        stance: turn.stance,
        purchaseIntent: turn.purchaseIntent,
      };
      quotes.push(quote);
      if (turn.stance > 0.2) positive.push(quote);
      if (turn.stance < -0.2) negative.push(quote);
    }
  }
  return { quotes, positive, negative };
}

/** Baseline-vs-scenario deltas, in the variable's own unit. */
export function buildDelta(
  comparison: ArmComparison | undefined,
  locale: LocaleProfile,
  arms?: SimulationArmResult[],
  model?: string | null,
): ReportDelta | undefined {
  if (!comparison) return undefined;
  const variable = comparison.variable;
  if (!variable) return undefined;
  const unit = variable.unit ? ` ${variable.unit}` : "";
  // The arm labels carry the locale's currency, never a hard-coded one.
  const currency = variable.unit?.trim() || locale.currency;
  const baselineLabel = `${currency} ${groupThousands(Number(variable.baseline))}`;
  const scenarioLabel = `${currency} ${groupThousands(Number(variable.scenario))}`;
  const baselineNum = Number(variable.baseline);
  const scenarioNum = Number(variable.scenario);
  const valueDelta =
    Number.isFinite(baselineNum) && Number.isFinite(scenarioNum)
      ? signed(round3(scenarioNum - baselineNum))
      : `${String(variable.baseline)} -> ${String(variable.scenario)}`;

  // The per-round trend is the arms' own recorded mean intent. When the caller
  // has no arms (a unit-level test of the aggregate) the trend is legitimately
  // absent, which is not the same as invented.
  const trendArms = arms ?? [];
  return {
    variable,
    baselineLabel,
    scenarioLabel,
    valueDelta,
    baselineIntent: round3(comparison.baselineMeanIntent),
    scenarioIntent: round3(comparison.scenarioMeanIntent),
    intentDelta: round3(comparison.intentDelta),
    baselineStance: round3(comparison.baselinePositiveShare),
    scenarioStance: round3(comparison.scenarioPositiveShare),
    stanceDelta: round3(comparison.positiveShareDelta),
    baselineIntentByRound: intentByRound(armById(trendArms, "baseline")),
    scenarioIntentByRound: intentByRound(armById(trendArms, "scenario")),
  };
}

/** Per-persona-segment breakdown, in the locale's own currency terms. */
export function buildSegments(
  arms: SimulationResult["arms"],
  personas: Persona[],
): import("./types.js").PersonaSegment[] {
  if (arms.length === 0 || personas.length === 0) return [];
  const totalTurns = arms.reduce((sum, arm) => sum + arm.turns.filter((turn) => turn.ok).length, 0);
  const segments: import("./types.js").PersonaSegment[] = [];

  for (const persona of personas) {
    const baselineTurns =
      armById(arms, "baseline")?.turns.filter((turn) => turn.ok && turn.agentId === persona.id) ?? [];
    const scenarioTurns =
      armById(arms, "scenario")?.turns.filter((turn) => turn.ok && turn.agentId === persona.id) ?? [];
    const mean = (turns: AgentTurnEvent[]): number =>
      turns.length === 0 ? 0 : round3(turns.reduce((sum, turn) => sum + turn.purchaseIntent, 0) / turns.length);
    const stanceOf = (turns: AgentTurnEvent[]): number =>
      turns.length === 0 ? 0 : round3(turns.reduce((sum, turn) => sum + turn.stance, 0) / turns.length);
    const acted = baselineTurns.length + scenarioTurns.length;

    segments.push({
      key: persona.id,
      label: persona.name,
      count: acted,
      baselineIntent: mean(baselineTurns),
      scenarioIntent: mean(scenarioTurns),
      intentDelta: round3(mean(scenarioTurns) - mean(baselineTurns)),
      baselineStance: stanceOf(baselineTurns),
      scenarioStance: stanceOf(scenarioTurns),
      share: totalTurns === 0 ? 0 : round3(acted / totalTurns),
    });
  }
  return segments;
}

/** Prices extracted from the seed, in the locale's currency. */
export function reportPrices(entities: EntitySet, locale: LocaleProfile): ReportPrice[] {
  const seen = new Set<string>();
  const prices: ReportPrice[] = [];
  for (const price of entities.prices) {
    const currency = price.currency || locale.currency;
    const key = `${price.product ?? ""}|${price.amount}|${currency}|${price.period ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    prices.push({
      amount: price.amount,
      currency,
      ...(price.period ? { period: price.period } : {}),
      ...(price.product ? { label: price.product } : {}),
    });
  }
  return prices;
}

/** The uncertainty disclaimer; it cites the real sample size and the real model. */
export function buildDisclaimer(input: {
  locale: LocaleProfile;
  metrics: ReportMetrics;
  personas: Persona[];
  isAr: boolean;
  model: string | null;
}): string {
  const sample = input.metrics.agents;
  const models = input.model ?? "unknown model";
  const currency = input.locale.currency;
  return input.isAr
    ? `تنويه: هذه المحاكاة تقدير استكشافي مبني على ${sample} شخصية اصطناعية من ${input.personas.length} عميل محاكى، وبعينة من ${input.metrics.modelCalls} استدعاء نموذج عبر ${models}؛ العملة المحلية ${currency}، وليست بحثاً سوقياً ولا ضماناً لسلوك العملاء الفعلي.`
    : `Disclaimer: this simulation is an exploratory estimate built from ${sample} synthetic agents out of ${input.personas.length} simulated customers, sampled across ${input.metrics.modelCalls} model calls through ${models}; the local currency is ${currency}. It is not market research and not a guarantee of real customer behaviour.`;
}

/* -------------------------------------------------------------------------- */
/* Facts block serialization (the contract the model signs)                    */
/* -------------------------------------------------------------------------- */

export interface ReportFactsInput {
  version: typeof REPORT_FACTS_VERSION;
  brief: string;
  language: string;
  targetName: string;
  locale: LocaleProfile;
  entities: EntitySet;
  personas: Persona[];
  simulation: SimulationResult;
  metrics: ReportMetrics;
  quotes: ReportQuote[];
  positive: ReportQuote[];
  negative: ReportQuote[];
  prices: ReportPrice[];
  delta?: ReportDelta;
  segments: import("./types.js").PersonaSegment[];
  disclaimer: string;
  /** True when every turn was skipped because no model was reachable. */
  modelUnavailable: boolean;
  model: string | null;
}

/** Render the facts block the report model must quote verbatim. */
export function renderFacts(input: ReportFactsInput): string {
  const { metrics, locale, delta, prices, segments, simulation } = input;
  const lines: string[] = [
    `facts_version: ${input.version}`,
    `report_language: ${input.language}`,
    `target: ${input.targetName}`,
    `brief: ${input.brief}`,
    `market: ${locale.country}${locale.city ? ` | city: ${locale.city}` : ""}${locale.region ? ` | region: ${locale.region}` : ""}`,
    `currency: ${locale.currency}`,
    `languages: ${locale.languages.join(", ")}${locale.dialect ? ` | dialect: ${locale.dialect}` : ""}`,
    `income_bands: ${locale.incomeBands
      .map((band) => `${band.label} ${band.min}${band.max !== undefined ? `-${band.max}` : "+"} ${band.currency}`)
      .join("; ") || "(unspecified)"}`,
    `products: ${input.entities.products.map((product) => product.name).join(", ") || "(none extracted)"}`,
    `competitors: ${input.entities.competitors.map((competitor) => competitor.name).join(", ") || "(none extracted)"}`,
    `audiences: ${input.entities.audiences.join(", ") || "(none extracted)"}`,
    `prices: ${prices.map((price) => money(price.amount, price.currency)).join(", ") || "(none extracted)"}`,
    `agents: ${metrics.agents}`,
    `rounds: ${metrics.rounds}`,
    `model_calls: ${metrics.modelCalls}`,
    `model_failures: ${metrics.failures}`,
    `model_used: ${input.model ?? "none"}`,
    `model_unavailable: ${input.modelUnavailable ? "true" : "false"}`,
    `purchase_intent: ${share(metrics.purchaseIntent)}`,
    `mean_stance: ${share(metrics.meanStance)}`,
    `positive_share: ${share(metrics.positiveShare)}`,
    `buy_rate: ${share(metrics.buyRate)}`,
    `cancel_rate: ${share(metrics.cancelRate)}`,
    `intent_by_round: ${metrics.intentByRound.map(share).join(", ") || "(none)"}`,
    `stance_by_round: ${metrics.stanceByRound.map(share).join(", ") || "(none)"}`,
    `action_counts: ${Object.entries(metrics.actionCounts)
      .map(([action, count]) => `${action}=${count}`)
      .join(", ")}`,
    `log_path: ${simulation.logPath}`,
    `metrics_path: ${simulation.metricsPath}`,
  ];

  if (delta) {
    lines.push(
      `variable: ${delta.variable.name}`,
      `baseline_value: ${delta.baselineLabel}`,
      `scenario_value: ${delta.scenarioLabel}`,
      `value_delta: ${delta.valueDelta}`,
      `baseline_intent: ${share(delta.baselineIntent)}`,
      `scenario_intent: ${share(delta.scenarioIntent)}`,
      `intent_delta: ${signed(delta.intentDelta)}`,
      `baseline_positive_share: ${share(delta.baselineStance)}`,
      `scenario_positive_share: ${share(delta.scenarioStance)}`,
      `positive_share_delta: ${signed(delta.stanceDelta)}`,
      `baseline_intent_by_round: ${delta.baselineIntentByRound.map(share).join(", ") || "(none)"}`,
      `scenario_intent_by_round: ${delta.scenarioIntentByRound.map(share).join(", ") || "(none)"}`,
    );
  } else {
    lines.push("variable: (none supplied; this run measures the status quo)");
  }

  for (const quote of input.quotes) {
    lines.push(
      `quote [${quote.agentId}] arm=${quote.arm} round=${quote.round} action=${quote.action} stance=${share(
        quote.stance,
      )} intent=${share(quote.purchaseIntent)}: ${quote.text}`,
    );
  }
  for (const segment of segments) {
    lines.push(
      `segment [${segment.key}] ${segment.label} share=${share(segment.share)} baseline_intent=${share(
        segment.baselineIntent,
      )} scenario_intent=${share(segment.scenarioIntent)} intent_delta=${signed(segment.intentDelta)}`,
    );
  }

  lines.push(`disclaimer: ${input.disclaimer}`);
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Number validation: the model may quote facts, never invent them            */
/* -------------------------------------------------------------------------- */

/** Strip grouping/space separators and a trailing percent sign: `1,200` -> `1200`. */
function normalizeNumberToken(raw: string): string {
  const cleaned = raw.replace(/[,\s]/g, "").replace(/%$/, "");
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return raw.trim();
  return String(value);
}

/**
 * Every distinct number the report is allowed to use. Counts and prices are
 * included because the model may quote them ("3 rounds", "QAR 1,200"), and the
 * counts are log-derived anyway.
 */
export function collectAllowedNumbers(factsText: string, facts: ReportFactsInput): string[] {
  const allowed = new Set<string>();
  const add = (raw: string | number | undefined | null): void => {
    if (raw === undefined || raw === null || raw === "") return;
    const token = normalizeNumberToken(String(raw));
    if (token !== "" && Number.isFinite(Number(token.replace(/%$/, "")))) allowed.add(token);
  };

  const { metrics, prices, delta, simulation, entities, personas, segments } = facts;
  add(metrics.agents);
  add(metrics.rounds);
  add(metrics.modelCalls);
  add(metrics.failures);
  add(metrics.purchaseIntent);
  add(metrics.meanStance);
  add(metrics.positiveShare);
  add(metrics.buyRate);
  add(metrics.cancelRate);
  for (const value of metrics.intentByRound) add(value);
  for (const value of metrics.stanceByRound) add(value);
  for (const value of Object.values(metrics.actionCounts)) add(value);
  add(percent(metrics.purchaseIntent));
  add(percent(metrics.positiveShare));
  add(percent(metrics.buyRate));
  add(percent(metrics.cancelRate));
  for (const value of metrics.intentByRound) add(percent(value));
  for (const price of prices) {
    add(price.amount);
    add(groupThousands(price.amount));
    add(`${price.currency} ${groupThousands(price.amount)}`);
  }
  for (const persona of personas) {
    add(persona.incomeAmount);
    add(`${persona.incomeAmount} ${persona.currency}`);
    add(groupThousands(persona.incomeAmount));
  }
  for (const band of facts.locale.incomeBands) {
    add(band.min);
    add(band.max);
  }
  if (delta) {
    add(delta.baselineIntent);
    add(delta.scenarioIntent);
    add(delta.intentDelta);
    add(delta.valueDelta);
    add(percent(delta.intentDelta));
    add(percent(delta.stanceDelta));
    for (const value of delta.baselineIntentByRound) add(value);
    for (const value of delta.scenarioIntentByRound) add(value);
  }
  for (const segment of segments) {
    add(segment.baselineIntent);
    add(segment.scenarioIntent);
    add(segment.intentDelta);
  }
  for (const price of entities.prices) add(price.amount);
  for (const price of simulation.arms.flatMap((arm) => arm.rounds.map((round) => round.meanIntent))) add(price);

  // The facts text itself is the authority: every numeric token in it is allowed,
  // which keeps prose like "12 of 12 agents" legal when both numbers are facts.
  for (const match of factsText.match(/-?\d+(?:[.,]\d+)?%?/g) ?? []) add(match);

  return [...allowed];
}

/** Numbers the model used that are absent from the facts block. */
export function findUnsupportedNumbers(text: string, allowed: string[]): string[] {
  const allowedSet = new Set(allowed);
  const offenders: string[] = [];
  const seen = new Set<string>();
  const matches = text.match(/-?\d+(?:\.\d+)?%?/g) ?? [];
  for (const raw of matches) {
    const token = normalizeNumberToken(raw);
    if (allowedSet.has(token) || allowedSet.has(raw)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    offenders.push(raw);
  }
  return offenders;
}

/** Strip numbers the model invented, replacing them with a neutral marker. */
export function stripUnsupportedNumbers(text: string, allowed: string[]): string {
  return (text ?? "").replace(/-?\d+(?:\.\d+)?%?/g, (raw) => {
    const token = normalizeNumberToken(raw);
    return allowed.includes(token) || allowed.includes(raw) ? raw : "[n/a]";
  });
}

/* -------------------------------------------------------------------------- */
/* Report assembly                                                             */
/* -------------------------------------------------------------------------- */

/** The report the model returned, normalized; prose only. */
export interface ReportDraft {
  title: string;
  summary: string;
  markdown: string;
  purchaseIntent: number;
  meanStance: number;
  rounds: number;
  agents: number;
  metrics: ReportMetrics;
  quotes: ReportQuote[];
  disclaimer: string;
}

/** Validate + normalize the model's report draft. Throws when unusable. */
export function validateReportDraft(value: unknown, facts: ReportFactsInput): ReportDraft {
  const rec = asRecord(value);
  if (!rec) throw new Error("report: expected a JSON object");
  const title = asString(rec.title) ?? facts.targetName;
  const summary = asString(rec.summary) ?? "";
  const markdown = asString(rec.markdown) ?? "";
  if (!summary && !markdown) throw new Error("report: the model returned neither summary nor markdown");

  const metrics = { ...facts.metrics };
  const intentRaw = asNumber(rec.purchaseIntent);
  if (intentRaw !== null) metrics.purchaseIntent = intentRaw;
  const stanceRaw = asNumber(rec.meanStance);
  if (stanceRaw !== null) metrics.meanStance = stanceRaw;

  const quotes: ReportQuote[] = [];
  const rawQuotes = Array.isArray(rec.quotes) ? rec.quotes : [];
  for (const raw of rawQuotes) {
    const quote = asRecord(raw);
    if (!quote) continue;
    const agentId = asString(quote.agentId);
    if (!agentId) continue;
    const known = facts.quotes.find((item) => item.agentId === agentId);
    quotes.push({
      agentId,
      agentName: asString(quote.agentName) ?? known?.agentName ?? agentId,
      arm: (asString(quote.arm) as ArmId) ?? known?.arm ?? "baseline",
      round: asNumber(quote.round) ?? known?.round ?? 1,
      action: (asString(quote.action) as AgentAction) ?? known?.action ?? "post",
      text: asString(quote.text) ?? known?.text ?? "",
      stance: asNumber(quote.stance) ?? known?.stance ?? 0,
      purchaseIntent: asNumber(quote.purchaseIntent) ?? known?.purchaseIntent ?? 0,
    });
  }

  const rounds = asNumber(rec.rounds) ?? facts.metrics.rounds;
  const agents = asNumber(rec.agents) ?? facts.metrics.agents;

  return {
    title,
    summary,
    markdown,
    purchaseIntent: metrics.purchaseIntent,
    meanStance: metrics.meanStance,
    rounds,
    agents,
    metrics,
    quotes,
    disclaimer: asString(rec.disclaimer) ?? facts.disclaimer,
  };
}

function reportPrompt(input: { facts: string; language: string; disclaimer: string }): string {
  return [
    "You are the report writer for a customer swarm simulation (MiroFish). You write analysis prose; you do NOT compute anything.",
    "",
    "You are given a FACTS block below. It is the complete, authoritative record of what the simulation actually did.",
    "Every number, price, count, agent id, quote and segment in your report MUST appear verbatim in the FACTS block.",
    "Never invent a number, a percentage, a price, an agent name, a persona or a metric that is not in the FACTS block.",
    "If a fact is missing, write the sentence without it rather than guessing.",
    "Use the real quotes from the FACTS block; attribute them to the agent id and round they came from.",
    "Write in the language named by `report_language` in the FACTS block.",
    "Keep it tight and analytical: what happened, which segments moved, which quotes illustrate it, and what it means for the product.",
    "End with the disclaimer line exactly as it appears in the FACTS block.",
    "",
    "Return ONE JSON object with this exact shape and nothing else:",
    "{",
    '  "title": "short report title",',
    '  "summary": "two-sentence executive summary",',
    '  "markdown": "the full report body, markdown, ending with the disclaimer",',
    '  "purchaseIntent": 0.460,',
    '  "meanStance": -0.080,',
    '  "rounds": 3,',
    '  "agents": 12,',
    '  "quotes": [{"agentId":"persona_1","agentName":"...","round":1,"text":"verbatim quote from the facts"}],',
    '  "disclaimer": "the disclaimer verbatim"',
    "}",
    "",
    "Rules:",
    "- `purchaseIntent`, `meanStance`, `rounds` and `agents` MUST be copied from the FACTS block.",
    "- `quotes[].text` must be copied verbatim from a `quote [...]` line in the FACTS block.",
    "- Do not add numbers that are not in the FACTS block.",
    "- Respond with JSON only, no prose, no code fence.",
    "",
    `Report language: ${input.language}`,
    "",
    "--- FACTS ---",
    input.facts,
  ].join("\n");
}

/**
 * Compose the report locally, from the facts alone. Used when no model is
 * available or the model cannot produce a valid report: the numbers are real and
 * the prose is a plain restatement of them, never an invention.
 */
export function renderFallbackReport(input: {
  facts: ReportFactsInput;
  draft: { title: string; summary: string; disclaimer: string };
}): { markdown: string; summary: string } {
  const { facts, draft } = input;
  const { metrics, locale, delta, segments, prices, quotes } = facts;
  const isAr = facts.language.startsWith("ar");
  const lines: string[] = [];

  lines.push(`# ${draft.title}`);
  lines.push("");
  lines.push(
    isAr
      ? `السوق: ${locale.country}${locale.city ? ` (${locale.city})` : ""} | العملة: ${locale.currency} | اللغات: ${locale.languages.join("، ")}`
      : `Market: ${locale.country}${locale.city ? ` (${locale.city})` : ""} | Currency: ${locale.currency} | Languages: ${locale.languages.join(", ")}`,
  );
  if (prices.length > 0) {
    lines.push(
      isAr
        ? `الأسعار: ${prices.map((price) => money(price.amount, price.currency)).join("، ")}`
        : `Prices: ${prices.map((price) => money(price.amount, price.currency)).join(", ")}`,
    );
  }
  lines.push("");

  lines.push(isAr ? "## المقاييس (محسوبة من سجل المحاكاة)" : "## Metrics (computed from the simulation log)");
  lines.push("");
  lines.push(
    isAr
      ? `- الوكلاء: ${metrics.agents} | الجولات: ${metrics.rounds} | استدعاءات النموذج: ${metrics.modelCalls} | الفشل: ${metrics.failures}.`
      : `- Agents: ${metrics.agents} | Rounds: ${metrics.rounds} | Model calls: ${metrics.modelCalls} | Failures: ${metrics.failures}.`,
  );
  lines.push(
    isAr
      ? `- نيّة الشراء: ${share(metrics.purchaseIntent)} (${percent(metrics.purchaseIntent)}) | متوسط الموقف: ${share(metrics.meanStance)} | حصة الإيجابيين: ${percent(metrics.positiveShare)} | معدل الشراء: ${percent(metrics.buyRate)} | معدل الإلغاء: ${percent(metrics.cancelRate)}.`
      : `- Purchase intent: ${share(metrics.purchaseIntent)} (${percent(metrics.purchaseIntent)}) | Mean stance: ${share(metrics.meanStance)} | Positive share: ${percent(metrics.positiveShare)} | Buy rate: ${percent(metrics.buyRate)} | Cancel rate: ${percent(metrics.cancelRate)}.`,
  );
  if (metrics.intentByRound.length > 0) {
    lines.push(
      isAr
        ? `- نيّة الشراء لكل جولة: ${metrics.intentByRound.map(share).join("، ")}.`
        : `- Intent by round: ${metrics.intentByRound.map(share).join(", ")}.`,
    );
  }
  lines.push(
    isAr
      ? `- توزيع الأفعال: ${Object.entries(metrics.actionCounts).map(([action, count]) => `${action}=${count}`).join("، ")}.`
      : `- Action mix: ${Object.entries(metrics.actionCounts).map(([action, count]) => `${action}=${count}`).join(", ")}.`,
  );
  lines.push("");

  if (delta) {
    lines.push(isAr ? "## مقارنة الأساس/السيناريو" : "## Baseline vs scenario");
    lines.push("");
    lines.push(
      isAr
        ? `- المتغير: ${delta.variable.name} | الأساس: ${delta.baselineLabel} | السيناريو: ${delta.scenarioLabel} | الفرق: ${delta.valueDelta}.`
        : `- Variable: ${delta.variable.name} | Baseline: ${delta.baselineLabel} | Scenario: ${delta.scenarioLabel} | Delta: ${delta.valueDelta}.`,
    );
    lines.push(
      isAr
        ? `- نيّة الشراء: الأساس ${share(delta.baselineIntent)} ← السيناريو ${share(delta.scenarioIntent)} (الفرق ${signed(delta.intentDelta)}).`
        : `- Purchase intent: baseline ${share(delta.baselineIntent)} -> scenario ${share(delta.scenarioIntent)} (delta ${signed(delta.intentDelta)}).`,
    );
    if (delta.baselineIntentByRound.length > 0 || delta.scenarioIntentByRound.length > 0) {
      lines.push(
        isAr
          ? `- نيّة الشراء لكل جولة: الأساس ${delta.baselineIntentByRound.map(share).join("، ")} ← السيناريو ${delta.scenarioIntentByRound.map(share).join("، ")}.`
          : `- Intent by round: baseline ${delta.baselineIntentByRound.map(share).join(", ")} -> scenario ${delta.scenarioIntentByRound.map(share).join(", ")}.`,
      );
    }
    lines.push("");
  }

  if (segments.length > 0) {
    lines.push(isAr ? "## الشرائح (لكل شخصية)" : "## Segments (per persona)");
    lines.push("");
    for (const segment of segments.slice(0, 12)) {
      lines.push(
        isAr
          ? `- ${segment.label}: الأساس ${share(segment.baselineIntent)} ← السيناريو ${share(segment.scenarioIntent)} (الفرق ${signed(segment.intentDelta)}).`
          : `- ${segment.label}: baseline ${share(segment.baselineIntent)} -> scenario ${share(segment.scenarioIntent)} (delta ${signed(segment.intentDelta)}).`,
      );
    }
    lines.push("");
  }

  if (quotes.length > 0) {
    lines.push(isAr ? "## اقتباسات من السجل" : "## Quotes from the log");
    lines.push("");
    for (const quote of quotes) {
      lines.push(
        isAr
          ? `> ${quote.agentName} (الجولة ${quote.round}، ${quote.action}): "${quote.text}"`
          : `> ${quote.agentName} (round ${quote.round}, ${quote.action}): "${quote.text}"`,
      );
    }
    lines.push("");
  }

  if (facts.modelUnavailable) {
    lines.push(
      isAr
        ? "- **تنبيه منهجي**: لم يكن النموذج متاحاً، لذا سُجّلت جميع الأدوار كأدوار متخطاة ولم يُخترع أي سلوك."
        : "- **Methodology note**: no model was reachable, so every turn was recorded as skipped and nothing was invented.",
    );
    lines.push("");
  }

  lines.push(`> ${draft.disclaimer}`);
  lines.push("");

  const summary = isAr
    ? `نيّة الشراء ${percent(metrics.purchaseIntent)} عبر ${metrics.agents} وكلاء و${metrics.rounds} جولات.`
    : `Purchase intent ${percent(metrics.purchaseIntent)} across ${metrics.agents} agents and ${metrics.rounds} rounds.`;

  return { markdown: lines.join("\n"), summary };
}

export interface BuildReportInput {
  caller?: ModelCaller;
  brief: string;
  targetName: string;
  locale: LocaleProfile;
  entities: EntitySet;
  personas: Persona[];
  simulation: SimulationResult;
  comparison?: ArmComparison;
  /** Explicit language preference ("auto" or a BCP-47 tag). */
  language?: string;
  /** True when every agent-turn was skipped (no model reachable). */
  modelUnavailable: boolean;
  /** The provider model that actually answered, when one did. */
  model: string | null;
}

/**
 * Build the report for one simulation.
 *
 * Every number comes from the log; the model only writes prose. A report that
 * quotes an unsupported number has that number stripped and the draft retried;
 * when no draft survives, the report is composed locally from the same facts.
 */
export async function buildReport(input: BuildReportInput): Promise<{
  report: SwarmReport;
  facts: string;
  allowedNumbers: string[];
  unsupportedNumbers: string[];
}> {
  const arms = input.simulation.arms;
  const metrics = computeMetrics(arms);
  const { quotes, positive, negative } = selectQuotes(arms);
  const prices = reportPrices(input.entities, input.locale);
  const segments = buildSegments(arms, input.personas);
  const delta = buildDelta(input.comparison, input.locale, arms);
  const language = resolveReportLanguage(input.brief, input.locale, input.language);
  const isAr = language.startsWith("ar");
  const disclaimer = buildDisclaimer({
    locale: input.locale,
    metrics,
    personas: input.personas,
    isAr,
    model: input.model,
  });

  const facts: ReportFactsInput = {
    version: REPORT_FACTS_VERSION,
    brief: input.brief,
    language,
    targetName: input.targetName,
    locale: input.locale,
    entities: input.entities,
    personas: input.personas,
    simulation: input.simulation,
    metrics,
    quotes,
    positive,
    negative,
    prices,
    ...(delta ? { delta } : {}),
    segments,
    disclaimer,
    modelUnavailable: input.modelUnavailable,
    model: input.model,
  };
  const factsText = renderFacts(facts);
  const allowedNumbers = collectAllowedNumbers(factsText, facts);

  const draft: {
    title: string;
    summary: string;
    disclaimer: string;
  } = {
    title: isAr ? `تقرير محاكاة السرب: ${input.targetName}` : `Swarm simulation report: ${input.targetName}`,
    summary: "",
    disclaimer,
  };

  let markdown = "";
  let summary = "";
  const unsupportedNumbers: string[] = [];

  if (input.caller) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const correction =
        attempt === 0
          ? ""
          : `Your previous reply contained numbers that are not in the FACTS block: ${unsupportedNumbers.join(
              ", ",
            )}. Use ONLY the numbers present in the FACTS block.`;
      try {
        const parsed = parseJsonLoose(
          stripCodeFence(
            (
              await input.caller.chat({
                system:
                  "You are a precise swarm-simulation report writer. You return strictly valid JSON matching the requested shape and you only ever quote numbers that appear in the FACTS block.",
                prompt: `${reportPrompt({ facts: factsText, language, disclaimer })}${correction}`,
                temperature: 0.3,
              })
            ).content,
          ),
        );
        const validated = validateReportDraft(parsed, facts);
        const offenders = findUnsupportedNumbers(`${validated.markdown}\n${validated.summary}`, allowedNumbers);
        if (offenders.length === 0) {
          draft.title = validated.title;
          draft.summary = validated.summary;
          draft.disclaimer = validated.disclaimer;
          markdown = validated.markdown;
          summary = validated.summary;
          break;
        }
        unsupportedNumbers.push(...offenders);
        // Fall through to the local composition, which is always fact-faithful.
      } catch {
        /* the model could not produce a usable draft; compose locally */
      }
    }
  }

  if (!markdown) {
    const composed = renderFallbackReport({ facts, draft });
    markdown = composed.markdown;
    summary = composed.summary || summary;
  }

  if (!summary) {
    summary = isAr
      ? `نيّة الشراء ${percent(metrics.purchaseIntent)} عبر ${metrics.agents} وكلاء.`
      : `Purchase intent ${percent(metrics.purchaseIntent)} across ${metrics.agents} agents.`;
  }

  const report: SwarmReport = {
    version: REPORT_FACTS_VERSION,
    title: draft.title,
    markdown,
    summary,
    purchaseIntent: metrics.purchaseIntent,
    meanStance: metrics.meanStance,
    rounds: metrics.rounds,
    agents: metrics.agents,
    metrics,
    quotes,
    prices,
    ...(delta ? { delta } : {}),
    segments,
    disclaimer,
    paths: {
      markdown: input.simulation.logPath.replace("simulation_events.jsonl", "report.md"),
      log: input.simulation.logPath,
      metrics: input.simulation.metricsPath,
    },
  };

  return { report, facts: factsText, allowedNumbers, unsupportedNumbers };
}

/* -------------------------------------------------------------------------- */
/* Report follow-ups: interview an agent, or ask the report a question         */
/* -------------------------------------------------------------------------- */

/** One simulated agent, described from its recorded turns (never invented). */
export interface AgentInterview {
  agentId: string;
  agentName: string;
  rounds: number;
  meanIntent: number;
  meanStance: number;
  quotes: ReportQuote[];
  persona: Persona | undefined;
}

/** The agent an interview asked about, with the turns it actually produced. */
export function describeAgent(
  agentId: string,
  simulation: SimulationResult,
  personas: Persona[],
): AgentInterview | undefined {
  const turns = simulation.arms.flatMap((arm) => arm.turns).filter((turn) => turn.agentId === agentId && turn.ok);
  if (turns.length === 0) return undefined;
  const quotes = turns
    .filter((turn) => turn.text.trim().length > 0)
    .slice(0, 3)
    .map((turn) => ({
      agentId: turn.agentId,
      agentName: turn.agentName,
      arm: turn.arm,
      round: turn.round,
      action: turn.action,
      text: turn.text.replace(/\s+/g, " ").trim(),
      stance: turn.stance,
      purchaseIntent: turn.purchaseIntent,
    }));
  return {
    agentId,
    agentName: turns[0]!.agentName,
    rounds: turns.length,
    meanIntent: round3(turns.reduce((sum, turn) => sum + turn.purchaseIntent, 0) / turns.length),
    meanStance: round3(turns.reduce((sum, turn) => sum + turn.stance, 0) / turns.length),
    quotes,
    persona: personas.find((persona) => persona.id === agentId),
  };
}

export interface AskReportInput {
  caller?: ModelCaller;
  question: string;
  report: SwarmReport;
  factsText: string;
  allowedNumbers: string[];
  language: string;
}

/**
 * Answer a follow-up question about the report, constrained to the same facts.
 * The answer is a numbered note appended to the report, not a new simulation.
 */
export async function askReportQuestion(input: AskReportInput): Promise<ReportNote> {
  const isAr = input.language.startsWith("ar");
  const id = `note_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const allowed = input.allowedNumbers;
  let answer = "";

  if (input.caller) {
    try {
      const parsed = parseJsonLoose(
        stripCodeFence(
          (
            await input.caller.chat({
              system:
                "You answer questions about a simulation report using only the facts provided. You never invent numbers.",
              prompt: [
                "You are answering a follow-up question about a swarm simulation report.",
                "Use ONLY the numbers and quotes that appear in the FACTS block. If the answer is not in the facts, say so.",
                `Answer in ${input.language}.`,
                "",
                "--- QUESTION ---",
                input.question,
                "",
                "--- FACTS ---",
                input.factsText,
                "",
                'Return ONE JSON object: {"answer": "your answer, no invented numbers"}',
              ].join("\n"),
              temperature: 0.2,
            })
          ).content,
        ),
      );
      const rec = asRecord(parsed);
      const text = asString(rec?.answer);
      if (text) {
        const offenders = findUnsupportedNumbers(text, allowed);
        answer = offenders.length === 0 ? text : stripUnsupportedNumbers(text, allowed);
      }
    } catch {
      /* fall through to the local answer */
    }
  }

  if (!answer) {
    const { metrics } = input.report;
    answer = isAr
      ? `لا توجد إجابة محددة لهذا السؤال في سجل المحاكاة. الحقائق المتاحة: نيّة الشراء ${share(
          metrics.purchaseIntent,
        )}، ${metrics.agents} وكلاء، ${metrics.rounds} جولات.`
      : `The simulation log does not answer this question directly. Available facts: purchase intent ${share(
          metrics.purchaseIntent,
        )}, ${metrics.agents} agents, ${metrics.rounds} rounds.`;
  }

  return {
    id,
    question: input.question,
    answer,
    allowedNumbers: allowed,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Compose a conversational reply from a finished report. Every number here comes
 * from the report, so the chat answer can never disagree with the report file.
 */
export function renderReportReply(input: {
  report: SwarmReport;
  language: string;
  reportPath?: string;
}): string {
  const { report, language } = input;
  const isAr = language.startsWith("ar");
  const { metrics, delta } = report;
  const intentText = isAr
    ? `نيّة الشراء ${percent(metrics.purchaseIntent)}`
    : `purchase intent ${percent(metrics.purchaseIntent)}`;

  if (isAr) {
    const lines = [
      `اكتملت محاكاة السرب لـ **${localizedTarget(report.title.replace(/^تقرير محاكاة السرب:\s*/, ""))}**:`,
      `- **المقاييس (من سجل المحاكاة)**: ${intentText} | الوكلاء ${metrics.agents} | الجولات ${metrics.rounds} | استدعاءات النموذج ${metrics.modelCalls}.`,
      delta
        ? `- **مقارنة المتغير** (${delta.variable.name}): الأساس ${delta.baselineLabel} ← السيناريو ${delta.scenarioLabel}، فرق نيّة الشراء ${signed(delta.intentDelta)}.`
        : `- **المتغير**: لم يُحدَّد متغير للمقارنة، لذا تقيس هذه الجولة الوضع الراهن فقط.`,
      `- **التقرير**: \`${report.paths.markdown}\`${reportPathOf(input.reportPath)}.`,
      `\n💬 **تابع معي**: اسأل *"ماذا لو غيّرنا ${delta?.variable.name ?? "المتغير"}؟"*، أو *"قابل أحد الوكلاء"*، أو *"اسأل التقرير سؤالاً"*.`,
    ];
    if (metrics.failures > 0) {
      lines.push(`\n⚠️ سُجّل ${metrics.failures} فشل استدعاء نموذج كتخطٍّ ولم يُخترع أي سلوك.`);
    }
    return lines.join("\n");
  }

  const lines = [
    `Ran a real **MiroFish swarm simulation**:`,
    `- **Metrics (from the simulation log)**: ${intentText} | agents ${metrics.agents} | rounds ${metrics.rounds} | model calls ${metrics.modelCalls}.`,
    delta
      ? `- **Variable comparison** (${delta.variable.name}): baseline ${delta.baselineLabel} -> scenario ${delta.scenarioLabel}, purchase intent delta ${signed(delta.intentDelta)}.`
      : `- **Variable**: none supplied, so this run measures the status quo only.`,
    `- **Report**: \`${report.paths.markdown}\`${reportPathOf(input.reportPath)}.`,
    `\n💬 **Continue in chat**: ask *"what if we change the ${delta?.variable.name ?? "variable"}?"*, *"interview an agent"*, or *"ask the report a question"*!`,
  ];
  if (metrics.failures > 0) {
    lines.push(`\n⚠️ ${metrics.failures} model call(s) failed and were logged as skips; nothing was invented.`);
  }
  return lines.join("\n");
}

/** The pipeline's English fallback target name must not leak into an Arabic sentence. */
function localizedTarget(name: string): string {
  return name === "the product" ? "المنتج" : name;
}

/** Absolute path suffix for the reply, when the caller has one. */
function reportPathOf(reportPath: string | undefined): string {
  return reportPath ? ` (at \`${reportPath}\`)` : "";
}
