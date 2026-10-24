import type { ChatMessage } from "../../ollama.js";
import { applyDecisions } from "./apply.js";
import { decide } from "./decide.js";
import { collectPairs } from "./pairing.js";
import type { PairScore, PruneConfig, PrunedSink, PruneResult, PruneScorer, PruneStats, ToolMeta, ToolPair } from "./types.js";

export interface PruneContext {
  cfg: PruneConfig;
  goal: string;
  todos: string[];
  meta: ReadonlyMap<ChatMessage, ToolMeta>;
  scorer: PruneScorer;
  fallback: PruneScorer;
  store: PrunedSink;
  protectLead?: number;
  signal?: AbortSignal;
}

const msgChars = (m: ChatMessage): number =>
  m.content.length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);
const totalChars = (ms: readonly ChatMessage[]): number => ms.reduce((n, m) => n + msgChars(m), 0);

function emptyStats(chars: number, scorer: string): PruneStats {
  return { charsBefore: chars, charsAfter: chars, kept: 0, truncated: 0, dropped: 0, pinned: 0, scorer, fallback: false, requests: 0 };
}

export async function pruneTranscript(messages: readonly ChatMessage[], ctx: PruneContext): Promise<PruneResult> {
  const { cfg } = ctx;
  const before = totalChars(messages);
  const stats = emptyStats(before, ctx.scorer.name);
  const unchanged = (reason: string, decisions: PruneResult["decisions"] = []): PruneResult =>
    ({ applied: false, reason, messages: messages.slice(), decisions, stats });

  const pairs = collectPairs(messages, ctx.meta, {
    protectLead: ctx.protectLead ?? 0,
    preserveRecent: cfg.preserveRecent,
    pinnedTools: new Set(cfg.pinnedTools),
  });
  stats.pinned = pairs.filter(p => p.pinned).length;
  if (pairs.every(p => p.pinned)) return unchanged("nothing to prune");

  const bodies = new Map<string, string>();
  for (const p of pairs) if (p.toolIndex >= 0) bodies.set(p.id, messages[p.toolIndex]!.content);

  const byId = new Map<string, ToolPair>(pairs.map(p => [p.id, p]));
  const laterAssistantText = (id: string): string => {
    const p = byId.get(id);
    if (!p) return "";
    let out = "";
    for (let i = p.assistantIndex + 1; i < messages.length; i++) {
      const m = messages[i]!;
      if (m.role === "assistant" && m.content) out += `${m.content}\n`;
    }
    return out;
  };
  let lastAssistant = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant" && messages[i]!.content) { lastAssistant = messages[i]!.content; break; }
  }
  const input = {
    goal: ctx.goal,
    query: [ctx.goal, lastAssistant, ...ctx.todos].filter(Boolean).join("\n"),
    pairs, bodies, laterAssistantText,
  };

  const complete = (m: Map<string, PairScore>): boolean => pairs.every(p => m.has(p.id));
  let scores: Map<string, PairScore> | undefined;
  try {
    stats.requests++;
    const got = await ctx.scorer.score(input, ctx.signal);
    if (complete(got)) scores = got;
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
  }
  if (!scores) {
    stats.fallback = ctx.scorer !== ctx.fallback;
    stats.scorer = ctx.fallback.name;
    scores = await ctx.fallback.score(input, ctx.signal);
  }

  const decisions = pairs.map(p => decide(p, scores!.get(p.id) ?? { keepCall: 1, keepResult: 1 }, cfg.keepThreshold));
  for (const d of decisions) {
    if (d.reason === "pinned") continue;
    if (d.action === "keep") stats.kept++;
    else if (d.action === "truncate_result") stats.truncated++;
    else stats.dropped++;
  }

  const out = applyDecisions(messages, pairs, decisions, cfg.headChars, ctx.store);
  stats.charsAfter = totalChars(out);
  if (before === 0 || stats.charsAfter / before > 1 - cfg.minReduction) {
    return unchanged("insufficient reduction", decisions);
  }
  return { applied: true, reason: "pruned", messages: out, decisions, stats };
}
