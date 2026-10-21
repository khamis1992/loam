/**
 * deep_research — an iterative research loop that turns a topic into a
 * structured markdown report with inline numbered citations.
 *
 * Loop per iteration: plan queries -> search via web_search (src/tools/web.ts)
 * -> read the top unread pages via web_fetch -> harvest quotable sentences ->
 * gap-check the topic's aspects -> queue gap-driven queries for the next
 * iteration. The final report carries [n] citation markers inline and a
 * numbered sources list.
 *
 * Original Loam implementation; no third-party research-pipeline code is
 * copied. The tool only consumes the public run() of the web tools, so tests
 * can mock globalThis.fetch end to end.
 */
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { num, str } from "./registry.js";
import { webTools } from "./web.js";

const MAX_QUERIES_PER_ITER = 2;
const MAX_READS_PER_ITER = 3;
const MAX_SOURCES = 10;
const SENTENCES_PER_SOURCE = 6;

/** Topic aspects the loop tries to cover; gap queries target the uncovered ones. */
const ASPECTS = [
  { id: "overview", heading: "Overview", words: ["what is", "overview", "introduction", "definition", "مقدمة", "تعريف"], query: "overview" },
  { id: "how", heading: "How It Works", words: ["how", "work", "mechanism", "architecture", "process", "steps", "كيف", "طريقة"], query: "how it works" },
  { id: "examples", heading: "Examples and Practice", words: ["example", "use case", "tutorial", "guide", "practical", "case study", "أمثلة", "مثال"], query: "examples use cases" },
  { id: "limits", heading: "Limitations and Risks", words: ["limitation", "drawback", "risk", "problem", "criticism", "challenge", "current state", "حدود", "مشاكل"], query: "limitations risks" },
] as const;

interface FoundPage {
  url: string;
  title: string;
}

interface Harvested {
  text: string;
  score: number;
  aspects: string[];
}

interface ReadSource {
  n: number;
  url: string;
  title: string;
  items: Harvested[];
}

export interface DeepResearchResult {
  ok: boolean;
  /** Markdown report; empty when ok is false. */
  report: string;
  iterations: number;
  /** Citation numbers are 1..sourceCount. */
  sourceCount: number;
  coveredAspects: string[];
  uncoveredAspects: string[];
  reason?: string;
}

async function callWebTool(name: "web_search" | "web_fetch", args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const tool = webTools.find((t) => t.name === name);
  if (!tool) throw new Error(`web tool ${name} is not available`);
  return tool.run(args, ctx);
}

function urlKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.search = "";
    return `${u.hostname.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
}

/** Call web_search and parse its JSON result payload. */
async function searchOnce(query: string, ctx: ToolContext): Promise<FoundPage[]> {
  const res = await callWebTool("web_search", { query, limit: 5 }, ctx);
  if (!res.ok) return [];
  try {
    const parsed = JSON.parse(res.content) as { results?: Array<{ title?: string; url?: string }> };
    const found: FoundPage[] = [];
    for (const r of parsed.results ?? []) {
      if (typeof r.url === "string" && /^https?:\/\//i.test(r.url)) {
        found.push({ url: r.url, title: typeof r.title === "string" && r.title ? r.title : r.url });
      }
    }
    return found;
  } catch {
    return [];
  }
}

/** Call web_fetch and return the text body past its status/header lines. */
async function fetchText(url: string, ctx: ToolContext): Promise<string | null> {
  const res = await callWebTool("web_fetch", { url, maxBytes: 200_000 }, ctx);
  if (!res.ok) return null;
  const split = res.content.indexOf("\n\n");
  const body = split >= 0 ? res.content.slice(split + 2) : res.content;
  return body.trim() || null;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** Extract quotable sentences from one page body, scored against the topic. */
function harvestSentences(body: string, topicTokens: Set<string>): Harvested[] {
  const parts = body
    .split(/(?<=[.!?؟。])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 60 && s.length <= 500 && /[\p{L}]{4,}/u.test(s));
  const out: Harvested[] = [];
  for (const sentence of parts) {
    const held = tokens(sentence);
    let overlap = 0;
    for (const t of held) if (topicTokens.has(t)) overlap += 1;
    const lower = sentence.toLowerCase();
    const aspects = ASPECTS.filter((a) => a.words.some((w) => lower.includes(w))).map((a) => a.id);
    const score = overlap * 3 + aspects.length;
    if (score === 0) continue;
    if (out.some((h) => jaccard(tokens(h.text), held) > 0.75)) continue;
    out.push({ text: sentence, score, aspects });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, SENTENCES_PER_SOURCE);
}

function renderReport(
  topic: string,
  sources: ReadSource[],
  summary: string[],
  uncovered: string[],
  iterations: number,
): string {
  const lines: string[] = [];
  lines.push(`# Deep Research: ${topic}`, "");
  lines.push(`_Built from ${sources.length} source(s) over ${iterations} search iteration(s)._`, "");
  lines.push("## Summary", "");
  for (const s of summary) lines.push(`- ${s}`);
  lines.push("");
  for (const aspect of ASPECTS) {
    const items = sources.flatMap((src) =>
      src.items.filter((h) => h.aspects.includes(aspect.id)).map((h) => `- ${h.text} [${src.n}]`),
    );
    if (!items.length) continue;
    lines.push(`## ${aspect.heading}`, "");
    for (const item of items) lines.push(item);
    lines.push("");
  }
  if (uncovered.length) {
    lines.push("## Gaps", "");
    for (const id of uncovered) {
      const heading = ASPECTS.find((a) => a.id === id)?.heading ?? id;
      lines.push(`- No usable source verified the "${heading}" aspect; treat that section as unknown.`);
    }
    lines.push("");
  }
  lines.push("## Sources", "");
  for (const src of sources) lines.push(`${src.n}. ${src.title} — ${src.url}`);
  lines.push("");
  return lines.join("\n");
}

