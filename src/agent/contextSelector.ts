/**
 * Neo N5: the per-step context selector ("memory manager").
 *
 * The existing compressor (`./contextCompressor.js`) is a *reactive* gate: it
 * waits for the transcript to cross a token threshold and then folds the whole
 * middle away. That leaves a long run with two failure modes the selector is
 * meant to remove:
 *
 *  1. **Transcript growth.** Every tool result stays in the prompt until the
 *     compressor fires, so context grows linearly with the step count and the
 *     first compaction is expensive.
 *  2. **Recall amnesia.** Once compaction has fired, the exact string a later
 *     step needs (a value seen at step 12, a plan item, a KB seed) is gone even
 *     though it is still true and still in an artefact.
 *
 * The selector sits *in front of* the compressor, runs every step, and answers
 * one question before the model is called: **which parts of the artefact store
 * does this step actually need?** It keeps a bounded working set (leading task,
 * live task list, most recent observations) and pre-selects the artefacts that
 * matter for the current step.
 *
 * Design rules the rest of the programme relies on:
 *
 *  - **Evidence is never silently dropped.** A tool result that is not selected
 *    is folded into an elision marker recording its tool, path, token cost and
 *    a short summary, so the run graph and the transcript can still point at it.
 *  - **Selection is query-driven and deterministic.** The query is the task
 *    plus the current step context, ranked with BM25 over the artefact
 *    titles/bodies plus a recency decay. No model call and no embedding
 *    service, so the gate stays reproducible.
 *  - **The budget is hard.** Selected blocks are capped at `maxContextTokens`
 *    and the trailing window is always kept verbatim, so one step can never
 *    blow the window.
 *  - **Fallback is total.** A disabled selector, an unknown tool, or a throwing
 *    caller must never change the run's behaviour: every failure path returns
 *    `applied: false` and the caller keeps the raw transcript.
 *
 * The selector is deliberately independent of the compressor. It reduces *how
 * often* and *how hard* the compressor has to work; the compressor remains the
 * last-resort mechanism above its critical threshold.
 */
import type { ChatMessage } from "../ollama.js";
import type { TodoItem } from "./events.js";
import { REMINDER_TAG, reminderMessage } from "./reminders.js";

/** Characters per token, matching the harness's own estimate (mockModel.ts). */
export const CHARS_PER_TOKEN = 4;

/**
 * Fallback context window (tokens) when the caller supplies none. Matches the
 * compressor's own fallback so the two layers never disagree by more than the
 * configured per-model window.
 */
export const DEFAULT_CONTEXT_WINDOW = 32768;

/**
 * Character/token budget the selector may spend on the selected artefact blocks
 * of one step.
 *
 * A caller may pass `maxTokens` to override it (tests, or a caller that already
 * knows its own window), but the default is never free to exceed the window: a
 * selector that re-attached more than the model can hold would defeat its own
 * purpose. The compressor keeps its own `bufferTokens` headroom for the answer,
 * so the two layers stay consistent about how much room is left.
 */
export function selectionBudgetTokens(maxTokens: number | undefined, windowTokens = DEFAULT_CONTEXT_WINDOW): number {
  const requested = Number.isFinite(maxTokens) && (maxTokens as number) > 0 ? (maxTokens as number) : Number.POSITIVE_INFINITY;
  return Math.min(requested, windowTokens);
}

/** Rough token estimate for a piece of text. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function messageTokens(message: ChatMessage): number {
  const body = typeof message.content === "string" ? message.content : "";
  const calls = (message.tool_calls ?? []).reduce(
    (sum, call) =>
      sum + estimateTokens(call.function?.name ?? "") + estimateTokens(JSON.stringify(call.function?.arguments ?? {})),
    0,
  );
  return estimateTokens(body) + calls;
}

export function totalTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + messageTokens(message), 0);
}

/* ------------------------------- config ---------------------------------- */

