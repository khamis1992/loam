/**
 * Structured context compaction (C8).
 *
 * The compressor triggers when the estimated token count of the transcript
 * reaches the model's context window minus a safety buffer. It then:
 *
 *   1. prunes old tool outputs in the middle to an elision marker,
 *   2. replaces the middle with a *structured* summary written by an auxiliary
 *      model call, using eight numbered sections that preserve intent, facts,
 *      files and code, errors and fixes, every user message, the pending work,
 *      the current work and the next step,
 *   3. re-attaches the most recently read files (truncated) and the live todo
 *      list as a hidden reminder so the model never loses its footing,
 *   4. runs a PreCompact hook before the summarizer call, letting a workspace
 *      script observe or veto compaction.
 *
 * Nothing here drops the system prompt or the newest message. A tool_call is
 * never separated from its tool_result, and a summarizer failure degrades to
 * pruning only.
 */
import type { Config } from "../config.js";
import type { ChatMessage, OllamaClient } from "../ollama.js";
import fs from "node:fs";
import path from "node:path";
import { chatWithFallback } from "./model.js";
import { isCancelledError } from "../server/runControl.js";
import type { Emit, Usage, TodoItem } from "./events.js";
import { reminderMessage } from "./reminders.js";
import { runPreCompactHooks, type PreCompactHookInput } from "../policy/hooks.js";
import { ReadState } from "../tools/readState.js";

/** Marker inserted where a pruned tool output used to be. */
export const ELISION_MARKER = (chars: number) => `[... ${chars} chars elided ...]`;
/** Label that marks a compaction summary message. */
export const SUMMARY_LABEL = "compaction summary";

/** The eight section headers the summarizer must produce, in order. */
export const SUMMARY_SECTIONS = [
  "1. Primary Request and Intent",
  "2. Key Concepts and Technical Facts",
  "3. Files and Code Snippets",
  "4. Errors Encountered and Fixes Applied",
  "5. All User Messages (condensed, verbatim where short)",
  "6. Pending Tasks and Open Questions",
  "7. Current Work",
  "8. Next Step",
] as const;

/** Tool outputs shorter than this are never worth eliding. */
const MIN_ELIDE_CHARS = 200;
/** Hard floor so the system prompt and the newest message can never be dropped. */
const MIN_PROTECT_LEAD = 1;
const MIN_PROTECT_TAIL = 1;

export interface CompressionResult {
  messages: ChatMessage[];
  /** False when the transcript is under the trigger threshold. */
  compressed: boolean;
  /** 0 = nothing, 1 = prune only, 2 = prune + summarize. */
  step: 0 | 1 | 2;
  /** Token cost of the auxiliary summarizer call (0 when no call was made). */
  usage: Usage;
  /** Hidden reminder re-attaching recent file contents and the todo list. */
  reminders: ChatMessage[];
  /** True when a PreCompact hook vetoed the compaction. */
  hookBlocked: boolean;
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

/**
 * The token count at which compaction must start: the earlier of the ratio
 * threshold and the window minus the safety buffer. The buffer reserves room
 * for the answer, the re-attached files and the next tool outputs.
 */
export function getCompressionThreshold(cfg: Config, model: string): number {
  const window = getContextWindow(cfg, model);
  const ratioThreshold = Math.floor(window * cfg.compression.thresholdPercent);
  const buffer = Number.isFinite(cfg.compression.bufferTokens) && cfg.compression.bufferTokens > 0
    ? cfg.compression.bufferTokens
    : 20000;
  return Math.max(1, Math.min(ratioThreshold, window - buffer));
}

function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.2;
  return Math.min(0.8, Math.max(0.1, ratio));
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
  const text = content
    .slice(idx + SUMMARY_LABEL.length)
    .replace(/^[\s\]\)]+/, "")
    .replace(/^\s*[:\-—]?\s*/, "")
    .trim();
  return text.length > 0 ? text : null;
}