/** The plan -> search -> read -> gap-check -> repeat loop. */
export async function runDeepResearch(topic: string, depth: number, ctx: ToolContext): Promise<DeepResearchResult> {
  const topicTokens = tokens(topic);
  const runQueries = new Set<string>();
  const candidates: FoundPage[] = [];
  const seenUrls = new Set<string>();
  const readUrls = new Set<string>();
  const sources: ReadSource[] = [];
  const covered = new Set<string>();
  let iterations = 0;

  for (let round = 0; round < Math.max(1, Math.min(3, depth)); round += 1) {
    iterations = round + 1;
    // PLAN: first round probes the topic; later rounds target uncovered aspects.
    const planned =
      round === 0
        ? [topic]
        : ASPECTS.filter((a) => !covered.has(a.id))
            .slice(0, MAX_QUERIES_PER_ITER)
            .map((a) => `${topic} ${a.query}`);
    const queries: string[] = [];
    for (const q of planned) {
      const key = q.toLowerCase();
      if (!runQueries.has(key)) {
        runQueries.add(key);
        queries.push(q);
      }
    }
    if (!queries.length) break;

    // SEARCH: collect candidate pages from every query, deduped by URL key.
    let searchFailed = true;
    for (const q of queries) {
      for (const page of await searchOnce(q, ctx)) {
        searchFailed = false;
        const key = urlKey(page.url);
        if (!seenUrls.has(key) && candidates.length < MAX_SOURCES * 4) {
          seenUrls.add(key);
          candidates.push(page);
        }
      }
    }

    // READ: fetch the top unread candidates and harvest their sentences.
    const toRead = candidates.filter((c) => !readUrls.has(urlKey(c.url))).slice(0, MAX_READS_PER_ITER);
    if (!toRead.length && !searchFailed) break;
    for (const page of toRead) {
      const key = urlKey(page.url);
      readUrls.add(key);
      const body = await fetchText(page.url, ctx);
      if (!body) continue;
      const items = harvestSentences(body, topicTokens);
      if (!items.length) continue;
      if (sources.length >= MAX_SOURCES) break;
      for (const h of items) for (const a of h.aspects) covered.add(a);
      sources.push({ n: sources.length + 1, url: page.url, title: page.title, items });
    }
    // Gap-check: nothing readable this round and still nothing built -> stop.
    if (round > 0 && sources.length === 0 && readUrls.size > 0) break;
  }

  const summary = sources
    .flatMap((src) => src.items.map((h) => ({ ...h, n: src.n })))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((h) => `${h.text} [${h.n}]`);

  if (!sources.length) {
    return {
      ok: false,
      report: "",
      iterations,
      sourceCount: 0,
      coveredAspects: [],
      uncoveredAspects: [...ASPECTS.map((a) => a.id)],
      reason: "No sources could be fetched or none contained quotable text about the topic (check network access or refine the topic).",
    };
  }

  const uncovered = ASPECTS.filter((a) => !covered.has(a.id)).map((a) => a.id);
  return {
    ok: true,
    report: renderReport(topic, sources, summary, uncovered, iterations),
    iterations,
    sourceCount: sources.length,
    coveredAspects: [...ASPECTS.map((a) => a.id)].filter((id) => covered.has(id)),
    uncoveredAspects: uncovered,
  };
}

export function createDeepResearchTools(): Tool[] {
  return [
    {
      name: "deep_research",
      description:
        "Run an iterative research loop (plan queries, web search, read pages, coverage gap-check, repeat) and return a structured markdown report with inline numbered citations and a sources list. Requires networkEnabled.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Research topic (1-2000 characters)." },
          depth: { type: "number", minimum: 1, maximum: 3, description: "Search iterations, 1-3 (default 2)." },
        },
        required: ["topic"],
      },
      async run(args, ctx) {
        if (!ctx.cfg.policy.networkEnabled) return { ok: false, content: "Network access is disabled" };
        const topic = str(args, "topic").trim();
        if (!topic || topic.length > 2000) return { ok: false, content: "Provide a research topic of 1-2000 characters" };
        const depth = Math.floor(num(args, "depth", 2));
        const result = await runDeepResearch(topic, depth, ctx);
        if (!result.ok) return { ok: false, content: result.reason ?? "deep_research could not produce a report" };
        return { ok: true, content: result.report };
      },
    },
  ];
}