export interface ContextSelectorConfig {
  /** Master switch. `false` keeps the pre-N5 behaviour exactly. */
  enabled: boolean;
  /** Hard cap on the selected context for one step (default 12000). */
  maxContextTokens: number;
  /**
   * Steps to let run with the raw transcript before the selector starts
   * re-shaping it (default 6). A short run therefore keeps the exact pre-N5
   * prompt, while a long-horizon run gets a bounded context from here on. The
   * step count is used rather than a token count because the point of the
   * selector is to stop the transcript growing, which a token gate cannot do:
   * it can only react after the growth it was meant to prevent.
   */
  activateAfterSteps: number;
  /** Leading messages kept verbatim: system + task (default 4). */
  protectLead: number;
  /** Trailing messages kept verbatim: the current step's observations (default 8). */
  protectTail: number;
  /** Artefacts selected for re-attachment when the budget allows (default 8). */
  maxArtefacts: number;
  /** Characters of an artefact body kept when it is re-attached (default 2400). */
  artefactChars: number;
  /** Characters of an elided tool result kept in the elision marker (default 400). */
  elisionChars: number;
  /**
   * Upper bound on the artefact store, in entries. A very long run must not keep
   * every artefact in memory: the store is the working set the selector ranks,
   * not the run's archive. The compressor owns the durable fold-away; this bound
   * keeps the ranking cost and the memory footprint of a long run bounded.
   *
   * Default 512: enough for a multi-hour run's recent working set, far above the
   * point where the bound would evict an artefact a later step still needs.
   */
  storeBound: number;
  /** BM25 term-frequency saturation (default 1.2). */
  bm25k1: number;
  /** BM25 length normalisation (default 0.75). */
  bm25b: number;
  /** Per-step recency decay applied to artefact scores (default 0.97). */
  recencyDecay: number;
  /** Cap on artefacts examined for one query (default 64). */
  candidateLimit: number;
}

export const DEFAULT_SELECTOR_CONFIG: ContextSelectorConfig = {
  enabled: true,
  maxContextTokens: 12000,
  activateAfterSteps: 6,
  protectLead: 4,
  protectTail: 8,
  maxArtefacts: 8,
  artefactChars: 2400,
  elisionChars: 400,
  storeBound: 512,
  bm25k1: 1.2,
  bm25b: 0.75,
  recencyDecay: 0.97,
  candidateLimit: 64,
};

/** Clamp a partial config onto the defaults so a stale/partial config is safe. */
export function normalizeSelectorConfig(raw: Partial<ContextSelectorConfig> | undefined): ContextSelectorConfig {
  const src = raw ?? {};
  const num = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  return {
    enabled: typeof src.enabled === "boolean" ? src.enabled : DEFAULT_SELECTOR_CONFIG.enabled,
    maxContextTokens: num(src.maxContextTokens, DEFAULT_SELECTOR_CONFIG.maxContextTokens, 1000, 1_000_000),
    activateAfterSteps: num(src.activateAfterSteps, DEFAULT_SELECTOR_CONFIG.activateAfterSteps, 0, 10_000),
    protectLead: num(src.protectLead, DEFAULT_SELECTOR_CONFIG.protectLead, 0, 50),
    protectTail: num(src.protectTail, DEFAULT_SELECTOR_CONFIG.protectTail, 0, 200),
    maxArtefacts: num(src.maxArtefacts, DEFAULT_SELECTOR_CONFIG.maxArtefacts, 0, 64),
    artefactChars: num(src.artefactChars, DEFAULT_SELECTOR_CONFIG.artefactChars, 100, 200_000),
    elisionChars: num(src.elisionChars, DEFAULT_SELECTOR_CONFIG.elisionChars, 40, 10_000),
    storeBound: num(src.storeBound, DEFAULT_SELECTOR_CONFIG.storeBound, 16, 100_000),
    bm25k1: num(src.bm25k1, DEFAULT_SELECTOR_CONFIG.bm25k1, 0.1, 5),
    bm25b: num(src.bm25b, DEFAULT_SELECTOR_CONFIG.bm25b, 0, 1),
    recencyDecay: num(src.recencyDecay, DEFAULT_SELECTOR_CONFIG.recencyDecay, 0.5, 1),
    candidateLimit: num(src.candidateLimit, DEFAULT_SELECTOR_CONFIG.candidateLimit, 1, 4096),
  };
}