/** True when every required section header is present in the summary. */
export function hasAllSummarySections(content: string): boolean {
  return SUMMARY_SECTIONS.every((header) => content.includes(header));
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

const SUMMARY_SYSTEM_PROMPT = [
  "You are the context-compaction summarizer for an AI coding agent.",
  "Your output becomes the agent's working memory after a long conversation is folded away, so it must be complete and faithful.",
  "Produce the summary as exactly the eight numbered sections listed in the user message, in that order, with no extra preamble.",
  "Write in the user's language when the conversation is not in English.",
  "Never invent facts, file paths, identifiers, commands or test results that are not present in the input. Do not reproduce full file contents or full command outputs.",
  "Preserve exact identifiers, file paths, line numbers, error text and decisions. Prefer terse bullet points over prose.",
].join("\n");

/** Build the user prompt that asks the summarizer for the eight-section schema. */
function buildSummaryPrompt(middle: ChatMessage[], previousSummary: string | null, targetChars: number): string {
  const sections = [
    "Summarize the conversation segment below into a durable working memory. Use these eight sections and these exact headers, in this order:",
    SUMMARY_SECTIONS.join("\n"),
    "",
    "Rules:",
    "- Every section must appear, even when it holds a single short line such as \"(none so far)\".",
    "- Section 5 must include EVERY user message that is present in the segment, condensed but never dropped.",
    "- Keep the total near the target length, but never drop a fact that the next step depends on.",
    `- Target length: about ${targetChars} characters.`,
    "- Do not invent facts, and do not paste whole files or whole tool outputs.",
    "",
    renderTranscript(middle),
  ];
  if (previousSummary) {
    sections.push("", "Previous compaction summary (update it, keeping still-relevant facts):", previousSummary);
  }
  return sections.join("\n");
}

/** Truncate a file snapshot to its first `maxChars` characters, marking the cut. */
function truncateSnapshot(content: string, maxChars: number): string {
  const limit = Math.max(1, maxChars);
  if (content.length <= limit) return content;
  return `${content.slice(0, limit)}\n[... snapshot truncated: ${content.length - limit} more chars not re-attached ...]`;
}

/**
 * Re-attach the most recently read files (newest first, truncated) and the live
 * todo list. The reminder is a hidden user-role tagged block: the model reads it
 * as fresh context while the UI never renders it.
 */
export function buildReattachReminder(options: {
  readState: ReadState;
  workspace: string;
  todos: TodoItem[];
  reattachFiles: number;
  reattachFileChars: number;
}): string {
  const { readState, workspace, todos, reattachFiles, reattachFileChars } = options;
  const parts: string[] = ["The conversation was compacted. Re-orient with the facts below, then continue the task."];

  const reads = readState.recent(reattachFiles).map((entry) => {
    let body = "";
    try {
      body = fs.readFileSync(path.resolve(entry.path), "utf8");
    } catch {
      body = "(file is no longer readable)";
    }
    const relative = path.relative(workspace, entry.path) || entry.path;
    return `### ${relative} (read ${entry.readAt.toISOString()})\n${truncateSnapshot(body, reattachFileChars)}`;
  });
  if (reads.length > 0) parts.push("## Recently read files\n" + reads.join("\n\n"));

  if (todos.length > 0) {
    const lines = todos.map((t) => `- [${t.status}] ${t.content}`);
    parts.push("## Live task list (todo_write)\n" + lines.join("\n"));
  }

  return parts.join("\n\n");
}

export interface CompressOptions {
  cfg: Config;
  ollama: OllamaClient;
  messages: ChatMessage[];
  emit: Emit;
  signal?: AbortSignal;
  /** Per-session read tracking; supplies the files re-attached after compaction. */
  readState?: ReadState;
  /** Current live task list, re-attached after compaction. */
  todos?: TodoItem[];
  /** Model name for context-window lookup (defaults to cfg.model). */
  model?: string;
}

/**
 * Compress an agent transcript when it exceeds the configured fraction of the
 * model's context window or the window minus the safety buffer. Never drops the
 * system prompt or the newest message.
 */
export async function compressContext(
  cfg: Config,
  ollama: OllamaClient,
  messages: ChatMessage[],
  emit: Emit,
  signal?: AbortSignal,
  extra?: Pick<CompressOptions, "readState" | "todos" | "model">,
): Promise<CompressionResult> {
  const options: CompressOptions = { cfg, ollama, messages, emit, todos: [], ...(signal ? { signal } : {}), ...(extra ?? {}) };
  const model = options.model ?? cfg.model;
  const window = getContextWindow(cfg, model);
  const threshold = getCompressionThreshold(cfg, model);
  const originalTokens = totalTokens(messages);

  if (originalTokens <= threshold) {
    return { messages, compressed: false, step: 0, usage: zeroUsage(), reminders: [], hookBlocked: false };
  }

  // PreCompact hook: a workspace script may observe or veto the compaction.
  const hookInput: PreCompactHookInput = {
    model,
    window,
    threshold,
    tokens: originalTokens,
    messages: messages.length,
  };
  const hook = await runPreCompactHooks(hookInput, cfg.workspace);
  if (hook.blocked) {
    emit({ type: "compaction", step: 1, originalTokens, afterPruneTokens: originalTokens, finalTokens: originalTokens, fallback: true, blocked: true });
    return { messages, compressed: false, step: 0, usage: zeroUsage(), reminders: [], hookBlocked: true };
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
    return { messages, compressed: false, step: 0, usage: zeroUsage(), reminders: [], hookBlocked: false };
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
    return { messages: afterPrune, compressed: true, step: 1, usage: zeroUsage(), reminders: [], hookBlocked: false };
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
    return { messages: afterPrune, compressed: true, step: 1, usage: zeroUsage(), reminders: [], hookBlocked: false };
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
    return { messages: afterPrune, compressed: true, step: 1, usage: zeroUsage(), reminders: [], hookBlocked: false };
  }

  const summaryMessage: ChatMessage = {
    role: "assistant",
    content: `[${SUMMARY_LABEL}]\n${summaryText}`,
  };
  const finalMessages = [...lead, summaryMessage, ...tail];
  const finalTokens = totalTokens(finalMessages);

  // Re-attach recent file reads and the live todo list as a hidden reminder.
  const reminders: ChatMessage[] = [];
  const reattachFiles = Math.max(0, Math.floor(cfg.compression.reattachFiles));
  const reattachFileChars = Math.max(1, Math.floor(cfg.compression.reattachFileChars));
  const todos = options.todos ?? [];
  if (todos.length > 0 || (reattachFiles > 0 && options.readState)) {
    const body = buildReattachReminder({
      readState: options.readState ?? new ReadState(),
      workspace: cfg.workspace,
      todos,
      reattachFiles,
      reattachFileChars,
    });
    reminders.push(reminderMessage(body));
  }

  emit({
    type: "compaction",
    step: 2,
    originalTokens,
    afterPruneTokens,
    finalTokens,
    summaryChars: summaryText.length,
  });

  return { messages: finalMessages, compressed: true, step: 2, usage: summaryUsage, reminders, hookBlocked: false };
}
