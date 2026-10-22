// Adapted from jcode (MIT) src/compaction/compaction-core.rs:
// emergency compaction constants, truncation marker and head/tail shape.

import type { Config } from "../config.js";
import type { ChatMessage, OllamaClient } from "../ollama.js";
import { chatWithFallback } from "./model.js";
import { isCancelledError } from "../server/runControl.js";
import type { Emit, Usage } from "./events.js";

/** Marker inserted where a pruned tool output used to be. */
export const ELISION_MARKER = (chars: number) => `[... ${chars} chars elided ...]`;
/** Label that marks a compaction summary message. */
export const SUMMARY_LABEL = "compaction summary";
/** Marker inserted in place of a tool output truncated during emergency recovery. */
export const EMERGENCY_TRUNCATION_MARKER = (chars: number) =>
  `... [${chars} chars truncated for context recovery] ...`;

/** Tool outputs shorter than this are never worth eliding. */
const MIN_ELIDE_CHARS = 200;
/** Hard floor so the system prompt and the newest message can never be dropped. */
const MIN_PROTECT_LEAD = 1;
const MIN_PROTECT_TAIL = 1;

export interface CompressionResult {
  messages: ChatMessage[];
  /** False when the transcript is under the trigger threshold. */
  compressed: boolean;
  /** 0 = nothing, 1 = prune only, 2 = prune + summarize, 3 = emergency hard-compact. */
  step: 0 | 1 | 2 | 3;
  /** True when the synchronous emergency path was used (no summarizer call). */
  emergency?: boolean;
  /** Turns dropped by the emergency path. */
  droppedTurns?: number;
  /** Token estimate before emergency recovery. */
  tokensBefore?: number;
  /** Token estimate after emergency recovery. */
  tokensAfter?: number;
  /** Token cost of the auxiliary summarizer call (0 when no call was made). */
  usage: Usage;
}

function zeroUsage(): Usage {
  return { promptTokens: 0, completionTokens: 0, durationMs: 0 };
}

/** Rough token estimate: ~4 characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function messageTokens(message: ChatMessage): number {
  let tokens = estimateTokens(message.content ?? "");
  for (const call of message.tool_calls ?? []) {
    tokens += estimateTokens(call.function?.name ?? "");
    tokens += estimateTokens(JSON.stringify(call.function?.arguments ?? {}));
  }
  return tokens;
}

export function totalTokens(messages: ReadonlyArray<ChatMessage>): number {
  return messages.reduce((sum, m) => sum + messageTokens(m), 0);
}

/** Longest-prefix match against the configured per-model context windows. */
export function getContextWindow(cfg: Config, model: string): number {
  let best = 0;
  let bestPrefix = "";
  for (const [prefix, size] of Object.entries(cfg.compression.contextWindow)) {
    if (model.startsWith(prefix) && prefix.length > bestPrefix.length) {
      best = size;
      bestPrefix = prefix;
    }
  }
  return best > 0 ? best : 32768;
}

function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.2;
  return Math.min(0.8, Math.max(0.1, ratio));
}

function clampCriticalRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.95;
  // Never above the trigger: otherwise the emergency path could be unreachable.
  return Math.min(0.99, Math.max(0.05, ratio));
}