/* ------------------------------- artefacts ------------------------------- */

/** The kind of artefact a selector candidate came from. */
export type ArtefactKind = "tool_result" | "kb_seed" | "memory" | "task_list" | "plan";

/** One selectable unit of the run's artefact store. */
export interface Artefact {
  /** Stable id within the run. */
  id: string;
  kind: ArtefactKind;
  /** The text the model sees when the artefact is re-attached. */
  body: string;
  /** Title/heading used for ranking and for the re-attached block. */
  title: string;
  /** Creation order; higher is newer. */
  seq: number;
  /** Optional structured provenance for the run graph. */
  meta?: { tool?: string; path?: string; seedId?: string; score?: number };
}

export interface ScoredArtefact {
  artefact: Artefact;
  /** BM25 relevance (query-dependent, 0 when nothing matched). */
  score: number;
  /** Deterministic tie-breaker: newer artefacts win. */
  recency: number;
}

/* -------------------------------- BM25 ----------------------------------- */

const STOP_TERMS = new Set([
  "the", "a", "an", "of", "and", "or", "to", "in", "on", "for", "with", "is",
  "are", "was", "were", "be", "this", "that", "these", "those", "it", "as",
  "at", "by", "from", "into", "then", "than", "so", "do", "does", "not",
]);

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().normalize("NFKC").split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || STOP_TERMS.has(raw)) continue;
    out.push(raw);
  }
  return out;
}

export interface Bm25Index {
  lengths: number[];
  avgLength: number;
  postings: Map<string, { docFreq: number; freqs: number[] }>;
}

export function buildBm25Index(docs: readonly string[][]): Bm25Index {
  const lengths = docs.map((d) => d.length);
  const total = lengths.reduce((a, b) => a + b, 0);
  const avgLength = lengths.length > 0 ? total / lengths.length : 0;
  const freqByTerm = new Map<string, number[]>();
  const docFreq = new Map<string, number>();
  docs.forEach((doc, i) => {
    const counts = new Map<string, number>();
    for (const term of doc) counts.set(term, (counts.get(term) ?? 0) + 1);
    for (const [term, count] of counts) {
      const list = freqByTerm.get(term) ?? [];
      list[i] = count;
      freqByTerm.set(term, list);
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  });
  const postings = new Map<string, { docFreq: number; freqs: number[] }>();
  for (const [term, freqs] of freqByTerm) postings.set(term, { docFreq: docFreq.get(term) ?? 0, freqs });
  return { lengths, avgLength, postings };
}

/** Score one document against the query terms. */
export function bm25Score(
  index: Bm25Index,
  docIndex: number,
  queryTerms: readonly string[],
  k1 = 1.2,
  b = 0.75,
): number {
  const length = index.lengths[docIndex] ?? 0;
  const avg = index.avgLength > 0 ? index.avgLength : 1;
  let score = 0;
  for (const term of queryTerms) {
    const posting = index.postings.get(term);
    if (!posting) continue;
    const tf = posting.freqs[docIndex] ?? 0;
    if (tf === 0) continue;
    const n = posting.docFreq;
    const idf = Math.log(1 + (index.lengths.length - n + 0.5) / (n + 0.5));
    const denom = tf + k1 * (1 - b + (b * length) / avg);
    score += (idf * tf * (k1 + 1)) / denom;
  }
  return score;
}

/* ------------------------------- selector -------------------------------- */

export interface SelectorContext {
  /** The user's original request; the anchor of every query. */
  task: string;
  /** The run's live task list (mirrored from todo_write/plan calls). */
  todos: readonly TodoItem[];
  /** The run's artefact store: every artefact captured so far, oldest first. */
  artefacts: readonly Artefact[];
  /**
   * Maps a transcript tool message to its artefact id, so a tool result can be
   * recognised when the transcript is re-shaped. The map is built by the caller
   * as it pushes tool results, which is the only place the pairing is known.
   */
  toolMessageIds?: ReadonlyMap<ChatMessage, string>;
}

export interface SelectorOptions {
  config?: Partial<ContextSelectorConfig>;
  /** Override the token cap (tests, or a caller's own window maths). */
  maxTokens?: number;
  /** The model's context window (tokens). The selection can never exceed it. */
  windowTokens?: number;
}

export interface SelectorOutcome {
  /** True when the selector replaced the transcript with a selected view. */
  applied: boolean;
  /** The artefacts selected for this step (empty when nothing was applied). */
  artefacts: Artefact[];
  /** Estimated tokens the selection added to the prompt. */
  tokens: number;
  /** Why the selector did or did not apply (diagnostics for the run graph). */
  reason: string;
}

/** Build the query the current step is selected against. */
export function buildQuery(ctx: SelectorContext): string {
  const parts: string[] = [ctx.task.trim()];
  const open = ctx.todos.filter((t) => t.status === "in_progress" || t.status === "pending");
  for (const item of open.slice(0, 6)) parts.push(item.content);
  return parts.filter(Boolean).join("\n").slice(0, 4000);
}

/** Score every artefact for one query, best first. Deterministic. */
export function scoreArtefacts(ctx: SelectorContext, config: ContextSelectorConfig): ScoredArtefact[] {
  const query = buildQuery(ctx);
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0 || ctx.artefacts.length === 0) return [];
  const docs = ctx.artefacts.map((a) => [...tokenize(a.title), ...tokenize(a.body)]);
  const index = buildBm25Index(docs);
  const scored: ScoredArtefact[] = [];
  for (let i = 0; i < ctx.artefacts.length; i++) {
    const artefact = ctx.artefacts[i]!;
    const relevance = bm25Score(index, i, terms, config.bm25k1, config.bm25b);
    const recency = Math.pow(config.recencyDecay, Math.max(0, ctx.artefacts.length - 1 - i));
    scored.push({ artefact, score: relevance, recency });
  }
  scored.sort((a, b) => {
    // A zero-relevance artefact is never selected, however recent it is.
    if (b.score !== a.score) return b.score - a.score;
    if (b.recency !== a.recency) return b.recency - a.recency;
    return a.artefact.seq - b.artefact.seq;
  });
  return scored;
}

