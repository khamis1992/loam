/**
 * Wide Research — parallel research fan-out with a merged, deduplicated report.
 *
 * Clean-room implementation written from the behavioural spec only:
 * a controller decomposes one question into independent sub-tasks, every
 * sub-task runs as its own isolated agent with a fresh context, the
 * sub-tasks never talk to each other, and the controller merges their
 * answers into a single report whose cited sources are deduplicated.
 *
 * Design constraints that shaped this file:
 *
 *  - The core (planning, fan-out, citation extraction/dedup, merging) has no
 *    model and no network dependency. The dispatcher (one research sub-task)
 *    and the synthesizer (the merge) are injected, so the unit test runs
 *    fully offline with a mock dispatcher.
 *  - Research dispatches either over an explicit, caller-decomposed list of
 *    items (one sub-agent per item, the wide-research list mode) or over the
 *    automatic angle plan. Big finding sets are synthesized with the
 *    map/reduce pattern: a partial report per chunk, then one melt-down
 *    reduce into the final merged report.
 *  - A research child may only use read-only research tools that the CURRENT
 *    run is itself allowed to use (`ctx.allowedTools`). wide_research can
 *    therefore never widen the policy of the run that called it.
 *  - Concurrency is bounded (never more than 20 children in flight) and every
 *    child failure is reported instead of collapsing the whole report.
 */

import type { Emit } from "../agent/events.js";
import type { OllamaClient } from "../ollama.js";
import type { Tool, ToolContext, ToolResult, ToolRegistry } from "./registry.js";
import { num, str } from "./registry.js";

/** Hard ceiling on parallel research sub-tasks. */
export const WIDE_RESEARCH_MAX_BREADTH = 20;
/** Default number of parallel research sub-tasks. */
export const WIDE_RESEARCH_DEFAULT_BREADTH = 4;
/** Findings per chunk in the two-phase (map/reduce-style) synthesis. */
export const WIDE_RESEARCH_SYNTHESIS_CHUNK = 8;

/** Read-only tools a research child may use. Deliberately narrow. */
export const WIDE_RESEARCH_CHILD_TOOLS: readonly string[] = [
  "web_search",
  "web_fetch",
  "file_read",
  "file_list",
  "file_search",
  "file_stat",
];

/** One research angle. The planner cycles through these to build the task list. */
export interface ResearchAngle {
  id: string;
  label: string;
  brief: string;
}

export const RESEARCH_ANGLES: readonly ResearchAngle[] = [
  { id: "general", label: "overview", brief: "What it is, the key concepts, and the current state of the art." },
  { id: "recent", label: "recent developments", brief: "What changed most recently, including the last couple of years." },
  { id: "evidence", label: "evidence and data", brief: "Quantitative evidence: studies, measurements, benchmarks, concrete numbers." },
  { id: "alternatives", label: "alternatives and trade-offs", brief: "The alternatives, how they compare, and the trade-offs between them." },
  { id: "critique", label: "limits and criticisms", brief: "Limitations, known weaknesses, criticisms, and open questions." },
  { id: "practice", label: "practical implications", brief: "What this means in practice: usage, costs, risks, and recommendations." },
  { id: "history", label: "history", brief: "How it got here: the timeline and the events that shaped it." },
  { id: "ecosystem", label: "ecosystem", brief: "The main players, tools, projects, and community around it." },
];

// ---------------------------------------------------------------------------
// Task planning
// ---------------------------------------------------------------------------

export interface WideResearchTask {
  id: string;
  index: number;
  /** The parent question. */
  query: string;
  /** The self-contained sub-question this task answers. */
  question: string;
  /** Human readable angle label. */
  angle: string;
  /** Stable angle id. */
  angleId: string;
  /** Optional seed source (URL) the task starts from. */
  source?: string;
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/** Trim, drop empties and dedupe a caller-supplied source list. */
export function normalizeSources(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const value = item.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= WIDE_RESEARCH_MAX_BREADTH) break;
  }
  return out;
}