function clampKeepTurns(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

function clampEmergencyChars(value: number): number {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 4000;
}

function isToolCallMessage(message: ChatMessage): boolean {
  return message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
}

/** True when the message is a compaction summary we produced earlier. */
export function isSummaryMessage(message: ChatMessage): boolean {
  return message.role === "assistant" && (message.content ?? "").toLowerCase().includes(SUMMARY_LABEL);
}

/** Extract the text of an earlier compaction summary (without the label). */
export function extractSummary(content: string): string | null {
  const idx = content.toLowerCase().indexOf(SUMMARY_LABEL);
  if (idx < 0) return null;
  const text = content.slice(idx + SUMMARY_LABEL.length).replace(/^\s*[:\-]?\s*/, "").trim();
  return text.length > 0 ? text : null;
}

/**
 * Step 1 (no LLM): shrink old tool outputs in the middle to an elision marker.
 * Tool outputs are only shrunk when their owning tool_call is inside the middle,
 * so a tool_call is never separated from its tool_result by the boundary.
 */
function pruneMiddle(middle: ChatMessage[]): { messages: ChatMessage[]; elidedChars: number } {
  const out = middle.map((m) => ({ ...m }));
  let elidedChars = 0;
  for (let i = 0; i < out.length; i++) {
    const message = out[i]!;
    if (message.role !== "tool") continue;
    let owner = -1;
    for (let j = i - 1; j >= 0; j--) {
      const prev = out[j]!;
      if (isToolCallMessage(prev)) {
        owner = j;
        break;
      }
      if (prev.role === "tool") continue;
      break;
    }
    if (owner < 0) continue;
    const chars = message.content?.length ?? 0;
    if (chars < MIN_ELIDE_CHARS) continue;
    out[i] = { ...message, content: ELISION_MARKER(chars) };
    elidedChars += chars;
  }
  return { messages: out, elidedChars };
}

/**
 * Emergency recovery: bound a single oversized tool output to `maxChars` by
 * keeping a head and a tail around a truncation marker. Unlike `pruneMiddle`
 * this runs on the whole transcript and can touch tool results whose owning
 * tool_call sits in the protected lead, so a huge recent screenshot output is
 * still trimmed when the context is already critical.
 */
export function emergencyTruncateToolResults(
  messages: ChatMessage[],
  maxChars: number,
): { messages: ChatMessage[]; truncated: number } {
  if (maxChars <= 0 || !Number.isFinite(maxChars)) return { messages, truncated: 0 };
  const out = messages.map((m) => ({ ...m }));
  let truncated = 0;
  for (const message of out) {
    if (message.role !== "tool") continue;
    const content = message.content ?? "";
    if (content.length <= maxChars) continue;
    const keepHead = Math.floor(maxChars / 2);
    const keepTail = Math.floor(maxChars / 4);
    const head = content.slice(0, keepHead);
    const tail = content.length - keepTail > head.length ? content.slice(content.length - keepTail) : "";
    const dropped = content.length - head.length - tail.length;
    message.content = [head, EMERGENCY_TRUNCATION_MARKER(dropped), tail].join("\n\n");
    truncated++;
  }
  return { messages: out, truncated };
}

/** Number of trailing messages kept verbatim when the context is already critical. */
export function emergencyKeepTurns(cfg: Config): number {
  return clampKeepTurns(cfg.compression.recentTurnsToKeep, 10);
}

/** Absolute floor for messages kept during emergency compaction. */
export function emergencyMinTurns(cfg: Config): number {
  return clampKeepTurns(cfg.compression.minTurnsToKeep, 2);
}

/** Max characters kept for a single tool result during emergency recovery. */
export function emergencyToolResultMaxChars(cfg: Config): number {
  return clampEmergencyChars(cfg.compression.emergencyToolResultMaxChars);
}

function renderTranscript(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      if (m.role === "tool") return `[tool:${m.tool_name ?? "unknown"}] ${m.content}`;
      if (isToolCallMessage(m)) {
        const calls = (m.tool_calls ?? [])
          .map((c) => `${c.function?.name ?? "?"}(${JSON.stringify(c.function?.arguments ?? {})})`)
          .join(", ");
        return `[assistant/tool] ${m.content || ""} ${calls}`.trim();
      }
      return `[${m.role}] ${m.content}`;
    })
    .join("\n\n");
}

function buildSummaryPrompt(middle: ChatMessage[], previousSummary: string | null, targetChars: number): string {
  const sections = [
    "Summarize the following conversation segment for context compaction.",
    `Target length: about ${targetChars} characters.`,
    "Always preserve, when present: open tasks, decisions made, files touched, errors encountered, and any facts needed to continue.",
    "Do not invent facts. Do not reproduce raw file contents or full command outputs.",
    "",
    renderTranscript(middle),
  ];
  if (previousSummary) {
    sections.push("", "Previous compaction summary (update it, keeping still-relevant facts):", previousSummary);
  }
  return sections.join("\n");
}

const SUMMARY_SYSTEM_PROMPT =
  "You are a context compaction summarizer for an AI agent. Produce a concise compaction summary of the conversation segment you are given.";