/** The artefact blocks selected for one step, best first, budget-capped. */
export function selectContext(ctx: SelectorContext, options: SelectorOptions = {}): SelectorOutcome {
  const config = normalizeSelectorConfig(options.config);
  if (!config.enabled) return { applied: false, artefacts: [], tokens: 0, reason: "disabled" };
  const scored = scoreArtefacts(ctx, config);
  const relevant = scored.filter((s) => s.score > 0).slice(0, Math.max(1, config.candidateLimit));
  if (relevant.length === 0) return { applied: false, artefacts: [], tokens: 0, reason: "no relevant artefact" };
  // The budget is a window cap, not a free parameter: the selected blocks are
  // added to a prompt that already carries the lead and tail, so an unbounded
  // selection would defeat the selector's own purpose. A caller that knows the
  // model's real window passes it; otherwise the configured cap stands in.
  const cap = selectionBudgetTokens(options.maxTokens, options.windowTokens ?? config.maxContextTokens);
  const chosen: Artefact[] = [];
  let tokens = 0;
  for (const { artefact } of relevant.slice(0, Math.max(1, config.maxArtefacts))) {
    const body =
      artefact.body.length > config.artefactChars
        ? `${artefact.body.slice(0, config.artefactChars)}\n[…truncated]`
        : artefact.body;
    const blockTokens = estimateTokens(`${artefact.title}\n${body}`);
    if (chosen.length > 0 && tokens + blockTokens > cap) break;
    chosen.push(artefact);
    tokens += blockTokens;
    if (tokens >= cap) break;
  }
  if (chosen.length === 0) return { applied: false, artefacts: [], tokens: 0, reason: "budget too small" };
  return { applied: true, artefacts: chosen, tokens, reason: "selected" };
}

/* --------------------------- transcript shaping -------------------------- */

export interface CompactOptions extends SelectorOptions {
  config?: Partial<ContextSelectorConfig>;
  /** Current step number, used only for diagnostics. */
  step?: number;
}