/**
 * Turn one question plus caller-decomposed research items and optional seed
 * sources into a bounded list of independent sub-tasks. Seed sources come
 * first (one sub-task each), then every explicit item (one sub-agent each),
 * and the remaining budget is filled with distinct research angles. The
 * total plan never exceeds `breadth`.
 */
export function planResearchTasks(query: string, sources: string[], breadth: number, items: string[] = []): WideResearchTask[] {
  const limit = clamp(breadth, 1, WIDE_RESEARCH_MAX_BREADTH);
  const tasks: WideResearchTask[] = [];

  const push = (question: string, angleId: string, angleLabel: string, source?: string): void => {
    if (tasks.length >= limit) return;
    const index = tasks.length;
    tasks.push({
      id: `wrt-${index + 1}`,
      index,
      query,
      question,
      angle: angleLabel,
      angleId,
      ...(source ? { source } : {}),
    });
  };

  for (const source of sources) {
    if (tasks.length >= limit) break;
    push(
      `Read the source below and extract only the findings that bear on the question. Quote the decisive claims.\n\nQUESTION: ${query}\nSOURCE: ${source}`,
      "source",
      "source review",
      source,
    );
  }

  let itemCursor = 0;
  for (const item of items) {
    if (tasks.length >= limit) break;
    push(
      `Investigate this item as one thread of the research question and report focused findings for it.\n\nQUESTION: ${query}\nITEM: ${item}`,
      `item-${itemCursor + 1}`,
      "list item",
    );
    itemCursor += 1;
  }

  let cursor = 0;
  while (tasks.length < limit) {
    const base = RESEARCH_ANGLES[cursor % RESEARCH_ANGLES.length]!;
    const round = Math.floor(cursor / RESEARCH_ANGLES.length);
    const angleId = round === 0 ? base.id : `${base.id}-${round + 1}`;
    const angleLabel = round === 0 ? base.label : `${base.label} (pass ${round + 1})`;
    push(
      `Answer the question from the "${base.label}" angle.\n\nQUESTION: ${query}\nANGLE: ${base.brief}`,
      angleId,
      angleLabel,
    );
    cursor += 1;
  }

  return tasks;
}

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"'`\])}]+/gi;
const TRACKING_PARAM = /^(?:utm_|ref$|ref_|fbclid|gclid|dclid|msclkid|yclid|mc_[ce]id|igshid|_hsenc|_hsmi|spm|cmpid|campaign|source$)/i;

/** Pull every http(s)/www URL out of free text. */
export function extractCitations(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const re = new RegExp(URL_PATTERN.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const raw = match[0].replace(/[.,;:!?]+$/u, "");
    if (raw.length > 4) out.push(raw);
  }
  return out;
}

/**
 * Canonical form of a citation, used only as a dedup key: lower-cased host
 * without `www.`, no fragment, no tracking parameters, sorted query, no
 * trailing slash. Unparsable values fall back to a lower-cased literal.
 */
