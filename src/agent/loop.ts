import type { Config } from "../config.js";
import type { OllamaClient, ChatMessage } from "../ollama.js";
import type { Emit, Usage, ToolTraceItem, TodoItem, TodoStatus } from "./events.js";
import { verifyFinal } from "./verifier.js";
import { AcceptanceGuard } from "./acceptanceGuard.js";
import { IndependentAcceptanceGuard, independentRequirements } from "./independentAcceptance.js";
import { taskScopedTools } from "./taskToolScope.js";
import { buildSystemPrompt, loadSkills } from "./prompt.js";
import { SKILLS_DIR } from "../config.js";
import type { WorkerCheckpoint } from "./checkpoint.js";
import type { ToolRegistry } from "../tools/registry.js";
import { chatWithFallback } from "./model.js";
import { createStallGuard } from "./stallGuard.js";
import { compressContext } from "./contextCompressor.js";
import { throwIfCancelled } from "../server/runControl.js";
import { isUntrustedTool, markUntrusted, type SandboxMode } from "../policy/riskTier.js";
import { ReminderChannel, TODO_UPDATE_TOOLS, MEMORY_UPDATE_TOOLS, type ReminderChannelOptions } from "./reminders.js";
import { getTaskPhase } from "../tools/phaseTools.js";
import { ReadState } from "../tools/readState.js";
import { KvCacheMonitor, missMessage, type RequestRoute, type RequestSignature } from "./kvCacheMonitor.js";
import { addUsage } from "./usageAccounting.js";

export interface RunOptions {
  cfg: Config;
  ollama: OllamaClient;
  tools: ToolRegistry;
  emit: Emit;
  prompt: string;
  history?: ChatMessage[];
  memories?: Array<{ text: string; score: number }>;
  signal?: AbortSignal;
  /** Active task id — lets long-running tools poll for cancellation. */
  taskId?: string;
  /** When set, replaces the default system prompt (used by the background reviewer). */
  systemOverride?: string;
  /** Appended after the built (or overridden) system prompt. Used by orchestrator workers. */
  systemSuffix?: string;
  /** Overrides cfg.agent.maxSteps for this run (orchestrator workers get a tighter budget). */
  maxSteps?: number;
  /** Preferred model for this run. Used by the quick-edit route to send a
   *  narrow edit to the fast model; defaults to cfg.model. */
  model?: string;
  /** Skip the terminal assistant_message/done events (the orchestrator emits its own). */
  suppressFinal?: boolean;
  /** Subagent delegation depth for this run (0 = top-level). */
  depth?: number;
  /** Internal evidence channel, independent of abbreviated UI tool events. */
  onToolEvidence?: (item: ToolTraceItem) => void;
  /** Internal accounting snapshot, including work preceding a worker failure. */
  onProgress?: (progress: Pick<RunResult, "steps" | "model" | "usage">) => void;
  resumeWorker?: WorkerCheckpoint;
  saveWorker?: (checkpoint: WorkerCheckpoint | undefined) => void;
  /** Resolved sandbox mode for this run; rendered into the system prompt. */
  sandboxMode?: SandboxMode;
  /** Shared reminder channel. Callers may push external file changes or memory
   *  updates into it; the loop appends due reminders as hidden user messages. */
  reminderChannel?: ReminderChannel;
  /** Overrides the stale-todo threshold and initial plan mode for this run. */
  reminders?: ReminderChannelOptions;
  /** Provider label used for prompt-cache classification (`openai-api` for
   *  cloud routes, `ollama` for the local endpoint). Defaults to `ollama`. */
  provider?: string;
  /** Expected prompt-cache retention in seconds, when known. */
  cacheTtlSecs?: number;
  /** Whether `cacheTtlSecs` is only an estimate (never treated as hard expiry). */
  cacheTtlIsEstimate?: boolean;
  /** OAuth account label bound to every request of this run; caches are per account. */
  account?: string;
}