export interface CompactResult {
  messages: ChatMessage[];
  outcome: SelectorOutcome;
  /** Elision markers inserted for dropped tool results. */
  elided: Artefact[];
}

function elisionMarker(artefact: Artefact, config: ContextSelectorConfig): string {
  const body = artefact.body.slice(0, config.elisionChars).replace(/\s+/g, " ").trim();
  const where = artefact.meta?.path ? ` path=${artefact.meta.path}` : "";
  return `[context elided: ${artefact.kind} "${artefact.title}"${where}; ${estimateTokens(artefact.body)} tokens; summary: ${body}]`;
}

function truncateBody(body: string, maxChars: number): string {
  return body.length > maxChars ? `${body.slice(0, maxChars)}\n[…truncated]` : body;
}

/** True when a message is a harness-generated reminder block. */
function isReminderBlock(message: ChatMessage): boolean {
  const body = typeof message.content === "string" ? message.content : "";
  return body.includes(REMINDER_TAG);
}

/**
 * A hidden context block the selector attaches (the selected artefacts) or
 * substitutes for an elided tool result.
 *
 * These are deliberately *not* `system-reminder` blocks. The tag is reserved for
 * the harness's own live signals (a stale task list, an external file change, a
 * memory update), which the UI filters out and the loop keeps appending. If the
 * selector's blocks carried the tag too, the fold below would treat them as
 * reminders and collapse them away, so a run's selected context would be
 * dropped every step.
 */
function hiddenMessage(text: string): ChatMessage {
  return { role: "user", content: text };
}

/**
 * Collapse reminder blocks that stack up in the middle of a transcript.
 *
 * The loop appends a fresh reminder on some steps (a stale task list, an
 * external file change, a memory update). Those reminders are hidden from the
 * UI and are bounded in count by the loop, but nothing stops the same kind from
 * reappearing, and each is appended at the end of the transcript. The selector
 * protects only a fixed number of *trailing* messages, so a run in which the
 * loop keeps emitting reminders grows without bound: the reminders are neither
 * dropped nor selected, and the protected tail only covers the last few.
 *
 * Folding them to one block keeps the prompt bounded without dropping live
 * signals: the newest reminder is always the one that is still actionable, and
 * the dropped ones are described in the marker so the run graph can still point
 * at them. The dropped reminders become *elided* rather than replacement
 * reminders, so a transcript that accumulates N reminders ends up with exactly
 * one reminder block plus a marker.
 */
function foldReminders(middle: readonly ChatMessage[]): { messages: ChatMessage[]; folded: number } {
  const out: ChatMessage[] = [];
  let folded = 0;
  let kept: ChatMessage | null = null;
  for (const message of middle) {
    if (!isReminderBlock(message)) {
      out.push(message);
      continue;
    }
    if (!kept) {
      kept = message;
      out.push(message);
      continue;
    }
    folded += 1;
  }
  // Describe every reminder folded away in a single non-reminder marker. Only
  // the newest reminder is still actionable; the older ones are history.
  if (folded > 0 && kept) {
    const idx = out.indexOf(kept);
    out.splice(idx, 0, hiddenMessage(`[context elided: ${folded} earlier reminder block(s) folded away; the newest reminder below is the current signal]`));
  }
  return { messages: out, folded };
}

/**
 * Produce the bounded transcript for one step.
 *
 * The shape is always: leading messages (system + task, verbatim) | selected
 * artefact blocks (hidden reminders) | trailing messages (verbatim). A tool
 * result in the middle that was not selected is replaced by an elision marker,
 * so the transcript stays parseable and the dropped evidence is still described.
 */