export function normalizeCitation(raw: string): string {
  let value = raw.trim().replace(/^[<("'`]+/u, "").replace(/[>)"'`]+$/u, "");
  if (!value) return "";
  if (/^www\./i.test(value)) value = `https://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value.toLowerCase();
  }
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./u, "");
  // The key ignores the scheme: http and https addresses the same resource for
  // citation purposes. Only the key is rewritten — the report keeps the URL
  // exactly as the source spelled it.
  if (url.protocol === "http:") url.protocol = "https:";
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }
  const params = [...url.searchParams.entries()].filter(([key]) => !TRACKING_PARAM.test(key));
  params.sort(([a], [b]) => a.localeCompare(b));
  url.search = "";
  for (const [key, val] of params) url.searchParams.append(key, val);
  const path = url.pathname.replace(/\/+$/u, "") || "";
  // Use hostname (never includes the port) so a non-default port is not
  // emitted twice; `host` already carries `host:port` and would duplicate it.
  return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}${path}${url.search}`;
}

/** Keep the first occurrence of every distinct citation, in order. */
export function dedupeCitations(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const key = normalizeCitation(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dispatcher / synthesizer contracts
// ---------------------------------------------------------------------------

/** Minimal context handed to a dispatcher or synthesizer. */
export interface WideResearchContext {
  signal?: AbortSignal;
  taskId?: string;
  emit?: Emit;
}

/** The answer of one research sub-task. */
export interface WideResearchTaskResult {
  summary: string;
  citations?: string[];
  ok?: boolean;
  error?: string;
}

export type WideResearchDispatcher = (
  task: WideResearchTask,
  ctx: WideResearchContext,
) => Promise<WideResearchTaskResult>;

export interface WideResearchSynthesisInput {
  query: string;
  findings: WideResearchFinding[];
  sources: string[];
}

export type WideResearchSynthesizer = (
  input: WideResearchSynthesisInput,
  ctx: WideResearchContext,
) => Promise<string>;

/** One successful research sub-task. */
export interface WideResearchFinding {
  taskId: string;
  index: number;
  angle: string;
  question: string;
  source?: string;
  summary: string;
  citations: string[];
}

/** Status of every planned sub-task, successful or not. */
export interface WideResearchTaskStatus {
  id: string;
  index: number;
  angle: string;
  ok: boolean;
  error?: string;
}

export interface WideResearchReport {
  query: string;
  breadth: number;
  completed: number;
  failed: number;
  /** The merged report. */
  summary: string;
  /** Successful sub-task findings, in plan order. */
  findings: WideResearchFinding[];
  /** Deduplicated cited sources, in first-seen order. */
  sources: string[];
  /** Status of every planned sub-task. */
  tasks: WideResearchTaskStatus[];
  ok: boolean;
}

export interface WideResearchRunOptions {
  query: string;
  /** Caller-decomposed research list — one sub-agent per item. */
  items?: string[];
  sources?: string[];
  breadth?: number;
  dispatcher: WideResearchDispatcher;
  synthesizer: WideResearchSynthesizer;
  concurrency?: number;
  /** Findings per chunk in the two-phase synthesis; below it the merge is one call. */
  synthesisChunkSize?: number;
  signal?: AbortSignal;
  taskId?: string;
  emit?: Emit;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** Pull the first balanced JSON object out of model output. */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(trimmed);
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/**
 * Read one sub-task answer. Structured JSON (`{"summary":..,"citations":[..]}`)
 * is preferred; anything else is kept as plain text and scanned for URLs.
 */
export function parseTaskResult(text: string): WideResearchTaskResult {
  const trimmed = text.trim();
  const json = extractJsonObject(trimmed);
  if (json) {
    const rawSummary = json.summary ?? json.findings ?? json.answer ?? json.text;
    const summary = typeof rawSummary === "string" ? rawSummary.trim() : "";
    if (summary) {
      const rawCitations = Array.isArray(json.citations)
        ? json.citations.filter((c): c is string => typeof c === "string")
        : Array.isArray(json.sources)
          ? json.sources.filter((c): c is string => typeof c === "string")
          : [];
      return { summary, citations: dedupeCitations([...rawCitations, ...extractCitations(summary)]) };
    }
  }
  return { summary: trimmed, citations: extractCitations(trimmed) };
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

function firstSentences(text: string, max = 2): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  if (!flat) return "";
  const parts = flat.match(/[^.!?]+[.!?]+(\s|$)/gu) ?? [flat];
  return parts.slice(0, max).join("").trim() || flat.slice(0, 400);
}

/**
 * Model-free merge. Used as the fallback when the model-backed synthesizer is
 * unavailable, and as the deterministic base of every report.
 */
export function deterministicSynthesis(query: string, findings: readonly WideResearchFinding[], sources: readonly string[]): string {
  const lines: string[] = [`Research summary for: ${query}`, ""];
  if (findings.length === 0) {
    lines.push("No research sub-task returned a usable finding.");
  } else {
    lines.push(`${findings.length} independent sub-task(s) completed.`);
    lines.push("");
    for (const finding of findings) {
      const label = finding.source ? `${finding.angle} — ${finding.source}` : finding.angle;
      lines.push(`- [${label}] ${firstSentences(finding.summary)}`);
    }
  }
  if (sources.length > 0) {
    lines.push("");
    lines.push(`Cited sources (${sources.length}):`);
    for (const source of sources) lines.push(`- ${source}`);
  }
  return lines.join("\n");
}

/** Group findings per source, so the same source is not presented twice. */
export function groupFindingsBySource(findings: readonly WideResearchFinding[]): Map<string, WideResearchFinding[]> {
  const groups = new Map<string, WideResearchFinding[]>();
  for (const finding of findings) {
    const key = finding.source ?? "";
    const bucket = groups.get(key);
    if (bucket) bucket.push(finding);
    else groups.set(key, [finding]);
  }
  return groups;
}

/** Split findings into ordered, contiguous chunks of at most {@link chunkSize}. */
export function chunkFindings(findings: readonly WideResearchFinding[], chunkSize: number): WideResearchFinding[][] {
  const size = Number.isFinite(chunkSize) ? Math.max(1, Math.trunc(chunkSize)) : 1;
  const chunks: WideResearchFinding[][] = [];
  for (let i = 0; i < findings.length; i += size) chunks.push(findings.slice(i, i + size));
  return chunks;
}

/**
 * Run the merge with the same map/reduce pattern the `map_reduce` tool uses:
 * when the finding set is larger than one chunk, map a partial report over
 * each chunk (in parallel sub-agent calls) and then reduce the partial
 * reports into the final merged summary. A chunk whose partial synthesis
 * falls back to the deterministic merge still reaches the reduce step, and a
 * failing reduce step falls back to the deterministic merge of everything.
 */
async function runSynthesis(
  options: WideResearchRunOptions,
  query: string,
  findings: readonly WideResearchFinding[],
  sources: string[],
  ctx: WideResearchContext,
): Promise<string> {
  const chunkSizeRaw = options.synthesisChunkSize ?? WIDE_RESEARCH_SYNTHESIS_CHUNK;
  const chunkSize = Number.isFinite(chunkSizeRaw) ? Math.max(1, Math.trunc(chunkSizeRaw)) : 1;

  if (findings.length <= chunkSize) {
    return (await options.synthesizer({ query, findings: [...findings], sources }, ctx)).trim();
  }

  const chunks = chunkFindings(findings, chunkSize);
  const partials: string[] = new Array(chunks.length).fill("");
  await Promise.all(
    chunks.map(async (chunk, i) => {
      const chunkSources = dedupeCitations(chunk.flatMap((f) => f.citations));
      try {
        partials[i] = (
          await options.synthesizer(
            { query, findings: [...chunk], sources: chunkSources },
            ctx.taskId ? { ...ctx, taskId: `${ctx.taskId}-synth-${i + 1}` } : ctx,
          )
        ).trim();
      } catch {
        partials[i] = "";
      }
      if (!partials[i]) partials[i] = deterministicSynthesis(query, chunk, chunkSources);
    }),
  );
  const partialFindings: WideResearchFinding[] = partials.map((text, i) => ({
    taskId: `wrs-${i + 1}`,
    index: i,
    angle: `partial report ${i + 1}`,
    question: query,
    summary: text,
    citations: [],
  }));
  return (await options.synthesizer({ query, findings: partialFindings, sources }, ctx)).trim();
}

// ---------------------------------------------------------------------------
// The core fan-out
// ---------------------------------------------------------------------------

/**
 * Plan, fan out and merge. The dispatcher and synthesizer are injected, so
 * this function is fully deterministic when they are.
 */
export async function runWideResearch(options: WideResearchRunOptions): Promise<WideResearchReport> {
  const query = options.query.trim();
  if (!query) throw new Error("wide_research requires a query");
  const sources = normalizeSources(options.sources);
  const items = normalizeSources(options.items);
  const breadth = clamp(options.breadth ?? WIDE_RESEARCH_DEFAULT_BREADTH, 1, WIDE_RESEARCH_MAX_BREADTH);
  const tasks = planResearchTasks(query, sources, breadth, items);
  const concurrency = clamp(options.concurrency ?? WIDE_RESEARCH_MAX_BREADTH, 1, WIDE_RESEARCH_MAX_BREADTH);
  const ctx: WideResearchContext = {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.taskId ? { taskId: options.taskId } : {}),
    ...(options.emit ? { emit: options.emit } : {}),
  };

  const outcomes = new Map<string, { ok: boolean; summary: string; citations: string[]; error?: string }>();
  let cursor = 0;

  const runOne = async (task: WideResearchTask): Promise<void> => {
    ctx.emit?.({
      type: "tool_call",
      name: "wideResearchSubSessionStatus",
      args: { subSessionId: task.id, index: task.index, angle: task.angle, status: "started" },
    });
    try {
      const result = await options.dispatcher(task, ctx);
      const summary = (result.summary ?? "").trim();
      const ok = result.ok !== false && summary.length > 0;
      const citations = dedupeCitations([...(result.citations ?? []), ...extractCitations(summary)]);
      outcomes.set(task.id, ok
        ? { ok: true, summary, citations }
        : { ok: false, summary, citations, ...(result.error ? { error: result.error } : { error: "empty result" }) });
      ctx.emit?.({
        type: "tool_result",
        name: "wideResearchSubSessionStatus",
        ok,
        summary: ok ? `sub-task ${task.id} finished (${task.angle})` : `sub-task ${task.id} failed: ${result.error ?? "empty result"}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      outcomes.set(task.id, { ok: false, summary: "", citations: [], error: message });
      ctx.emit?.({
        type: "tool_result",
        name: "wideResearchSubSessionStatus",
        ok: false,
        summary: `sub-task ${task.id} failed: ${message}`,
      });
    }
  };

  const worker = async (): Promise<void> => {
    while (cursor < tasks.length) {
      if (ctx.signal?.aborted) break;
      const task = tasks[cursor]!;
      cursor += 1;
      await runOne(task);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));

  const findings: WideResearchFinding[] = [];
  const taskStatus: WideResearchTaskStatus[] = [];
  const allCitations: string[] = [];

  for (const task of tasks) {
    const outcome = outcomes.get(task.id);
    if (outcome?.ok) {
      findings.push({
        taskId: task.id,
        index: task.index,
        angle: task.angle,
        question: task.question,
        ...(task.source ? { source: task.source } : {}),
        summary: outcome.summary,
        citations: outcome.citations,
      });
      allCitations.push(...outcome.citations);
      taskStatus.push({ id: task.id, index: task.index, angle: task.angle, ok: true });
    } else {
      taskStatus.push({
        id: task.id,
        index: task.index,
        angle: task.angle,
        ok: false,
        error: outcome?.error ?? "not completed",
      });
    }
  }

  const dedupedSources = dedupeCitations(allCitations);
  let summary = "";
  if (findings.length > 0) {
    try {
      summary = await runSynthesis(options, query, findings, dedupedSources, ctx);
    } catch {
      summary = "";
    }
  }
  if (!summary) summary = deterministicSynthesis(query, findings, dedupedSources);

  const failed = taskStatus.filter((t) => !t.ok).length;
  return {
    query,
    breadth,
    completed: findings.length,
    failed,
    summary,
    findings,
    sources: dedupedSources,
    tasks: taskStatus,
    ok: findings.length > 0,
  };
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export interface WideResearchOptions {
  ollama: OllamaClient;
  parentRegistry: ToolRegistry;
  /** Subagent profile label used in the child's system suffix. */
  defaultSubagent?: string;
  /** Tool allowlist for the research children. */
  childAllowTools?: string[];
  /** Max steps per child. */
  maxSteps?: number;
  /** Max children in flight (never above 20). */
  maxConcurrency?: number;
  /** Override the dispatcher (tests). */
  dispatcher?: WideResearchDispatcher;
  /** Override the synthesizer (tests). */
  synthesizer?: WideResearchSynthesizer;
}

/** Child tools: requested ∩ registered ∩ (tools this run may use). */
export function resolveChildAllowlist(
  parentRegistry: ToolRegistry,
  requested: readonly string[],
  runAllowed: readonly string[] | undefined,
): string[] {
  const registered = new Set(parentRegistry.names());
  const allowed = runAllowed ? new Set(runAllowed) : null;
  return requested.filter((name) => registered.has(name) && (!allowed || allowed.has(name)));
}

const CHILD_SYSTEM =
  "[Wide Research sub-agent]\n" +
  "You are one independent researcher in a wide-research fan-out. You never see the other researchers' work. " +
  "Investigate ONLY your assigned sub-question, using the read-only research tools available to you. " +
  "Ground every claim in what you actually read; never invent a source. " +
  "Reply with JSON only: {\"summary\": \"<your findings in prose>\", \"citations\": [\"<url>\", ...]}";

/** Prompt handed to a research child. */
export function buildChildPrompt(task: WideResearchTask): string {
  return [
    task.question,
    "",
    "Answer with JSON only:",
    '{"summary": "<your findings, 2-6 sentences>", "citations": ["<source url>", ...]}',
    "Include a citation for every source you actually used. If you found nothing solid, say so in the summary.",
  ].join("\n");
}

/** Prompt handed to the merge step. */
export function buildSynthesisPrompt(
  query: string,
  findings: readonly WideResearchFinding[],
  sources: readonly string[] = [],
): string {
  const blocks = findings.map((f) => {
    const head = f.source ? `ANGLE: ${f.angle}\nSOURCE: ${f.source}` : `ANGLE: ${f.angle}`;
    const cites = f.citations.length > 0 ? f.citations.join(", ") : "(no citation)";
    return `${head}\nFINDINGS: ${f.summary}\nURLS: ${cites}`;
  });
  const lines = [
    `QUESTION: ${query}`,
    "",
    "Independent research findings:",
    ...blocks,
  ];
  if (sources.length > 0) {
    lines.push("", `Cited sources (${sources.length}):`);
    for (const source of sources) lines.push(`- ${source}`);
  }
  lines.push(
    "",
    "Merge the findings above into ONE coherent report that answers the question.",
    "Rules: keep every distinct fact; do not add facts that are not in the findings; keep the source URLs next to the claims they support; " +
      "state disagreements and gaps explicitly; write in the language of the question; reply with the report only.",
  );
  return lines.join("\n");
}

function createDefaultDispatcher(options: WideResearchOptions, ctx: ToolContext): WideResearchDispatcher {
  const { ollama, parentRegistry } = options;
  const maxSteps = Math.min(Math.max(options.maxSteps ?? 10, 1), 30);
  return async (task, rctx) => {
    const { runAgent } = await import("../agent/loop.js");
    const allow = resolveChildAllowlist(
      parentRegistry,
      options.childAllowTools ?? WIDE_RESEARCH_CHILD_TOOLS,
      ctx.allowedTools,
    );
    const childRegistry = parentRegistry.forAllowlist(allow);
    const res = await runAgent({
      cfg: ctx.cfg,
      ollama,
      tools: childRegistry,
      emit: () => {
        /* child progress is summarized, not streamed into the parent transcript */
      },
      prompt: buildChildPrompt(task),
      systemSuffix: `${CHILD_SYSTEM}\nSubagent profile: ${options.defaultSubagent ?? "researcher"}`,
      maxSteps,
      signal: rctx.signal ?? ctx.signal,
      taskId: ctx.taskId,
      suppressFinal: true,
    });
    return parseTaskResult(res.text);
  };
}

function createDefaultSynthesizer(options: WideResearchOptions, ctx: ToolContext): WideResearchSynthesizer {
  const { ollama } = options;
  const maxSteps = Math.min(Math.max(options.maxSteps ?? 10, 1), 30);
  return async (input, rctx) => {
    const { runAgent } = await import("../agent/loop.js");
    const res = await runAgent({
      cfg: ctx.cfg,
      ollama,
      tools: options.parentRegistry.forAllowlist([]),
      emit: () => {
        /* the merge is silent */
      },
      prompt: buildSynthesisPrompt(input.query, input.findings, input.sources),
      systemSuffix: "[Wide Research controller]\nYou merge independent research findings into one report. You never invent facts.",
      maxSteps,
      signal: rctx.signal ?? ctx.signal,
      taskId: ctx.taskId,
      suppressFinal: true,
    });
    return res.text.trim();
  };
}

/** Build the `wide_research` tool. */
export function createWideResearchTool(options: WideResearchOptions): Tool {
  return {
    name: "wide_research",
    description:
      "Fan a research question out to N independent research sub-agents (1-20 in parallel, each with a fresh context and its own read-only research tools), then merge their findings into one report with deduplicated source citations. " +
      "Decompose the question yourself into an explicit list of items (questions, angles, subjects) and pass them via `items` so each item gets its own sub-agent; seed `sources` and automatic research angles fill the rest of the breadth. " +
      "Large finding sets are synthesized in two phases (a partial report per chunk, then one merged report). " +
      "Use it for broad 'research everything about X' questions and for researching a list of things at once; use web_search/web_fetch directly for a single lookup.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string",
          minLength: 1,
          description: "The research question to fan out.",
        },
        items: {
          type: "array",
          maxItems: WIDE_RESEARCH_MAX_BREADTH,
          items: { type: "string", minLength: 1 },
          description: "Explicit list of research items to dispatch one sub-agent over. Items are prioritized after seed sources; the total plan still never exceeds breadth.",
        },
        sources: {
          type: "array",
          maxItems: WIDE_RESEARCH_MAX_BREADTH,
          items: { type: "string", minLength: 1 },
          description: "Optional seed sources (URLs). Each one becomes its own sub-task.",
        },
        breadth: {
          type: "integer",
          minimum: 1,
          maximum: WIDE_RESEARCH_MAX_BREADTH,
          default: WIDE_RESEARCH_DEFAULT_BREADTH,
          description: "How many research sub-tasks to run in parallel (1-20).",
        },
      },
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const query = str(args, "query").trim();
      if (!query) return { ok: false, content: "wide_research requires a query" };
      const sources = normalizeSources(args.sources);
      const items = normalizeSources(args.items);
      const breadth = clamp(
        num(args, "breadth", Math.max(WIDE_RESEARCH_DEFAULT_BREADTH, sources.length + items.length)),
        1,
        WIDE_RESEARCH_MAX_BREADTH,
      );

      ctx.emit({
        type: "tool_call",
        name: "wide_research",
        args: { query, items: items.length, sources: sources.length, breadth },
      });

      const dispatcher = options.dispatcher ?? createDefaultDispatcher(options, ctx);
      const synthesizer = options.synthesizer ?? createDefaultSynthesizer(options, ctx);

      const report = await runWideResearch({
        query,
        items,
        sources,
        breadth,
        dispatcher,
        synthesizer,
        concurrency: options.maxConcurrency ?? WIDE_RESEARCH_MAX_BREADTH,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
        emit: ctx.emit,
      });

      ctx.emit({
        type: "tool_result",
        name: "wide_research",
        ok: report.ok,
        summary: `wide research finished: ${report.completed} finding(s), ${report.sources.length} source(s), ${report.failed} failed`,
      });

      return { ok: report.ok, content: JSON.stringify(report, null, 2) };
    },
  };
}
