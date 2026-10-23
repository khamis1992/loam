/**
 * MiroFish simulation loop (M3).
 *
 * Runs N simulated agents over R rounds. Every agent-turn is one real model call
 * through {@link ModelCaller} carrying the persona, the locale (so the agent
 * answers in its own language/dialect), the brief, the current variable value,
 * the agent's own memory and a deterministic sample of the recent posts of the
 * agents it follows. Nothing here is invented: a failed call is logged and the
 * agent is skipped for that round, and every aggregate is computed from the
 * recorded turns.
 *
 * Determinism: the social graph, the feed sampling and the round order all come
 * from a single seeded RNG, so the same seed reproduces the same run shape.
 */
import fs from "node:fs";
import path from "node:path";
import {
  askJson,
  asNumber,
  asRecord,
  asString,
  asStringArray,
  createRng,
  mapWithConcurrency,
  type ModelCaller,
} from "./model.js";
import type {
  AgentAction,
  AgentTurnEvent,
  AgentTurnOutput,
  ArmComparison,
  ArmId,
  Persona,
  RoundMetrics,
  SeedResult,
  SimulationArmResult,
  SimulationProgressEvent,
  SimulationResult,
  SimulationVariable,
  SocialGraph,
} from "./types.js";

/** Default agent count (RAM light). */
export const DEFAULT_AGENTS = 12;
/** Default round count. */
export const DEFAULT_ROUNDS = 3;
/** Agents above this need an explicit opt-in (`allowMoreAgents`). */
export const DEFAULT_AGENT_CAP = 20;
/** Absolute ceiling, even when explicitly raised. */
export const HARD_AGENT_CAP = 100;
/** Default per-call timeout for one agent-turn. */
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;
/** Default concurrency for agent-turn calls (RAM light). */
export const DEFAULT_CONCURRENCY = 2;
/** How many of an agent's own previous turns are fed back as memory. */
export const MEMORY_WINDOW = 4;
/** How many followed agents' posts are shown in one turn's feed. */
export const FEED_WINDOW = 6;
/** Maximum characters of a single post kept in the feed/memory. */
export const SNIPPET_MAX = 400;
/** Maximum `reasons` entries kept per turn. */
export const MAX_REASONS = 8;

const ACTIONS: readonly AgentAction[] = ["post", "comment", "share", "ignore", "buy", "cancel"];

export interface SimulationOptions {
  caller?: ModelCaller;
  /** Defaults to 1; drives the social graph, feed sampling and round order. */
  seed?: number;
  agents?: number;
  rounds?: number;
  /** Explicit opt-in to exceed {@link DEFAULT_AGENT_CAP} (hard cap still applies). */
  allowMoreAgents?: boolean;
  concurrency?: number;
  perCallTimeoutMs?: number;
  signal?: AbortSignal;
  /** Output language preference forwarded to the model ("auto" = follow locale). */
  language?: string;
  /** Directory the JSONL event log and metrics are written into. */
  taskDir?: string;
  /** Progress sink. Defaults to a no-op; the tool wires the run's event bus. */
  onProgress?: (event: SimulationProgressEvent) => void;
}