export function compactTranscript(
  messages: readonly ChatMessage[],
  ctx: SelectorContext,
  options: CompactOptions = {},
): CompactResult {
  const config = normalizeSelectorConfig(options.config);
  // Reminders the loop appended over the run's life would otherwise grow the
  // transcript without bound: they are neither selected artefacts nor part of
  // the protected tail, so they accumulate. Fold them across the whole
  // transcript before anything else, so the tail cannot keep one reminder per
  // step: the transcript never carries more than one live reminder.
  const folded = foldReminders(messages);
  const lead = Math.max(0, Math.min(config.protectLead, folded.messages.length));
  const tail = Math.max(0, Math.min(config.protectTail, Math.max(0, folded.messages.length - lead)));
  // A short run keeps the exact pre-N5 prompt, so the compressor's own trigger
  // stays the only moving part; the selector only engages on a long horizon.
  const step = options.step ?? 0;
  if (step <= config.activateAfterSteps || folded.messages.length <= lead + tail) {
    return {
      messages: folded.messages,
      outcome: { applied: false, artefacts: [], tokens: 0, reason: "under activation step" },
      elided: [],
    };
  }
  const leadMessages = folded.messages.slice(0, lead);
  const tailMessages = folded.messages.slice(folded.messages.length - tail);
  const middle = folded.messages.slice(lead, folded.messages.length - tail);
  const outcome = selectContext(ctx, options);
  const selectedIds = new Set(outcome.applied ? outcome.artefacts.map((a) => a.id) : []);

  const blocks: ChatMessage[] = [];
  const elided: Artefact[] = [];
  if (outcome.applied && outcome.artefacts.length > 0) {
    const body = outcome.artefacts
      .map((artefact) => `### ${artefact.title}\n${truncateBody(artefact.body, config.artefactChars)}`)
      .join("\n\n");
    blocks.push(hiddenMessage(`Selected context for this step (from the run's artefact store):\n${body}`));
  }

  for (const message of middle) {
    if (message.role !== "tool") {
      // Assistant reasoning between tool calls is kept: it is the run's working
      // memory and is bounded by the trailing window on its own.
      blocks.push(message);
      continue;
    }
    const artefactId = ctx.toolMessageIds?.get(message);
    if (artefactId && selectedIds.has(artefactId)) continue;
    const artefact = artefactId ? ctx.artefacts.find((a) => a.id === artefactId) : undefined;
    if (artefact) {
      elided.push(artefact);
      blocks.push(hiddenMessage(elisionMarker(artefact, config)));
    }
  }

  const shaped: ChatMessage[] = [...leadMessages, ...blocks, ...tailMessages];
  // Fold once more on the finished shape. The selected-context block and the
  // elision markers are reminder blocks too, and one of them is always the
  // newest, so a transcript of N reminder blocks would otherwise collapse to the
  // newest one and drop the loop's own reminder (a stale task list, an external
  // file change). Folding again leaves exactly one live reminder, which is
  // always the newest signal the run produced.
  const settled = foldReminders(shaped);
  return { messages: settled.messages, outcome, elided };
}

/* ------------------------------- channel --------------------------------- */

export interface ContextSelectorOptions {
  config?: Partial<ContextSelectorConfig>;
  /** Hard cap override (tokens) for the selected blocks. */
  maxTokens?: number;
  /** Called with one line of diagnostics per step. Never throws into the run. */
  onDecision?: (info: { step: number; applied: boolean; tokens: number; reason: string }) => void;
}

export interface ApplyResult {
  messages: ChatMessage[];
  applied: boolean;
  tokens: number;
  reason: string;
  /** Per-tool-result token totals captured for this step (diagnostics). */
  artefactCount: number;
}

/**
 * Stateful per-run selector.
 *
 * It accumulates the artefact store (one artefact per tool result) and applies
 * the bounded view once per step. All state is run-local, so two concurrent
 * runs never share a store.
 */
export class ContextSelector {
  private readonly config: ContextSelectorConfig;
  private readonly artefacts: Artefact[] = [];
  private seq = 0;
  private lastToolCallName = "";
  private readonly onDecision?: ContextSelectorOptions["onDecision"];
  private readonly maxTokens?: number;