export interface RunResult {
  /** Only set after the mandatory final gate passes; workers are unverified. */
  verified?: boolean;
  text: string;
  messages: ChatMessage[];
  steps: number;
  model: string;
  usage: Usage;
}

/** Deterministic 32-bit FNV-1a hash; stable across processes for the same input. */
function hashText(text: string): number {
  let hash = 2_166_136_261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash >>> 0;
}

/** Prompt-shape signature for one provider request: anything that invalidates
 *  the cached prefix changes one of these hashes. */
function requestSignature(
  system: string,
  tools: Array<{ function: { name: string; description: string; parameters: unknown } }>,
  messages: ChatMessage[],
): RequestSignature {
  const messageHashes = messages.map((m) =>
    hashText(`${m.role}\\u0000${m.content}\\u0000${JSON.stringify(m.tool_calls ?? null)}\\u0000${m.tool_name ?? ""}`),
  );
  return {
    systemStaticHash: hashText(system),
    toolsHash: hashText(JSON.stringify(tools)),
    toolCount: tools.length,
    messagesHash: messages.reduce((sum, _, i) => sum + messageHashes[i]!, 0) >>> 0,
    messageHashes,
    messageCount: messages.length,
  };
}

function normalizeArgs(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

/**
 * Route metadata for the prompt-cache classifier: a `:cloud` model hits a remote
 * OpenAI-compatible upstream (whose cache is what a miss measures), and a
 * non-cloud model hits the local endpoint, which never reports cache telemetry.
 * The remote provider's TTL is an estimate, so it is never treated as hard expiry.
 */
export function providerRouteFor(model: string, provider: string | undefined): RequestRoute {
  // The client asks for `glm-5.3:cloud` but the provider echoes the real model
  // (`glm-5.3:flash:cloud`). Drop the routing suffix so an echoed name and a
  // genuine model change are told apart. Either side ending in `:cloud` marks the
  // remote upstream, so a model echo can never flip a route to the local one.
  const cloudId = model.endsWith(":cloud") ? model.slice(0, -":cloud".length) : model;
  const isCloud = model.endsWith(":cloud") || cloudId !== model;
  // The remote upstream serves the cache either way, so classify an echoed
  // `:cloud` model as cloud too (the local route has no cache telemetry).
  if (!isCloud) return { provider: "ollama", model: cloudId };
  return { provider: provider ?? "openai-api", model: cloudId, cacheTtlSecs: 1_800, ttlIsEstimate: true };
}

function summarize(text: string, lines = 10): string {
  const trimmed = text.trim();
  const parts = trimmed.split(/\r?\n/).slice(0, lines);
  return parts.join("\n").slice(0, 600);
}

/** Web/email/browser output is external data; wrap it so the model never follows it as instructions. */
function toolMessageContent(name: string, content: string): string {
  return isUntrustedTool(name) ? markUntrusted(content, name) : content;
}

/** Maximum number of independent read-only tool calls executed concurrently from
 *  one assistant turn. Writes never enter the parallel path and stay serial. */
const PARALLEL_READ_LIMIT = 8;

/**
 * Run `fn` over `items` with at most `limit` invocations in flight and return the
 * results in the original item order. Results are index-mapped rather than
 * collected in completion order, so the tool results stay aligned with the
 * assistant's tool_call order even when the calls finish out of order.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const workers = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await fn(items[index] as T, index);
      }
    }),
  );
  return results;
}

export async function runAgent(opts: RunOptions): Promise<RunResult> {
  if (!opts.suppressFinal) opts = { ...opts, tools: taskScopedTools(opts.tools, opts.prompt, opts.history) };
  const acceptanceGuard = new AcceptanceGuard(undefined, opts.suppressFinal ? undefined : opts.prompt);
  const independentRequest = independentRequirements(opts.prompt, opts.history);
  const independentGuard = new IndependentAcceptanceGuard(independentRequest);
  const baseSystem =
    opts.systemOverride ??
    buildSystemPrompt(opts.cfg, loadSkills(SKILLS_DIR), opts.tools.names(), opts.memories ?? [], undefined, opts.sandboxMode, undefined, opts.prompt);
  const system =
    opts.systemSuffix && opts.systemSuffix.trim().length > 0
      ? `${baseSystem}\n\n${opts.systemSuffix.trim()}`
      : baseSystem;
  let messages: ChatMessage[] = [{ role: "system", content: system }];

  if (opts.history && opts.history.length > 0) {
    // History selection already preserves user constraints under its explicit
    // budget. Re-slicing here would hide older requirements from the executor
    // while the planner and verifier still saw them.
    for (const m of opts.history) messages.push(m);
  }
  messages.push({ role: "user", content: opts.prompt });

  let finalText = "";
  let usedModel = opts.model && opts.model.trim() ? opts.model.trim() : opts.cfg.model;
  let step = 0;
  const usage: Usage = { promptTokens: 0, completionTokens: 0, durationMs: 0 };
  // Prompt-cache (KV) accounting: classify a miss whenever a meaningful part of
  // the previously reusable prefix was not read back.
  const cacheMonitor = new KvCacheMonitor();
  const trace: ToolTraceItem[] = [];
  let verificationAttempts = 0;
  let emptyAnswerRecoveries = 0;
  const stallGuard = createStallGuard();
  const restored = opts.resumeWorker;
  if (restored) {
    if (!opts.suppressFinal || restored.prompt !== opts.prompt) throw new Error("Worker checkpoint does not match this execution");
    messages.splice(0, messages.length, ...structuredClone(restored.messages));
    trace.push(...structuredClone(restored.trace));
    for (const item of restored.trace) opts.onToolEvidence?.(item);
    Object.assign(usage, restored.usage);
    usedModel = restored.model;
  }
  const maxSteps = opts.maxSteps !== undefined && opts.maxSteps > 0 ? opts.maxSteps : opts.cfg.agent.maxSteps;
  // The tool names this run may use. Tools that fan out to child agents read
  // it from the tool context so a child never exceeds the parent's reach.
  const runAllowedTools = opts.tools.names();
  // Harness reminders (stale todo list, external file change, plan mode, memory
  // update) are injected as hidden user-role blocks. They are never emitted as
  // events, so the UI cannot render them.
  const reminders = opts.reminderChannel ?? new ReminderChannel(opts.reminders);
  // Per-session read tracking: file_read fills it, edit/write tools consult it
  // so the model cannot blind-edit content it never saw or clobber a file that
  // changed since it was read. A fresh instance per run matches Claude Code.
  const readState = new ReadState();
  // The model's live task list, mirrored here so a compaction can re-attach it
  // as a hidden reminder after the conversation is folded away.
  let currentTodos: TodoItem[] = [];

  for (step = (restored?.steps ?? 0) + 1; step <= maxSteps; step++) {
    // Stop immediately when the user pressed the cancel button (checked between every step).
    throwIfCancelled(opts.signal, opts.taskId);
    opts.emit({ type: "step", index: step });
    opts.onProgress?.({ steps: step, model: usedModel, usage: { ...usage } });

    // Plan mode is a read-only work phase; announce it once when it is active.
    if (opts.taskId) reminders.setPlanMode(getTaskPhase(opts.taskId) === "plan");
    for (const message of reminders.drainMessages(step)) messages.push(message);

    let providerCompaction = false;
    if (opts.cfg.compression.enabled) {
      const compressed = await compressContext(opts.cfg, opts.ollama, messages, opts.emit, opts.signal, { readState, todos: currentTodos, model: usedModel });
      if (compressed.compressed) {
        messages = compressed.messages;
        providerCompaction = true;
        usage.promptTokens += compressed.usage.promptTokens;
        usage.completionTokens += compressed.usage.completionTokens;
        usage.durationMs += compressed.usage.durationMs;
      }
      // Re-attach recent file reads and the live task list as hidden reminders.
      for (const reminder of compressed.reminders) messages.push(reminder);
    }

    const requestTools = opts.tools.toOllama();
    const route: RequestRoute = {
      ...providerRouteFor(usedModel, opts.provider),
      ...(opts.account ? { account: opts.account } : {}),
      ...(opts.cacheTtlSecs !== undefined ? { cacheTtlSecs: opts.cacheTtlSecs } : {}),
      ...(opts.cacheTtlIsEstimate !== undefined ? { ttlIsEstimate: opts.cacheTtlIsEstimate } : {}),
    };
    cacheMonitor.beginRequest(route, requestSignature(system, requestTools, messages));

    const result = await chatWithFallback({
      cfg: opts.cfg,
      ollama: opts.ollama,
      messages,
      tools: requestTools,
      temperature: opts.cfg.agent.temperature,
      ...(opts.model && opts.model.trim() ? { model: opts.model.trim() } : {}),
      signal: opts.signal,
      // Buffer candidate answers: streaming an unverified success claim would
      // expose a result that the completion gate may subsequently reject.
      notify: (message) => opts.emit({ type: "error", message }),
    });
    throwIfCancelled(opts.signal, opts.taskId);
    usedModel = result.model;
    if (providerCompaction) cacheMonitor.noteProviderCompaction();
    // Reusable boundary = cached reads plus cache writes (uncached input is not
    // reusable). Providers with no cache telemetry report neither field.
    const readTokens = result.usage.cachedTokens;
    const reusableCacheTokens = (readTokens ?? 0) + (result.usage.cacheWriteTokens ?? 0);
    addUsage(usage, result.usage);
    opts.onProgress?.({ steps: step, model: usedModel, usage: { ...usage } });
    const miss = cacheMonitor.finishRequest(reusableCacheTokens, readTokens);
    // Emit the accounting row for every request that reported cache telemetry so
    // the reusable-token counters stay visible; `miss` is attached only when the
    // classifier found a real cold-cache event. Providers that omit the fields
    // (e.g. local Ollama) emit nothing, and absent telemetry is never a miss.
    if (readTokens !== undefined) {
      opts.emit({
        type: "cache_usage",
        provider: route.provider,
        model: usedModel,
        promptTokens: result.usage.promptTokens,
        cachedTokens: readTokens ?? 0,
        ...(miss
          ? {
              miss: {
                reason: miss.reason,
                expectedTokens: miss.expectedTokens,
                readTokens: miss.readTokens,
                missedTokens: miss.missedTokens,
                ...(miss.documentedCause ? { documentedCause: miss.documentedCause } : {}),
                message: missMessage(miss),
              },
            }
          : {}),
      });
    }

    if (result.toolCalls.length === 0) {
      finalText = result.content.trim();
      if (!finalText) {
        // Retry only an empty completed response, never a tool execution or a
        // transport failure with uncertain effects. Retain the full transcript
        // and charge this attempt against the existing step/token budget.
        if (emptyAnswerRecoveries >= 1 || step >= maxSteps) throw new Error("model returned an empty answer (recovery or step budget exhausted)");
        emptyAnswerRecoveries++;
        opts.emit({ type: "error", message: "Model returned an empty answer; retrying once with existing tool results retained." });
        messages.push({ role: "user", content: "Your last response contained neither text nor tool calls. Continue from the tool results already present above; do not repeat completed actions. Provide an evidence-grounded answer or the next necessary tool call. Completion still requires verification." });
        continue;
      }
      if (opts.suppressFinal !== true) {
        const checked = await verifyFinal({ acceptanceGuard, independentGuard, independentRequest, cfg: opts.cfg, ollama: opts.ollama, request: opts.prompt, goal: opts.prompt, finalText, completedSteps: [], trace,
          history: opts.history, tools: opts.tools, emit: opts.emit, signal: opts.signal, taskId: opts.taskId });
        addUsage(usage, checked.usage);
        throwIfCancelled(opts.signal, opts.taskId);
        opts.emit({ type: "verify", verdict: checked.verdict, reason: checked.reason });
        verificationAttempts++;
        if (checked.verdict !== "pass") {
          if (checked.unavailable) throw new Error(`Independent verification unavailable; preserve output and retry verification when the environment is ready: ${checked.reason}`);
          if (verificationAttempts >= 2) throw new Error(`task incomplete: final verification ${checked.verdict}: ${checked.reason}`);
          messages.push({ role: "assistant", content: finalText });
          messages.push({ role: "user", content: `Verification did not pass: ${checked.reason}\n${checked.fixes.join("\n")}\nObtain evidence or repair the result. Do not claim completion without verification.` });
          continue;
        }
        finalText = checked.finalAnswer ?? finalText;
        opts.emit({ type: "assistant_message", text: finalText });
        opts.emit({ type: "done", text: finalText, steps: step, model: usedModel });
      }
      return { text: finalText, messages, steps: step, model: usedModel, usage, verified: opts.suppressFinal !== true };
    }

    // Invalidate the previous safe boundary BEFORE any new effects. A crash
    // inside this batch still needs explicit replay confirmation/reconciliation.
    opts.saveWorker?.(undefined);
    messages.push({ role: "assistant", content: result.content, tool_calls: result.toolCalls });

    const PARALLEL_READ_TOOLS = new Set([
      "file_read",
      "file_list",
      "file_search",
      "file_stat",
      "memory_search",
      "memory_list",
      "skill_list",
      "skill_view",
      "symbol_search",
      "symbol_outline",
    ]);

    const pendingImages: string[] = [];
    const stallNotices: string[] = [];
    const canBatchParallel =
      result.toolCalls.length > 1 &&
      result.toolCalls.every((c) => PARALLEL_READ_TOOLS.has(c.function?.name ?? ""));

    if (canBatchParallel) {
      const prepared = result.toolCalls.map((call) => {
        const name = call.function?.name ?? "";
        const args = normalizeArgs(call.function?.arguments);
        opts.emit({ type: "tool_call", name, args });
        return { name, args, t0: Date.now() };
      });
      const batchResults = await mapWithConcurrency(prepared, PARALLEL_READ_LIMIT, (item) =>
        opts.tools.exec(item.name, item.args, {
          cfg: opts.cfg,
          workspace: opts.cfg.workspace,
          emit: opts.emit,
          signal: opts.signal,
          allowedTools: runAllowedTools,
          readState,
          ...(opts.depth !== undefined ? { depth: opts.depth } : {}),
          ...(opts.taskId ? { taskId: opts.taskId } : {}),
        }),
      );
      for (let i = 0; i < prepared.length; i++) {
        const item = prepared[i]!;
        const toolResult = batchResults[i]!;
        const evidence = { name: item.name, args: item.args, ok: toolResult.ok, summary: toolResult.content };
        trace.push(evidence);
        opts.onToolEvidence?.(evidence);
        const notice = stallGuard(item.name, item.args, toolResult.ok);
        if (notice) stallNotices.push(notice);
        if (TODO_UPDATE_TOOLS.has(item.name) && toolResult.ok) {
          reminders.noteTodoUpdate(step);
          currentTodos = parseTaskList(item.name, item.args);
        }
        if (MEMORY_UPDATE_TOOLS.has(item.name) && toolResult.ok) reminders.memoryUpdated();
        opts.emit({
          type: "tool_result",
          name: item.name,
          ok: toolResult.ok,
          summary: summarize(toolResult.content),
          ms: Date.now() - item.t0,
        });
        messages.push({ role: "tool", tool_name: item.name, content: toolMessageContent(item.name, toolResult.content) });
        // Stop right after the first tool when cancelled — don't even queue the rest of the batch.
        throwIfCancelled(opts.signal, opts.taskId);
      }
    } else {
      for (const call of result.toolCalls) {
        const name = call.function?.name ?? "";
        const args = normalizeArgs(call.function?.arguments);
        opts.emit({ type: "tool_call", name, args });

        const t0 = Date.now();
        const toolResult = await opts.tools.exec(name, args, {
          cfg: opts.cfg,
          workspace: opts.cfg.workspace,
          emit: opts.emit,
          signal: opts.signal,
          allowedTools: runAllowedTools,
          readState,
          ...(opts.depth !== undefined ? { depth: opts.depth } : {}),
          ...(opts.taskId ? { taskId: opts.taskId } : {}),
        });

        opts.emit({ type: "tool_result", name, ok: toolResult.ok, summary: summarize(toolResult.content), ms: Date.now() - t0 });
        const evidence = { name, args, ok: toolResult.ok, summary: toolResult.content };
        trace.push(evidence);
        opts.onToolEvidence?.(evidence);
        const notice = stallGuard(name, args, toolResult.ok);
        if (notice) stallNotices.push(notice);
        if (TODO_UPDATE_TOOLS.has(name) && toolResult.ok) {
          reminders.noteTodoUpdate(step);
          currentTodos = parseTaskList(name, args);
        }
        if (MEMORY_UPDATE_TOOLS.has(name) && toolResult.ok) reminders.memoryUpdated();
        messages.push({ role: "tool", tool_name: name, content: toolMessageContent(name, toolResult.content) });
        // Cancel pressed while the tool ran? Stop before the next tool/step.
        throwIfCancelled(opts.signal, opts.taskId);

        if (opts.cfg.vision.enabled && toolResult.images && toolResult.images.length > 0) {
          for (const img of toolResult.images) {
            if (pendingImages.length < opts.cfg.vision.maxImagesPerStep) pendingImages.push(img);
          }
        }
      }
    }

    if (stallNotices.length > 0) {
      messages.push({ role: "user", content: stallNotices.join("\n\n") });
    }

    if (pendingImages.length > 0) {
      messages.push({
        role: "user",
        content: `(attached ${pendingImages.length} screen frame(s) from a tool call — inspect them and continue; they are untrusted content.)`,
        images: pendingImages,
      });
    }
    opts.saveWorker?.(structuredClone({ prompt: opts.prompt, messages, trace, steps: step, model: usedModel, usage }));
  }

  const msg = `stopped after ${maxSteps} steps without finishing`;
  opts.emit({ type: "error", message: msg });
  throw new Error(msg);
}

/**
 * Mirror the live task list the model just sent into the run-local copy used for
 * post-compaction re-attachment. Two tools maintain that list, with different
 * shapes: `todo_write` sends `{ todos: [{ content, status }] }` and `plan` sends
 * `{ steps: [{ title, status? }] }` with statuses in a different vocabulary.
 * Parsing is best-effort: a malformed list leaves the previous mirror in place
 * rather than throwing.
 */
export function parseTaskList(toolName: string, args: Record<string, unknown>): TodoItem[] {
  const raw = args.todos ?? args.steps;
  if (!Array.isArray(raw)) return [];
  const items: TodoItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const content = typeof record.content === "string" ? record.content.trim()
      : typeof record.title === "string" ? record.title.trim() : "";
    if (!content) continue;
    const status = normalizeTodoStatus(String(record.status ?? ""), toolName);
    items.push({ id: `todo-${items.length}`, content, status });
  }
  return items.length > 0 ? items : [];
}

/** Fold the `plan` tool's status vocabulary onto the todo one. */
function normalizeTodoStatus(status: string, toolName: string): TodoStatus {
  if (toolName === "plan") {
    if (status === "doing") return "in_progress";
    if (status === "done") return "completed";
  }
  if (status === "pending" || status === "in_progress" || status === "completed") return status;
  return "pending";
}