export interface RunSimulationInput {
  seed: SeedResult;
  /** The product brief the agents are reacting to. */
  brief: string;
  variable?: SimulationVariable;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validate + normalize one agent-turn. Throws when the shape is unusable. */
export function validateAgentTurn(value: unknown): AgentTurnOutput {
  const rec = asRecord(value);
  if (!rec) throw new Error("agent turn: expected a JSON object");

  const rawAction = asString(rec.action);
  const action = ACTIONS.find((a) => a === rawAction);
  if (!action) throw new Error(`agent turn: unsupported action ${String(rawAction)}`);

  const stanceRaw = asNumber(rec.stance ?? rec.sentiment);
  if (stanceRaw === null) throw new Error("agent turn: stance must be a number between -1 and 1");
  const intentRaw = asNumber(rec.purchaseIntent ?? rec.intent ?? rec.buyIntent);
  if (intentRaw === null) throw new Error("agent turn: purchaseIntent must be a number between 0 and 1");

  return {
    action,
    text: asString(rec.text ?? rec.content ?? rec.message) ?? "",
    stance: clamp(stanceRaw, -1, 1),
    purchaseIntent: clamp(intentRaw, 0, 1),
    reasons: asStringArray(rec.reasons ?? rec.reason, MAX_REASONS),
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Social graph
// ---------------------------------------------------------------------------

/**
 * Build a deterministic follow graph from persona similarity. Two personas are
 * similar when they share an income band, channel, occupation, attitude,
 * household, habit or city; the more they share, the more likely A follows B.
 * Influence weight is a seeded value biased by the persona's primary channel.
 */
export function buildSocialGraph(personas: Persona[], seed: number): SocialGraph {
  const rng = createRng(seed ^ 0x9e3779b9);
  const follows = new Map<string, string[]>();
  const influence = new Map<string, number>();

  const channelReach: Record<string, number> = {
    "word of mouth": 1.35,
    "x (twitter)": 1.25,
    tiktok: 1.2,
    instagram: 1.15,
    youtube: 1.1,
    facebook: 1.05,
    search: 0.85,
    "app store": 0.8,
  };

  for (const persona of personas) {
    influence.set(persona.id, round3(0.4 + rng() * 1.6 * (channelReach[(persona.channel ?? "").toLowerCase()] ?? 1)));
  }

  for (const a of personas) {
    const links: string[] = [];
    for (const b of personas) {
      if (a.id === b.id) continue;
      const similarity = personaSimilarity(a, b);
      // Higher similarity -> higher follow probability; the floor keeps the graph
      // connected so information can actually spread.
      const p = clamp(0.15 + similarity * 0.75, 0, 0.95);
      if (rng() < p) links.push(b.id);
    }
    // Bound the fan-out so a single agent never dominates the feed.
    follows.set(a.id, links.slice(0, Math.max(1, Math.min(links.length, 6))));
  }
  return { follows, influence };
}

function personaSimilarity(a: Persona, b: Persona): number {
  let score = 0;
  let weight = 0;
  const cmp = (x: unknown, y: unknown, w: number): void => {
    weight += w;
    if (x !== undefined && x !== null && String(x).toLowerCase() === String(y).toLowerCase()) score += w;
  };
  cmp(a.incomeBand, b.incomeBand, 2);
  cmp(a.channel, b.channel, 2);
  cmp(a.occupation, b.occupation, 1.5);
  cmp(a.attitude, b.attitude, 1.5);
  cmp(a.household, b.household, 1);
  cmp(a.country, b.country, 1);
  cmp(a.city, b.city, 1);
  const sharedHabits = (a.habits ?? []).filter((h) => (b.habits ?? []).includes(h)).length;
  weight += 2;
  score += Math.min(2, sharedHabits);
  return weight === 0 ? 0 : score / weight;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function languageInstruction(persona: Persona, localeLangs: string[], language?: string): string {
  const target = language && language !== "auto" ? language : persona.language || localeLangs[0] || "en";
  const dialect = persona.dialect?.trim();
  return [
    `Write your reply in ${target}${dialect ? ` (${dialect})` : ""}.`,
    "Match the way a real person who lives in this market actually writes online: local vocabulary, register and spelling, not a translation of an English sentence.",
    "Keep it short like a real social post or comment (one to three sentences).",
  ].join(" ");
}

function agentSystemPrompt(persona: Persona, locale: SeedResult["locale"], language?: string): string {
  const bands = locale.incomeBands
    .map((b) => `${b.label} (${b.min}${b.max ? `-${b.max}` : "+"}) ${b.currency}`)
    .join(", ");
  return [
    "You are role-playing ONE specific, real-feeling customer inside a market simulation.",
    "Stay in character for the whole turn. You are not an assistant and you must not mention the simulation, the brief, a model or a prompt.",
    "",
    "YOUR PERSONA",
    `- Name: ${persona.name}`,
    `- Age / gender: ${persona.age} / ${persona.gender}`,
    `- Lives in: ${[persona.city, persona.country].filter(Boolean).join(", ")}`,
    `- Occupation: ${persona.occupation}`,
    `- Household: ${persona.household}`,
    `- Income: ${persona.incomeAmount} ${persona.currency} (${persona.incomeBand} band)`,
    `- Primary channel: ${persona.channel}`,
    `- Baseline attitude to this product category: ${persona.attitude}`,
    `- Everyday habits: ${(persona.habits ?? []).join("; ") || "unspecified"}`,
    `- Language / dialect: ${persona.language}${persona.dialect ? ` / ${persona.dialect}` : ""}`,
    `- Bio: ${persona.bio}`,
    "",
    "MARKET CONTEXT (do not repeat it verbatim, use it to sound local)",
    `- Country: ${locale.country}${locale.city ? ` | City: ${locale.city}` : ""}${locale.region ? ` | Region: ${locale.region}` : ""}`,
    `- Currency: ${locale.currency} | Languages: ${locale.languages.join(", ")}${locale.dialect ? ` | Dialect: ${locale.dialect}` : ""}`,
    bands ? `- Local income bands (monthly): ${bands}` : "",
    locale.demographics.length > 0 ? `- Demographics: ${locale.demographics.join("; ")}` : "",
    "",
    languageInstruction(persona, locale.languages, language),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function variableLine(variable: SimulationVariable | undefined, arm: ArmId): string {
  if (!variable) return "No variable is being varied in this run; react to the product and the market as they are.";
  const value = arm === "baseline" ? variable.baseline : variable.scenario;
  return [
    `The variable under study is "${variable.name}". For THIS run its value is ${String(value)}${variable.unit ? ` ${variable.unit}` : ""}.`,
    `This arm is the ${arm.toUpperCase()} value. Judge the product against exactly this value and nothing else.`,
  ].join(" ");
}

function agentUserPrompt(input: {
  persona: Persona;
  brief: string;
  entitiesSummary: string;
  variable?: SimulationVariable;
  arm: ArmId;
  round: number;
  totalRounds: number;
  memory: AgentTurnEvent[];
  feed: AgentTurnEvent[];
  purchaseCount: number;
}): string {
  const { persona, brief, entitiesSummary, variable, arm, round, totalRounds, memory, feed, purchaseCount } = input;
  const sections: string[] = [
    "PRODUCT BRIEF",
    brief.trim() || "(no brief provided)",
    "",
    "WHAT WE KNOW ABOUT THE MARKET",
    entitiesSummary,
    "",
    variableLine(variable, arm),
    "",
    `You are acting in round ${round} of ${totalRounds}.`,
  ];

  if (memory.length > 0) {
    sections.push("", "YOUR OWN RECENT ACTIVITY IN THIS SIMULATION (your memory)");
    for (const turn of memory) {
      sections.push(
        `- Round ${turn.round} (${turn.action}, stance ${turn.stance}, intent ${turn.purchaseIntent}): ${snippet(turn.text)}`,
      );
    }
  } else {
    sections.push("", "This is your first round: you have no memory of the simulation yet.");
  }

  if (feed.length > 0) {
    sections.push("", "RECENT POSTS FROM PEOPLE YOU FOLLOW");
    for (const post of feed) {
      sections.push(`- ${post.agentName} (${post.action}): ${snippet(post.text)}`);
    }
    sections.push("React to what they actually said. Agree, push back, amplify or ignore them as your persona would.");
  } else {
    sections.push("", "None of the people you follow have posted yet, so react to the product and the market directly.");
  }

  if (purchaseCount > 0) {
    sections.push("", `So far in this simulation you have bought ${purchaseCount} time(s). Stay consistent with that history.`);
  }

  sections.push(
    "",
    "DECIDE WHAT YOU DO THIS ROUND AND REPLY EXACTLY IN CHARACTER.",
    "",
    "Return ONE JSON object with this exact shape and nothing else:",
    "{",
    '  "action": "post" | "comment" | "share" | "ignore" | "buy" | "cancel",',
    '  "text": "what you actually post/comment/share, in your language, 1-3 short sentences",',
    '  "stance": -1.0,',
    '  "purchaseIntent": 0.0,',
    '  "reasons": ["why you did this, from your persona\'s point of view"]',
    "}",
    "",
    "Rules:",
    "- `action`: post = start a new topic; comment = reply to something in your feed; share = amplify someone else's post; ignore = do nothing online this round; buy = you purchase now; cancel = you cancel/leave.",
    "- `stance`: -1 hostile/negative about the product, 0 neutral, 1 enthusiastic. A price or fee increase usually moves this negative for price-sensitive personas.",
    "- `purchaseIntent`: 0 you will never buy, 1 you buy immediately. It must be consistent with your action (buy implies 1, cancel implies 0).",
    "- `text` must be written by the persona, in the persona's own language and dialect, and must reflect the variable value for this arm.",
    "- `reasons` must be the persona's real motivations (budget, habit, trust, peer influence), not a description of the simulation.",
    "- Respond with JSON only, no prose, no code fence.",
  );
  return sections.join("\n");
}

function snippet(text: string): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > SNIPPET_MAX ? `${clean.slice(0, SNIPPET_MAX)}...` : clean;
}

function entitiesSummary(seed: SeedResult): string {
  const { entities } = seed;
  const parts: string[] = [];
  if (entities.products.length > 0) parts.push(`Products: ${entities.products.map((p) => p.name).join(", ")}`);
  if (entities.prices.length > 0) {
    parts.push(`Prices: ${entities.prices.map((p) => `${p.amount} ${p.currency}${p.period ? `/${p.period}` : ""}`).join(", ")}`);
  }
  if (entities.competitors.length > 0) parts.push(`Competitors: ${entities.competitors.map((c) => c.name).join(", ")}`);
  if (entities.audiences.length > 0) parts.push(`Audiences: ${entities.audiences.join(", ")}`);
  if (entities.summary) parts.push(entities.summary);
  return parts.join(" | ") || "No structured facts extracted; rely on the brief.";
}

// ---------------------------------------------------------------------------
// Turn execution
// ---------------------------------------------------------------------------

interface TurnContext {
  round: number;
  arm: ArmId;
  variable?: SimulationVariable;
  brief: string;
  seed: SeedResult;
  rounds: number;
  language?: string;
}

/**
 * Call the model and keep the provider's model name. The wrapper is transparent:
 * failures propagate to {@link runAgentTurn}, which logs them instead of
 * inventing behaviour.
 */
async function callWithModel<T>(
  caller: ModelCaller,
  opts: Parameters<typeof askJson<T>>[1],
  modelRef: { model?: string },
): Promise<T> {
  const wrapped: ModelCaller = {
    chat: async (request) => {
      const response = await caller.chat(request);
      if (response.model) modelRef.model = response.model;
      return response;
    },
  };
  return askJson<T>(wrapped, opts);
}

async function runAgentTurn(input: {
  persona: Persona;
  ctx: TurnContext;
  memory: AgentTurnEvent[];
  feed: AgentTurnEvent[];
  purchaseCount: number;
  caller: ModelCaller;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<AgentTurnEvent> {
  const { persona, ctx, memory, feed, purchaseCount, caller } = input;
  const started = Date.now();
  const base: Omit<AgentTurnEvent, keyof AgentTurnOutput | "ok"> = {
    round: ctx.round,
    agentId: persona.id,
    agentName: persona.name,
    arm: ctx.arm,
    latencyMs: 0,
  };

  const modelRef: { model?: string } = {};
  try {
    const output = await callWithModel<AgentTurnOutput>(caller, {
      system: agentSystemPrompt(persona, ctx.seed.locale, ctx.language),
      prompt: agentUserPrompt({
        persona,
        brief: ctx.brief,
        entitiesSummary: entitiesSummary(ctx.seed),
        variable: ctx.variable,
        arm: ctx.arm,
        round: ctx.round,
        totalRounds: ctx.rounds,
        memory,
        feed,
        purchaseCount,
      }),
      temperature: 0.8,
      retries: 1,
      validate: validateAgentTurn,
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    }, modelRef);

    return {
      ...base,
      ...output,
      ok: true,
      latencyMs: Date.now() - started,
      ...(modelRef.model ? { model: modelRef.model } : {}),
    };
  } catch (err) {
    // The failure is logged; the agent is skipped. Never fabricate a turn.
    return {
      ...base,
      action: "ignore",
      text: "",
      stance: 0,
      purchaseIntent: 0,
      reasons: [],
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/** Compute the opinion-spread aggregates for one round from its recorded turns. */
export function computeRoundMetrics(input: {
  round: number;
  arm: ArmId;
  turns: AgentTurnEvent[];
  graph: SocialGraph;
}): RoundMetrics {
  const { round, arm, turns, graph } = input;
  const acted = turns.filter((t) => t.ok);
  const skipped = turns.length - acted.length;

  const actionCounts = Object.fromEntries(ACTIONS.map((a) => [a, 0])) as Record<AgentAction, number>;
  let intentSum = 0;
  const stanceDistribution = { negative: 0, neutral: 0, positive: 0 };
  for (const turn of acted) {
    actionCounts[turn.action] += 1;
    intentSum += turn.purchaseIntent;
    if (turn.stance < -0.2) stanceDistribution.negative += 1;
    else if (turn.stance > 0.2) stanceDistribution.positive += 1;
    else stanceDistribution.neutral += 1;
  }

  return {
    round,
    arm,
    agentsActed: acted.length,
    agentsSkipped: skipped,
    meanIntent: acted.length > 0 ? round3(intentSum / acted.length) : 0,
    stanceDistribution,
    actionCounts,
    shareCascades: computeShareCascades(acted, graph),
    topThemes: computeTopThemes(acted.map((t) => t.text)),
  };
}

/**
 * Count share cascades: shares connected through the follow graph form one
 * cascade. `totalShares` is the number of share turns, `maxDepth` the longest
 * chain of connected shares inside a single cascade.
 */
export function computeShareCascades(turns: AgentTurnEvent[], graph: SocialGraph): RoundMetrics["shareCascades"] {
  const shares = turns.filter((t) => t.ok && t.action === "share");
  if (shares.length === 0) return { count: 0, totalShares: 0, maxDepth: 0 };

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== cur) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const share of shares) parent.set(share.agentId, share.agentId);
  for (const share of shares) {
    for (const other of shares) {
      if (share.agentId === other.agentId) continue;
      // Connected when one follows the other (either direction).
      if (graph.follows.get(share.agentId)?.includes(other.agentId)) union(share.agentId, other.agentId);
    }
  }

  const groups = new Map<string, string[]>();
  for (const share of shares) {
    const root = find(share.agentId);
    const list = groups.get(root) ?? [];
    list.push(share.agentId);
    groups.set(root, list);
  }

  let maxDepth = 0;
  for (const members of groups.values()) maxDepth = Math.max(maxDepth, members.length);
  return { count: groups.size, totalShares: shares.length, maxDepth };
}

const STOP_WORDS = new Set([
  // English
  "the", "a", "an", "and", "or", "but", "if", "to", "of", "in", "on", "for", "with", "at", "by", "from", "is", "it",
  "this", "that", "i", "we", "you", "my", "our", "not", "no", "so", "too", "very", "just", "about", "really",
  "because", "as", "be", "are", "was", "were", "has", "have", "had", "will", "would", "can", "could", "should", "than",
  "then", "there", "their", "them", "they", "he", "she", "his", "her", "me", "do", "does", "did", "up", "out", "now",
  "when", "what", "how", "who", "get", "got", "like", "one", "all", "more", "most", "it's", "i'm", "don't", "didn't",
  // Arabic (MSA + Gulf)
  "في", "على", "من", "الي", "الى", "هذا", "هذه", "ذلك", "مع", "عن", "ان", "انا", "انت", "لو", "ما", "لا", "بس", "كان",
  "كانت", "يكون", "هل", "او", "و", "ثم", "بعد", "قبل", "كل", "بعض", "غير", "بين", "عند", "يعني", "شوي", "كثير", "جدا",
  "هنا", "هناك", "الحين", "ابغى", "اريد", "ريال",
]);

/** Top recurring themes in a set of posts, computed from the actual text. */
export function computeTopThemes(texts: string[], limit = 5): Array<{ theme: string; count: number }> {
  const counts = new Map<string, number>();
  for (const raw of texts) {
    const text = (raw ?? "").toLowerCase();
    // Collect tags first: `#price` is one theme, not a `#` plus a `price` word.
    const tags = text.match(/#[\p{L}\p{N}_]+/gu) ?? [];
    for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    const wordsOnly = text.replace(/#[\p{L}\p{N}_]+/gu, " ");
    for (const word of wordsOnly.match(/[\p{L}][\p{L}'-]{3,}/gu) ?? []) {
      if (STOP_WORDS.has(word)) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([theme, count]) => ({ theme, count }));
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function armValue(variable: SimulationVariable | undefined, arm: ArmId): string | number | undefined {
  if (!variable) return undefined;
  return arm === "baseline" ? variable.baseline : variable.scenario;
}

/** Baseline-vs-scenario deltas, computed only from the two arms' real outputs. */
export function compareArms(
  baseline: SimulationArmResult,
  scenario: SimulationArmResult,
  variable?: SimulationVariable,
): ArmComparison {
  const meanIntent = (arm: SimulationArmResult): number => {
    const acted = arm.turns.filter((t) => t.ok);
    return acted.length > 0 ? acted.reduce((sum, t) => sum + t.purchaseIntent, 0) / acted.length : 0;
  };
  const positiveShare = (arm: SimulationArmResult): number => {
    const acted = arm.turns.filter((t) => t.ok);
    return acted.length === 0 ? 0 : acted.filter((t) => t.stance > 0.2).length / acted.length;
  };
  const buyRate = (arm: SimulationArmResult): number => {
    const acted = arm.turns.filter((t) => t.ok);
    return acted.length === 0 ? 0 : acted.filter((t) => t.action === "buy").length / acted.length;
  };
  const baselineMeanIntent = round3(meanIntent(baseline));
  const scenarioMeanIntent = round3(meanIntent(scenario));
  const baselinePositiveShare = round3(positiveShare(baseline));
  const scenarioPositiveShare = round3(positiveShare(scenario));
  const baselineBuyRate = round3(buyRate(baseline));
  const scenarioBuyRate = round3(buyRate(scenario));
  return {
    ...(variable ? { variable } : {}),
    baselineMeanIntent,
    scenarioMeanIntent,
    intentDelta: round3(scenarioMeanIntent - baselineMeanIntent),
    baselinePositiveShare,
    scenarioPositiveShare,
    positiveShareDelta: round3(scenarioPositiveShare - baselinePositiveShare),
    baselineBuyRate,
    scenarioBuyRate,
    buyRateDelta: round3(scenarioBuyRate - baselineBuyRate),
  };
}

// ---------------------------------------------------------------------------
// Feed / memory
// ---------------------------------------------------------------------------

/** Deterministically pick the recent posts of the agents `agentId` follows. */
export function sampleFeed(
  agentId: string,
  graph: SocialGraph,
  recent: AgentTurnEvent[],
  rng: () => number,
  limit = FEED_WINDOW,
): AgentTurnEvent[] {
  const follows = graph.follows.get(agentId) ?? [];
  if (follows.length === 0) return [];
  const candidates = recent.filter((t) => t.ok && t.text && follows.includes(t.agentId) && t.agentId !== agentId);
  if (candidates.length <= limit) return candidates;
  // Seeded reservoir sampling keeps the run reproducible.
  const pool = [...candidates];
  const picked: AgentTurnEvent[] = [];
  while (picked.length < limit && pool.length > 0) {
    const index = Math.floor(rng() * pool.length);
    picked.push(pool.splice(index, 1)[0]!);
  }
  return picked;
}

function memoryOf(agentId: string, turns: AgentTurnEvent[], limit = MEMORY_WINDOW): AgentTurnEvent[] {
  return turns.filter((t) => t.agentId === agentId && t.ok).slice(-limit);
}

function purchaseCountOf(agentId: string, turns: AgentTurnEvent[]): number {
  return turns.filter((t) => t.agentId === agentId && t.ok && t.action === "buy").length;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/** Progress events are reported through a plain sink; any owner shape works. */
function emit(opts: { onProgress?: (event: SimulationProgressEvent) => void }, event: SimulationProgressEvent): void {
  try {
    opts.onProgress?.(event);
  } catch {
    /* progress reporting must never break a simulation */
  }
}

function resolveAgents(requested: number | undefined, allowMore: boolean): number {
  const wanted = Math.max(1, Math.floor(requested ?? DEFAULT_AGENTS));
  const cap = allowMore ? HARD_AGENT_CAP : DEFAULT_AGENT_CAP;
  return Math.min(cap, wanted);
}

async function runArm(input: {
  arm: ArmId;
  personas: Persona[];
  seed: SeedResult;
  variable?: SimulationVariable;
  brief: string;
  rounds: number;
  rngSeed: number;
  caller?: ModelCaller;
  concurrency: number;
  perCallTimeoutMs?: number;
  signal?: AbortSignal;
  language?: string;
  sessionId: string;
  onProgress?: (event: SimulationProgressEvent) => void;
}): Promise<SimulationArmResult> {
  const { arm, personas, seed, variable, brief, rounds, caller, sessionId } = input;
  const graph = buildSocialGraph(personas, input.rngSeed);
  const rng = createRng(input.rngSeed ^ (arm === "scenario" ? 0x51ed270b : 0x1f123bb5));
  const turns: AgentTurnEvent[] = [];
  const metrics: RoundMetrics[] = [];
  let calls = 0;
  let failures = 0;

  const ctx: TurnContext = { round: 1, arm, variable, brief, seed, rounds, language: input.language };

  for (let round = 1; round <= rounds; round++) {
    ctx.round = round;
    emit(input, { type: "simulation_round_start", sessionId, arm, round, totalRounds: rounds });

    const limit = Math.max(1, Math.min(input.concurrency, personas.length || 1));
    const roundTurns = await mapWithConcurrency(personas, limit, async (persona): Promise<AgentTurnEvent> => {
      if (!caller) {
        // No caller means the model layer is unavailable: log the skip instead
        // of fabricating behaviour.
        const skipped: AgentTurnEvent = {
          round,
          agentId: persona.id,
          agentName: persona.name,
          arm,
          latencyMs: 0,
          action: "ignore",
          text: "",
          stance: 0,
          purchaseIntent: 0,
          reasons: [],
          ok: false,
          error: "no model caller available",
        };
        emit(input, {
          type: "simulation_agent",
          sessionId,
          arm,
          round,
          agentId: persona.id,
          agentName: persona.name,
          ok: false,
          error: skipped.error,
        });
        return skipped;
      }

      const turn = await runAgentTurn({
        persona,
        ctx,
        memory: memoryOf(persona.id, turns),
        feed: sampleFeed(persona.id, graph, turns, rng),
        purchaseCount: purchaseCountOf(persona.id, turns),
        caller,
        timeoutMs: input.perCallTimeoutMs,
        signal: input.signal,
      });
      calls += 1;
      if (!turn.ok) failures += 1;
      emit(input, {
        type: "simulation_agent",
        sessionId,
        arm,
        round,
        agentId: persona.id,
        agentName: persona.name,
        ok: turn.ok,
        ...(turn.ok ? { action: turn.action } : { error: turn.error }),
      });
      return turn;
    });

    turns.push(...roundTurns);
    const roundMetrics = computeRoundMetrics({ round, arm, turns: roundTurns, graph });
    metrics.push(roundMetrics);
    emit(input, {
      type: "simulation_round",
      sessionId,
      arm,
      round,
      totalRounds: rounds,
      metrics: roundMetrics,
    });
  }

  emit(input, { type: "simulation_arm_done", sessionId, arm, calls, failures });
  return {
    arm,
    rounds: metrics,
    turns,
    calls,
    failures,
    skipped: turns.filter((t) => !t.ok).length,
  };
}

function resolveTaskDir(taskDir: string | undefined, sessionId: string): string {
  if (taskDir && taskDir.trim()) return taskDir;
  return path.join(process.cwd(), ".manus", "mirofish", "simulations", sessionId);
}

function writeJsonl(filePath: string, events: AgentTurnEvent[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = events.map((e) => JSON.stringify(e)).join("\n") + (events.length > 0 ? "\n" : "");
  fs.writeFileSync(filePath, body, "utf8");
}

function writeMetrics(metricsPath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(metricsPath), { recursive: true });
  fs.writeFileSync(metricsPath, JSON.stringify(payload, null, 2), "utf8");
}

/**
 * Run the full simulation: N agents x R rounds, one real model call per
 * agent-turn, with an optional baseline/scenario pair for the varied variable.
 * Every aggregate is derived from the recorded turns; the JSONL log and the
 * metrics file are written to `taskDir`.
 */
export async function runSimulation(
  sessionId: string,
  input: RunSimulationInput,
  opts: SimulationOptions = {},
): Promise<SimulationResult> {
  const { seed } = input;
  if (!seed.personas || seed.personas.length === 0) {
    throw new Error("runSimulation: no personas available; run the seed step first");
  }

  const rngSeed = Math.floor(opts.seed ?? 1) >>> 0;
  const agents = resolveAgents(opts.agents ?? seed.personas.length, opts.allowMoreAgents ?? false);
  const personas = seed.personas.slice(0, agents);
  const rounds = Math.max(1, Math.floor(opts.rounds ?? DEFAULT_ROUNDS));
  const arms: ArmId[] = input.variable ? ["baseline", "scenario"] : ["baseline"];
  const taskDir = resolveTaskDir(opts.taskDir, sessionId);

  emit(opts, {
    type: "simulation_start",
    sessionId,
    agents: personas.length,
    rounds,
    arms,
  });

  const results: SimulationArmResult[] = [];
  for (const arm of arms) {
    if (opts.signal?.aborted) break;
    results.push(
      await runArm({
        arm,
        personas,
        seed,
        variable: input.variable,
        brief: input.brief,
        rounds,
        rngSeed: rngSeed + (arm === "scenario" ? 1 : 0),
        caller: opts.caller,
        concurrency: opts.concurrency ?? DEFAULT_CONCURRENCY,
        perCallTimeoutMs: opts.perCallTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
        signal: opts.signal,
        language: opts.language,
        sessionId,
        onProgress: opts.onProgress,
      }),
    );
  }

  const baseline = results.find((r) => r.arm === "baseline");
  const scenario = results.find((r) => r.arm === "scenario");
  const comparison = baseline && scenario ? compareArms(baseline, scenario, input.variable) : undefined;

  const allTurns = results.flatMap((r) => r.turns);
  const logPath = path.join(taskDir, "simulation_events.jsonl");
  const metricsPath = path.join(taskDir, "metrics.json");
  writeJsonl(logPath, allTurns);
  writeMetrics(metricsPath, {
    session_id: sessionId,
    seed: rngSeed,
    agents: personas.length,
    rounds,
    brief: input.brief.slice(0, 500),
    ...(input.variable ? { variable: input.variable } : {}),
    arms: results.map((r) => ({
      arm: r.arm,
      variable_value: armValue(input.variable, r.arm),
      calls: r.calls,
      failures: r.failures,
      rounds: r.rounds,
    })),
    ...(comparison ? { comparison } : {}),
  });

  const modelCalls = results.reduce((sum, r) => sum + r.calls, 0);
  const failures = results.reduce((sum, r) => sum + r.failures, 0);
  emit(opts, {
    type: "simulation_done",
    sessionId,
    agents: personas.length,
    rounds,
    modelCalls,
    failures,
    ...(comparison ? { comparison } : {}),
  });

  return {
    sessionId,
    seed: rngSeed,
    agents: personas.length,
    rounds,
    arms: results,
    ...(comparison ? { comparison } : {}),
    logPath,
    metricsPath,
    modelCalls,
    failures,
  };
}