  constructor(private readonly options: ContextSelectorOptions = {}) {
    this.config = normalizeSelectorConfig(options.config);
    this.onDecision = options.onDecision;
    this.maxTokens = options.maxTokens;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** The step count after which the selector starts re-shaping the transcript. */
  get activationStep(): number {
    return this.config.activateAfterSteps;
  }

  /** Artefacts captured so far, oldest first. */
  get store(): readonly Artefact[] {
    return this.artefacts;
  }

  /** Record the tool this run just called, so diagnostics can show it. */
  noteToolCall(name: string): void {
    this.lastToolCallName = name;
  }

  /** The most recent tool name (diagnostics only). */
  get lastTool(): string {
    return this.lastToolCallName;
  }

  /** Capture one tool result as an artefact. The store is bounded. */
  capture(name: string, content: string, meta: Artefact["meta"] = {}): Artefact {
    const artefact: Artefact = {
      id: `tool:${this.seq}`,
      kind: "tool_result",
      body: content.trim(),
      title: `${name}${meta.path ? ` ${meta.path}` : ""}`,
      seq: this.seq++,
      meta: { tool: name, ...meta },
    };
    this.push(artefact);
    return artefact;
  }

  /** Capture a durable artefact (KB seed, memory, task list) that is not a tool result. */
  captureExternal(kind: ArtefactKind, title: string, body: string, meta: Artefact["meta"] = {}): Artefact {
    // A durable artefact's body is whatever the caller stored (a KB seed's body,
    // a memory's text). Defensive stringification keeps the ranking step from
    // throwing on a malformed entry and dropping the whole run's context.
    const text = (typeof body === "string" ? body : String(body ?? "")).trim();
    const artefact: Artefact = { id: `${kind}:${this.seq}`, kind, body: text, title, seq: this.seq++, meta };
    this.push(artefact);
    return artefact;
  }

  private push(artefact: Artefact): void {
    this.artefacts.push(artefact);
    // The store is the working set the selector ranks, not the run's archive, so
    // it is bounded. `candidateLimit` caps ranking cost per query; `storeBound`
    // caps how much a long run retains at all. The two are independent: a run
    // can be ranked over a bounded window of recent artefacts while the
    // compressor owns the durable fold-away of everything older.
    const cap = Math.max(1, Math.floor(this.config.storeBound));
    if (this.artefacts.length > cap) this.artefacts.splice(0, this.artefacts.length - cap);
  }

  /**
   * Apply the bounded view for one step. Returns the messages to send.
   *
   * A selector failure is invisible to the run: `applied: false` and the
   * original transcript, so a bug here can only cost recall, never correctness.
   */
  async apply(
    messages: readonly ChatMessage[],
    ctx: {
      task: string;
      todos: readonly TodoItem[];
      step?: number;
      toolMessageIds?: ReadonlyMap<ChatMessage, string>;
      /** The model's context window (tokens); the selection can never exceed it. */
      windowTokens?: number;
    },
  ): Promise<ApplyResult> {
    const fail = (reason: string): ApplyResult => {
      this.onDecision?.({ step: ctx.step ?? 0, applied: false, tokens: 0, reason });
      return { messages: [...messages], applied: false, tokens: 0, reason, artefactCount: this.artefacts.length };
    };
    if (!this.config.enabled) return fail("disabled");
    try {
      const context: SelectorContext = { task: ctx.task, todos: ctx.todos, artefacts: this.artefacts, toolMessageIds: ctx.toolMessageIds };
      const result = compactTranscript(messages, context, {
        config: this.config,
        ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
        ...(ctx.windowTokens !== undefined ? { windowTokens: ctx.windowTokens } : {}),
        step: ctx.step,
      });
      this.onDecision?.({
        step: ctx.step ?? 0,
        applied: result.outcome.applied,
        tokens: result.outcome.tokens,
        reason: result.outcome.reason,
      });
      return {
        messages: result.messages,
        applied: result.outcome.applied,
        tokens: result.outcome.tokens,
        reason: result.outcome.reason,
        artefactCount: this.artefacts.length,
      };
    } catch (error) {
      // Selection must never break the run.
      return fail(`error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Convenience for the loop: is the selector enabled for this config? */
export function isSelectorEnabled(cfg: { contextSelector?: Partial<ContextSelectorConfig> } | undefined): boolean {
  if (!cfg?.contextSelector) return DEFAULT_SELECTOR_CONFIG.enabled;
  return normalizeSelectorConfig(cfg.contextSelector).enabled;
}