/**
 * Synchronous emergency recovery for a transcript that is already past the
 * critical threshold: drop old turns down to a small verbatim tail and bound
 * every oversized tool output. No auxiliary model call, so it can never fail or
 * add latency to the next provider request.
 */
function emergencyCompact(
  cfg: Config,
  messages: ChatMessage[],
  window: number,
  originalTokens: number,
): CompressionResult {
  const keep = Math.min(
    emergencyKeepTurns(cfg),
    Math.max(emergencyMinTurns(cfg), messages.length - MIN_PROTECT_LEAD),
  );
  const lead = messages.slice(0, MIN_PROTECT_LEAD);
  let tailStart = messages.length - keep;
  // Keep tool_call/tool_result pairs together: if the tail would start on a tool
  // result, pull its owning tool_call (and any preceding tool results) into the
  // tail so the provider never receives an orphaned result.
  while (tailStart > MIN_PROTECT_LEAD && messages[tailStart]!.role === "tool") tailStart--;
  const tail = messages.slice(tailStart);
  const dropped = messages.length - lead.length - tail.length;
  // The protected lead can hold the newest huge tool output (its owning tool_call
  // lives there), so it is truncated too; only the very newest message survives
  // untouched so the model still sees the latest user turn.
  const leadTrunc = emergencyTruncateToolResults(lead, emergencyToolResultMaxChars(cfg)).messages;
  const tailTrunc = emergencyTruncateToolResults(tail, emergencyToolResultMaxChars(cfg)).messages;
  const emergencyMessage: ChatMessage = {
    role: "assistant",
    content: `[${SUMMARY_LABEL}]\nEmergency compaction: ${dropped} older turns were dropped and oversized tool outputs truncated because the context exceeded ${Math.round(
      criticalThreshold(cfg) * 100,
    )}% of the ${Math.round(window / 1000)}k window. Re-read the task list, plan and any file you need before continuing.`,
  };
  const finalMessages = [...leadTrunc, emergencyMessage, ...tailTrunc];
  const finalTokens = totalTokens(finalMessages);
  return {
    messages: finalMessages,
    compressed: true,
    step: 3,
    usage: zeroUsage(),
    emergency: true,
    droppedTurns: dropped,
    tokensBefore: originalTokens,
    tokensAfter: finalTokens,
  };
}

/** Critical threshold as a fraction of the context window (default 0.95). */
export function criticalThreshold(cfg: Config): number {
  return clampCriticalRatio(cfg.compression.criticalThresholdPercent);
}

/**
 * Compress an agent transcript when it exceeds the configured fraction of the
 * model's context window. Never drops the system prompt or the newest message.
 */
export async function compressContext(
  cfg: Config,
  ollama: OllamaClient,
  messages: ChatMessage[],
  emit: Emit,
  signal?: AbortSignal,
): Promise<CompressionResult> {
  const window = getContextWindow(cfg, cfg.model);
  const threshold = Math.floor(window * cfg.compression.thresholdPercent);
  // The emergency path must always be reachable: a critical ratio at or below the
  // trigger would make it dead code, so it is raised to the trigger.
  const criticalRatio = Math.max(cfg.compression.thresholdPercent, criticalThreshold(cfg));
  const critical = Math.floor(window * criticalRatio);
  const originalTokens = totalTokens(messages);

  if (originalTokens <= threshold) {
    return { messages, compressed: false, step: 0, usage: zeroUsage() };
  }

  // Critical: the next request would not fit. Recover synchronously instead of
  // spending an auxiliary summarizer call on a transcript that is already too big.
  if (originalTokens > critical) {
    const emergency = emergencyCompact(cfg, messages, window, originalTokens);
    emit({
      type: "compaction",
      step: 3,
      originalTokens,
      afterPruneTokens: originalTokens,
      finalTokens: emergency.tokensAfter ?? originalTokens,
      emergency: true,
      droppedTurns: emergency.droppedTurns,
    });
    return emergency;
  }

  // Safety floors: the system prompt (index 0) and the newest message always survive.
  const protectLead = Math.max(MIN_PROTECT_LEAD, Math.min(cfg.compression.protectLead, messages.length));
  const protectTail = Math.max(MIN_PROTECT_TAIL, Math.min(cfg.compression.protectTail, Math.max(0, messages.length - protectLead)));

  // Move the boundaries so a tool_call is never separated from its tool_result:
  // a tool-result run that starts the middle is pulled into the lead, and a run
  // that starts the tail pulls its owning tool_call into the tail.
  let leadEnd = protectLead;
  while (leadEnd < messages.length && messages[leadEnd]!.role === "tool") leadEnd++;

  let middleEnd = messages.length - protectTail;
  if (middleEnd > leadEnd && middleEnd < messages.length && messages[middleEnd]!.role === "tool") {
    let owner = middleEnd - 1;
    while (owner >= leadEnd && messages[owner]!.role === "tool") owner--;
    if (owner >= leadEnd && isToolCallMessage(messages[owner]!)) middleEnd = owner;
  }
  if (middleEnd < leadEnd) middleEnd = leadEnd;

  const lead = messages.slice(0, leadEnd);
  let middle = messages.slice(leadEnd, middleEnd);
  let tail = messages.slice(middleEnd);

  // Drop a previous compaction summary (outside the lead) so it can be updated
  // instead of duplicated.
  let previousSummary: string | null = null;
  if (previousSummary === null) {
    const idx = middle.findIndex((m) => isSummaryMessage(m));
    if (idx >= 0) {
      previousSummary = extractSummary(middle[idx]!.content);
      middle = middle.filter((_, i) => i !== idx);
    }
  }
  if (previousSummary === null) {
    const idx = tail.findIndex((m) => isSummaryMessage(m));
    if (idx >= 0) {
      previousSummary = extractSummary(tail[idx]!.content);
      tail = tail.filter((_, i) => i !== idx);
    }
  }

  if (middle.length === 0) {
    return { messages, compressed: false, step: 0, usage: zeroUsage() };
  }

  const { messages: prunedMiddle } = pruneMiddle(middle);
  const afterPrune = [...lead, ...prunedMiddle, ...tail];
  const afterPruneTokens = totalTokens(afterPrune);

  if (afterPruneTokens <= threshold) {
    emit({
      type: "compaction",
      step: 1,
      originalTokens,
      afterPruneTokens,
      finalTokens: afterPruneTokens,
    });
    return { messages: afterPrune, compressed: true, step: 1, usage: zeroUsage() };
  }

  const middleChars = prunedMiddle.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  const targetChars = Math.max(1, Math.round(middleChars * clampRatio(cfg.compression.targetRatio)));
  const prompt = buildSummaryPrompt(prunedMiddle, previousSummary, targetChars);

  let summaryText: string;
  let summaryUsage: Usage;
  try {
    const result = await chatWithFallback({
      cfg,
      ollama,
      messages: [
        { role: "system", content: SUMMARY_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      model: cfg.compression.model || undefined,
      temperature: 0.1,
      signal,
    });
    summaryText = result.content.trim();
    summaryUsage = {
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      durationMs: result.usage.durationMs,
    };
  } catch (err) {
    if (isCancelledError(err) || signal?.aborted) throw err;
    // Step 2 failed: keep the cheap prune and never lose the protected head/tail.
    emit({
      type: "compaction",
      step: 1,
      originalTokens,
      afterPruneTokens,
      finalTokens: afterPruneTokens,
      fallback: true,
    });
    return { messages: afterPrune, compressed: true, step: 1, usage: zeroUsage() };
  }

  if (summaryText.length === 0) {
    emit({
      type: "compaction",
      step: 1,
      originalTokens,
      afterPruneTokens,
      finalTokens: afterPruneTokens,
      fallback: true,
    });
    return { messages: afterPrune, compressed: true, step: 1, usage: zeroUsage() };
  }

  const summaryMessage: ChatMessage = {
    role: "assistant",
    content: `[${SUMMARY_LABEL}]\n${summaryText}`,
  };
  const finalMessages = [...lead, summaryMessage, ...tail];
  const finalTokens = totalTokens(finalMessages);

  emit({
    type: "compaction",
    step: 2,
    originalTokens,
    afterPruneTokens,
    finalTokens,
    summaryChars: summaryText.length,
  });

  return { messages: finalMessages, compressed: true, step: 2, usage: summaryUsage };
}
