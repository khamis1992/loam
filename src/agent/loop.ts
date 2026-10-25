import type { Config } from "../config.js";
import type { ChatResult, OllamaClient, ChatMessage } from "../ollama.js";
import type { Emit, Usage, ToolTraceItem, TodoItem, TodoStatus } from "./events.js";
import { verifyFinal } from "./verifier.js";
import { AcceptanceGuard } from "./acceptanceGuard.js";
import { IndependentAcceptanceGuard, independentRequirements } from "./independentAcceptance.js";
import { taskScopedTools } from "./taskToolScope.js";
import { buildSystemPrompt } from "./prompt.js";
import { loadProjectSkills } from "../tools/skills.js";
import type { WorkerCheckpoint } from "./checkpoint.js";
import type { ToolRegistry } from "../tools/registry.js";
import { chatWithFallback } from "./model.js";
import { chatWithCodingRouter, isCodingTurn } from "../llm/codingRouter.js";
import { chatWithRouting } from "../tools/routingModel.js";
import {
  effortStepBudget,
  isOutputType,
  normalizeEffort,
  outputTypeSuffix,
  outputTypeTools,
  type EffortLevel,
  type OutputType,
} from "../llm/router.js";
import { isEditTool, recordEditModel } from "../llm/modelAudit.js";
import type { CooldownStore, FailoverProvider, ProviderClient } from "../llm/failover.js";
import { createStallGuard } from "./stallGuard.js";
import { ciWatchEscalationNotice } from "./ciWatchLoop.js";
import { compressContext, getContextWindow } from "./contextCompressor.js";
import { PrunedStore } from "./prune/prunedStore.js";
import type { ToolMeta } from "./prune/types.js";
import { ContextSelector } from "./contextSelector.js";
import { runLifecycleHooks, wrapHookContext } from "../policy/hooks.js";
import { throwIfCancelled, isCancelled, isCancelledError } from "../server/runControl.js";
import { openSession, closeSession } from "./sessionHooks.js";
import { isUntrustedTool, markUntrusted, type SandboxMode } from "../policy/riskTier.js";
import { ReminderChannel, TODO_UPDATE_TOOLS, MEMORY_UPDATE_TOOLS, type ReminderChannelOptions } from "./reminders.js";
import { getTaskPhase } from "../tools/phaseTools.js";
import { ReadState } from "../tools/readState.js";
import {
  checkBudget,
  consumeCost,
  consumeSteps,
  consumeTokens,
  consumeWallClock,
  createUnlimitedBudget,
  type ComputeBudget,
} from "./computeBudget.js";
import { estimateCostUsd } from "./insights.js";
import { budgetStoppedCheckpoint, budgetSummary, resumeStep, type MissionCheckpoint } from "./mission.js";
import { fileTouchRegistry, forgetFileTouchSession } from "../tools/fileTouch.js";
import { KvCacheMonitor, missMessage, type RequestRoute, type RequestSignature } from "./kvCacheMonitor.js";
import { addUsage } from "./usageAccounting.js";
import { recordToolCall, recordToolResult } from "./checkpointLog.js";
import { log } from "../log.js";
import { addRunSiblings, getRunNodes, setRunNodeData, setRunNodeStatus } from "./runGraphAdapter.js";
import { takeCanvasDirectives } from "./runGraphAdapter.js";
import { canvasEditsMessage, directiveBody, directiveTitle, CANVAS_EDIT_ARTEFACT_KIND } from "./canvasContext.js";
import { eventNodeId, type RunNode } from "../graph/store.js";
import { admitPending, hasPending, type QueuedInput } from "../server/inputQueue.js";

/** Stable per-tool-call id: the model's own id when it supplies one, otherwise
 *  a synthetic id derived from the turn and call index. */
function toolCallIdOf(call: { function?: { name?: string; arguments?: unknown }; id?: string }, turn: number, index: number): string {
  const id = typeof call.id === "string" && call.id.trim() ? call.id.trim() : "";
  return id || `call_${turn}_${index}`;
}

/** Neo N10 A/B: the run's root node is the natural parent of its sibling arms. */
function siblingParentFor(opts: RunOptions): string {
  const taskId = opts.taskId ?? "";
  const root = getRunNodes(taskId).find((node) => node.type === "question");
  if (root) return root.id;
  return eventNodeId("run", taskId);
}
/** Collapse whitespace so a stored arm answer stays one readable line. */
function oneLine(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Neo N10 A/B: run one sibling arm.
 *
 * Recording an arm is not the same as answering it: this hands the run's own
 * system prompt and prompt to the arm's model, moves the node through the real
 * lifecycle (`init` -> `running` -> `finished`/`failed`/`skipped`) and stores the
 * answer on the node so the canvas shows what that model produced. An arm is a
 * comparison, never a dependency: its failure is recorded on its own node and
 * never fails the run that owns it.
 */
async function runAbArm(
  opts: RunOptions,
  system: string,
  arm: RunNode,
  model: string,
): Promise<void> {
  const runId = opts.taskId ?? "";
  try {
    setRunNodeStatus(arm.id, "running", runId);
    const result = await chatWithFallback({
      cfg: opts.cfg,
      ollama: opts.ollama,
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: opts.prompt },
      ],
      temperature: opts.cfg.agent.temperature,
      timeoutMs: opts.cfg.agent.requestTimeoutMs,
      ...(opts.signal ? { signal: opts.signal } : {}),
      notify: (message) => opts.emit({ type: "error", message }),
    });
    const answer = result.content.trim();
    const existing = (arm.data ?? {}) as Record<string, unknown>;
    setRunNodeData(arm.id, { ...existing, model: result.model, answer: oneLine(answer) }, runId);
    setRunNodeStatus(arm.id, "finished", runId);
    opts.emit({ type: "assistant_message", text: `A/B arm finished on ${result.model}.` });
  } catch (err) {
    // A cancelled arm is "skipped", not "failed": the user stopped the run, so the
    // arm never had a chance to answer.
    if (isCancelledError(err) || opts.signal?.aborted || isCancelled(runId)) {
      setRunNodeStatus(arm.id, "skipped", runId);
      return;
    }
    const reason = err instanceof Error ? err.message : String(err);
    const existing = (arm.data ?? {}) as Record<string, unknown>;
    setRunNodeData(arm.id, { ...existing, model, error: oneLine(reason) }, runId);
    setRunNodeStatus(arm.id, "failed", runId);
    opts.emit({ type: "error", message: `A/B arm ${model} failed: ${reason}` });
  }
}

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
  /** Stable id of THIS agent session inside its workspace. Distinct sessions
   *  (orchestrator workers, sub-agents, map-reduce children) get distinct ids so
   *  a write by one notifies the others (jcode J8 file-touch notifications).
   *  Defaults to the task id, so a single run still tracks its own reads. */
  sessionId?: string;
  /** When set, replaces the default system prompt (used by the background reviewer). */
  systemOverride?: string;
  /** Appended after the built (or overridden) system prompt. Used by orchestrator workers.
   *  H5: the correction-learning lesson block joins this suffix (src/index.ts, BUILD_SPEC §6.5). */
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
  /** D19: per-session compute budget (steps/tokens) enforced inside this run.
   *  The runtime store owns the counters; the loop only consults it. */
  budget?: ComputeBudget;
  /** Neo N6: this run is a mission (no fixed step cap). The step ceiling is
   *  lifted and the extended budget (steps/tokens/wall-clock/cost) governs it.
   *  A checkpoint is written after every completed step so a server restart
   *  resumes the mission instead of losing it. */
  mission?: boolean;
  /** Neo N6: persist a mission checkpoint after each step. Omitted for a
   *  non-mission run; failures are swallowed so persistence never fails a run. */
  saveMissionCheckpoint?: (checkpoint: import("./mission.js").MissionCheckpoint) => void;
  /** Neo N6: resume a mission from this durable checkpoint (step index and
   *  budget counters), instead of starting from step 1. */
  resumeMission?: import("./mission.js").MissionCheckpoint;
  /** Internal seam for the coding-model router: builds the client for one
   *  failover provider. Defaults to the real provider client (network). Tests
   *  inject a fake so routing can be verified without contacting a model. */
  createProviderClient?: (provider: FailoverProvider) => ProviderClient;
  /** Internal seam: persisted failover cooldown store. Defaults to the on-disk
   *  store. Tests inject an in-memory store so a failed provider never leaves a
   *  process-wide cooldown behind. */
  cooldownStore?: CooldownStore;
  /** Internal seam: environment used to resolve provider keys. Defaults to
   *  `process.env`; tests inject a fake env so no real key is read. */
  env?: Record<string, string | undefined>;
  /** Called once per model call with the resolved coding model and chain. */
  onCodingRoute?: (info: { model: string; chain: string[]; providerId?: string }) => void;
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
  /** Event-log session for this run. When set, every tool call is recorded in the
   *  durable log with a `started` row before it runs and a terminal row after, so
   *  a call that began without finishing is visible after a crash. */
  eventLogSession?: string;
  /** Neo N10: the composer's output type (Auto/Text/Image/Video/Slides/Website). */
  outputType?: OutputType | "";
  /** Neo N10: the composer's effort level (Fast/Max). */
  effort?: EffortLevel | "";
  /** Neo N10: also run the same prompt on 2-4 other models as sibling canvas nodes. */
  abModels?: string[];
  /** Neo N10: create the A/B sibling nodes on this parent node of the run graph. */
  abParentNodeId?: string;
  /**
   * O6 durable input queue: a user message sent while this run is busy is stored
   * as `received` and admitted here, at a step boundary, so it is never lost.
   * The hook appends the `input` event and returns the admitted messages; a
   * failure must never break the run, so the caller swallows and logs it.
   */
  onAdmitPending?: (sessionId: string) => QueuedInput[];
  /** Session id whose queued messages this run should admit (defaults to taskId). */
  inputSessionId?: string;
  /**
   * Neo N5: the per-step context selector. When omitted the loop builds one
   * from `cfg.contextSelector`; a disabled config keeps the pre-N5 behaviour.
   * A caller may inject its own instance to share a store across a fan-out.
   */
  contextSelector?: ContextSelector;
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

/**
 * Neo N6: the mission stopped because it reached its budget ceiling.
 *
 * It carries the checkpoint at the stop so the caller can persist it and the
 * canvas can render a summary node, and it is distinguished from a real failure
 * (`isMissionBudgetError`) so a caller never reports a clean budget stop as an
 * error.
 */
export class MissionBudgetError extends Error {
  readonly checkpoint: MissionCheckpoint;
  constructor(message: string, checkpoint: MissionCheckpoint) {
    super(message);
    this.name = "MissionBudgetError";
    this.checkpoint = checkpoint;
  }
}

/** True when the error is a clean budget stop rather than a failed run. */
export function isMissionBudgetError(err: unknown): err is MissionBudgetError {
  return err instanceof MissionBudgetError;
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
    hashText(`${m.role}\u0000${m.content}\u0000${JSON.stringify(m.tool_calls ?? null)}\u0000${m.tool_name ?? ""}`),
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
 * The model's context window for this run, or `undefined` when the config does
 * not declare one.
 *
 * The selector uses it to cap its own selection. A config that omits the
 * per-model window map (a minimal test config, or a caller that only needs the
 * selector) must not make the loop throw, so the lookup is guarded: without a
 * window the selector falls back to its configured cap.
 */
function selectorWindowTokens(cfg: Config, model: string): number | undefined {
  if (!cfg.compression?.contextWindow || typeof cfg.compression.contextWindow !== "object") return undefined;
  return getContextWindow(cfg, model);
}

/** Best-effort target path for an edit tool call (never the full arguments). */
function editTargetPath(args: Record<string, unknown>): string | undefined {
  for (const key of ["path", "file", "filePath", "target", "old_path", "from"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function toolMetaOf(callId: string, ok: boolean, args: Record<string, unknown>): ToolMeta {
  const path = editTargetPath(args);
  return { callId, ok, args, ...(path ? { path } : {}) };
}

/** Attribute a workspace edit to the model that produced it. No-op when the
 *  operator disabled edit auditing through `coding.logEdits`. */
function auditEdit(name: string, args: Record<string, unknown>, model: string, ok: boolean, step: number, enabled: boolean, taskId?: string): void {
  if (!enabled || !isEditTool(name)) return;
  recordEditModel({ taskId, step, model, tool: name, path: editTargetPath(args), ok });
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
  // Every guarded-MCP result is target-originated untrusted data: REA tool text
  // (REA_INTO_LOAM §8) and Cua Driver GUI text/screenshots (CUA_INTO_LOAM §6.2 —
  // UI labels are a prompt-injection surface).
  if (name.startsWith("mcp__rea__") || name.startsWith("mcp__cua-driver__")) return markUntrusted(content, name.startsWith("mcp__rea__") ? "rea" : "cua-driver");
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
  // A session's file-touch reader marks are worthless once it is gone; forget
  // them on every exit path so finished sessions are never notified.
  const sessionId = opts.sessionId ?? opts.taskId ?? `session-${process.pid}-${Date.now()}`;
  try {
    return await runAgentInner(opts, sessionId);
  } finally {
    forgetFileTouchSession(sessionId);
  }
}

async function runAgentInner(opts: RunOptions, sessionId: string): Promise<RunResult> {
  if (!opts.suppressFinal) opts = { ...opts, tools: taskScopedTools(opts.tools, opts.prompt, opts.history) };
  // Neo N10: resolve the composer's selectors once, before anything is built.
  // An unrecognized value degrades to the pre-N10 behaviour (auto / unset).
  const outputType: OutputType = isOutputType(opts.outputType) ? opts.outputType : "auto";
  const effortLevel = normalizeEffort(opts.effort ?? "");
  if (effortLevel) opts = { ...opts, maxSteps: opts.maxSteps ?? effortStepBudget(effortLevel) };
  // An output type pins the run to its pipeline: only the tools that can produce
  // that deliverable stay in the registry, so a Slides run cannot drift into a
  // file-writing detour. `auto` keeps the whole run scope untouched.
  if (outputType !== "auto") {
    const wanted = outputTypeTools(outputType, opts.tools.names());
    if (wanted.length > 0) opts = { ...opts, tools: opts.tools.forAllowlist(wanted) };
  }
  const acceptanceGuard = new AcceptanceGuard(undefined, opts.suppressFinal ? undefined : opts.prompt);
  const independentRequest = independentRequirements(opts.prompt, opts.history);
  const independentGuard = new IndependentAcceptanceGuard(independentRequest);
  const baseSystem =
    opts.systemOverride ??
    buildSystemPrompt(
      opts.cfg,
      loadProjectSkills(opts.cfg.workspace).skills,
      opts.tools.names(),
      opts.memories ?? [],
      undefined,
      opts.sandboxMode,
      undefined,
      opts.prompt,
    );
  const system =
    opts.systemSuffix && opts.systemSuffix.trim().length > 0
      ? `${baseSystem}\n\n${opts.systemSuffix.trim()}`
      : baseSystem;
  // Neo N10: the output type is a binding constraint, so it is appended after
  // every other suffix (including an agent's own instructions) rather than
  // before them. `auto` adds nothing, which keeps pre-N10 prompts byte-identical.
  const outputInstruction = outputTypeSuffix(outputType);
  const routingSystem = outputInstruction ? `${system}\n\n${outputInstruction}` : system;
  let messages: ChatMessage[] = [{ role: "system", content: routingSystem }];

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
  // How this run actually ended, so SessionEnd can report a truthful reason
  // instead of a blanket "failed".
  let endedReason: "completed" | "cancelled" | "failed" = "failed";
  const usage: Usage = { promptTokens: 0, completionTokens: 0, durationMs: 0 };
  // Prompt-cache (KV) accounting: classify a miss whenever a meaningful part of
  // the previously reusable prefix was not read back.
  const cacheMonitor = new KvCacheMonitor();
  const trace: ToolTraceItem[] = [];
  // Neo N10: the last tool this run asked for, so the next model call can take
  // the per-tool routing entry when one is configured. Cleared each step.
  let lastToolCallName: string | null = null;
  // Neo N10 multi-model A/B: the sibling arms of this run. Created once, right
  // after the run's root node exists, so the canvas shows the same prompt fanned
  // out to several models before any of them answers.
  const siblingArms = opts.abModels ?? [];
  // Each arm answers the same prompt under its own model in parallel with the
  // main run, and every one is awaited before this run returns so the canvas
  // never shows an arm that is still pending.
  const armPromises: Promise<void>[] = [];
  let verificationAttempts = 0;
  let emptyAnswerRecoveries = 0;
  const stallGuard = createStallGuard();
  // Neo N10 A/B: one sibling node per model, hanging off the parent node (the
  // run's root unless the caller named another). Recording must never break the
  // task, so a graph failure is logged and the run continues without arms; an arm
  // that fails to answer fails only its own node.
  if (siblingArms.length > 0 && !opts.suppressFinal) {
    try {
      const created = addRunSiblings(opts.taskId ?? "", opts.abParentNodeId ?? siblingParentFor(opts), siblingArms);
      for (const arm of created) {
        const model = (arm.data as { model?: string } | undefined)?.model ?? "";
        // An arm with no model label cannot be dispatched; leave it `init` rather
        // than silently sending it to the config default model.
        if (!model) continue;
        opts.emit({ type: "assistant_message", text: `A/B arm started on ${model}.` });
        armPromises.push(runAbArm(opts, routingSystem, arm, model));
      }
    } catch (err) {
      log.warn(`A/B siblings not recorded: ${String(err)}`);
    }
  }
  const restored = opts.resumeWorker;
  if (restored) {
    if (!opts.suppressFinal || restored.prompt !== opts.prompt) throw new Error("Worker checkpoint does not match this execution");
    messages.splice(0, messages.length, ...structuredClone(restored.messages));
    trace.push(...structuredClone(restored.trace));
    for (const item of restored.trace) opts.onToolEvidence?.(item);
    Object.assign(usage, restored.usage);
    usedModel = restored.model;
  }
  const mission = opts.mission === true;
  const maxSteps = opts.maxSteps !== undefined && opts.maxSteps > 0 ? opts.maxSteps : opts.cfg.agent.maxSteps;
  // Neo N6: a mission is unbounded, so it only stops when the model answers or
  // the budget does. `Number.MAX_SAFE_INTEGER` keeps the existing loop shape
  // (a `for` over a finite ceiling) while removing the 40-step cap.
  const stepCeiling = mission ? Number.MAX_SAFE_INTEGER : maxSteps;
  // Wall-clock accounting for a mission: the elapsed time of every step is
  // charged to the budget, so a mission that idles on slow tools still ends.
  // A resumed mission's checkpoint budget already carries the elapsed time, so
  // each step here is charged only for the milliseconds it took; the clock
  // never restarts.
  /** Persist a mission checkpoint. Never throws: persistence must not fail a run. */
  const saveCheckpoint = (lastStep: number, inFlight = false): void => {
    if (!mission || !opts.saveMissionCheckpoint) return;
    try {
      opts.saveMissionCheckpoint({
        version: 1,
        taskId: opts.taskId ?? "",
        prompt: opts.prompt,
        lastStep,
        budget: { ...(opts.budget ?? { steps: 0, promptTokens: 0, completionTokens: 0, wallClockMs: 0, costUsd: 0 }) },
        checkpointedAt: new Date().toISOString(),
        ...(inFlight ? { inFlight: true } : {}),
      });
    } catch (err) {
      log.warn(`mission checkpoint not persisted: ${String(err)}`);
    }
  };
  // The tool names this run may use. Tools that fan out to child agents read
  // it from the tool context so a child never exceeds the parent's reach.
  const runAllowedTools = opts.tools.names();
  // Coding turns route through the strongest coder in the configured chain.
  const routeCoding = opts.cfg.coding?.enabled !== false && isCodingTurn(opts.prompt, opts.history);
  // Edit attribution is on by default and can be disabled per config.
  const auditEdits = opts.cfg.coding?.logEdits !== false;
  // Harness reminders (stale todo list, external file change, plan mode, memory
  // update) are injected as hidden user-role blocks. They are never emitted as
  // events, so the UI cannot render them.
  const reminders = opts.reminderChannel ?? new ReminderChannel(opts.reminders);
  // Per-session read tracking: file_read fills it, edit/write tools consult it
  // so the model cannot blind-edit content it never saw or clobber a file that
  // changed since it was read. A fresh instance per run matches Claude Code.
  const readState = new ReadState();
  // Cross-session file-touch tracking (jcode J8): one registry per workspace
  // root, shared by every live session against that repository. Reads and
  // writes are published to it, and at each turn this session's queued notices
  // are drained into the reminder channel as hidden system-reminder blocks.
  const touch = opts.cfg.workspace ? fileTouchRegistry(opts.cfg.workspace) : undefined;
  readState.hooks = touch
    ? {
        read: (abs, content) => touch.noteRead(sessionId, abs, content),
        write: (abs, content) => touch.noteWrite(sessionId, abs, content),
        remove: (abs) => touch.noteDelete(sessionId, abs),
      }
    : undefined;
  // O5 durable event log: when the caller supplies a session, every tool call is
  // bracketed by a `started` and a terminal event so a crash mid-call is visible.
  const logSession = opts.eventLogSession;
  let index = 0;
  // O6: the session whose inbound queue this run drains at step boundaries.
  const inputSessionId = opts.inputSessionId ?? opts.taskId;
  /**
   * Admit any message the user sent while this run was busy. Best-effort: a
   * failure to reach the queue must never fail the run.
   */
  const admitPendingInputs = (): void => {
    if (!inputSessionId || !opts.onAdmitPending) return;
    try {
      if (!hasPending(inputSessionId)) return;
      opts.onAdmitPending(inputSessionId);
    } catch (error) {
      opts.emit({ type: "error", message: `failed to admit a queued message: ${error instanceof Error ? error.message : String(error)}` });
    }
  };
  // The model's live task list, mirrored here so a compaction can re-attach it
  // as a hidden reminder after the conversation is folded away.
  let currentTodos: TodoItem[] = [];
  const workspace = opts.cfg.workspace;
  // Neo N5: the per-step context selector. It accumulates one artefact per tool
  // result and re-shapes the transcript once a step exceeds its activation
  // threshold, so a long run keeps a bounded context without waiting for the
  // compressor. A caller may inject its own instance to share one store.
  const selector = opts.contextSelector ?? new ContextSelector({ config: opts.cfg.contextSelector });
  // Maps each tool message to its artefact id, so the selector can tell which
  // transcript entries it may fold away. Object identity survives a re-shape,
  // because the selector carries the surviving messages over unchanged.
  const toolMessageIds = new Map<ChatMessage, string>();
  // Verbatim pruning (compression.prune): per tool message call id / outcome /
  // args, plus the run's store holding the bodies of removed results.
  const toolMessageMeta = new Map<ChatMessage, ToolMeta>();
  const prunedStore = new PrunedStore();

  try {
    // SessionStart and UserPromptSubmit fire once per run, before any model call.
    // A block prevents the run from starting; additionalContext is injected as a
    // tagged user message (never rendered by the UI as user input). They run here
    // so a hook that stops the run still produces a SessionEnd notification.
    if (!opts.suppressFinal) {
      const session = await openSession({ workspace, prompt: opts.prompt, signal: opts.signal, taskId: opts.taskId, enabled: true, wikiCfg: opts.cfg });
      if (session.injected) messages.push({ role: "user", content: session.injected });
    }

  for (step = (restored?.steps ?? (mission && opts.resumeMission ? resumeStep(opts.resumeMission) - 1 : 0)) + 1; step <= stepCeiling; step++) {
    // Neo N6: a mission checkpoints BEFORE its step runs, marking the step as
    // in flight, so a server killed mid-step resumes from a known boundary.
    if (mission && step > 1) saveCheckpoint(step - 1, true);
    // Stop immediately when the user pressed the cancel button (checked between every step).
    throwIfCancelled(opts.signal, opts.taskId);
    // D19 compute budget: consult BEFORE the step runs so the first crossing
    // of the ceiling stops the run instead of burning one more step.
    const budgetDecision = opts.budget ? checkBudget(opts.budget) : { action: "allow" as const };
    if (budgetDecision.action === "stop") {
      // Neo N6: a mission's budget stop is a clean end (the checkpoint is the
      // resume point), but an ordinary run has no checkpoint to resume from, so
      // its stop stays the plain failure it always was.
      if (mission) {
        const summary = budgetStoppedCheckpoint({ taskId: opts.taskId, prompt: opts.prompt, lastStep: step - 1, budget: opts.budget ?? createUnlimitedBudget() });
        opts.emit({ type: "budget_exhausted", taskId: opts.taskId ?? "", reason: budgetDecision.reason, checkpoint: summary });
        throw new MissionBudgetError(`${budgetDecision.reason}. Raise the session budget to continue.`, summary);
      }
      const msg = `${budgetDecision.reason}. Raise the session budget to continue.`;
      opts.emit({ type: "error", message: msg });
      throw new Error(msg);
    }
    if (opts.budget) consumeSteps(opts.budget, 1);
    // O6: a step boundary is the safe place to pick up messages that arrived
    // while the previous step (or the whole run) was busy.
    admitPendingInputs();
    opts.emit({ type: "step", index: step });
    opts.onProgress?.({ steps: step, model: usedModel, usage: { ...usage } });

    // Plan mode is a read-only work phase; announce it once when it is active.
    // A file another session in this workspace wrote since we last read it is
    // stale context: surface it now, before the model acts on the old content.
    if (touch) for (const notice of touch.drainNotices(sessionId)) reminders.fileTouched(notice);
    if (opts.taskId) reminders.setPlanMode(getTaskPhase(opts.taskId) === "plan");
    for (const message of reminders.drainMessages(step)) messages.push(message);

    // Neo N11: an edit the user made on the canvas while the run was busy (or
    // before it resumed) is a fact about the run the model has not seen. The
    // directives are pulled once per step: the batch becomes one hidden reminder
    // so the very next model call sees it, and each edit also enters the N5
    // artefact store, so a later step can re-attach it on relevance instead of
    // the correction having to stay pinned in the prompt for the whole run.
    if (opts.taskId) {
      const edits = takeCanvasDirectives(opts.taskId);
      if (edits.length > 0) {
        const message = canvasEditsMessage(edits);
        if (message) messages.push(message);
        for (const directive of edits) {
          selector.captureExternal(CANVAS_EDIT_ARTEFACT_KIND, directiveTitle(directive), directiveBody(directive), {
            path: directive.nodeId,
          });
        }
        opts.emit({ type: "canvas_edit", step, count: edits.length, nodeIds: edits.map((directive) => directive.nodeId) });
      }
    }

    let providerCompaction = false;
    if (opts.cfg.compression.enabled) {
      const compressed = await compressContext(opts.cfg, opts.ollama, messages, opts.emit, opts.signal, {
        readState, todos: currentTodos, model: usedModel, goal: opts.prompt, toolMeta: toolMessageMeta, prunedStore,
      });
      if (compressed.compressed) {
        messages = compressed.messages;
        for (const message of [...toolMessageMeta.keys()]) {
          if (!messages.includes(message)) toolMessageMeta.delete(message);
        }
        providerCompaction = true;
        usage.promptTokens += compressed.usage.promptTokens;
        usage.completionTokens += compressed.usage.completionTokens;
        usage.durationMs += compressed.usage.durationMs;
      }
      // Re-attach recent file reads and the live task list as hidden reminders.
      for (const reminder of compressed.reminders) messages.push(reminder);
    }

    // Neo N5: the per-step selector runs before the model is called. From the
    // activation step onwards it selects the artefacts this step needs and folds
    // the rest into elision markers, so the prompt stays bounded for the whole
    // run instead of growing until the compressor fires. A selector failure is
    // invisible: the run keeps the raw transcript.
    if (selector.enabled && step > selector.activationStep) {
      const selected = await selector.apply(messages, {
        task: opts.prompt,
        todos: currentTodos,
        step,
        toolMessageIds,
        // The selector's selection is capped by the model's real window, so a
        // long run cannot re-attach more than the model can hold. Only the
        // selector's own active path needs this; a disabled selector (or a run
        // that never reaches its activation step) must not touch the config.
        windowTokens: selectorWindowTokens(opts.cfg, usedModel),
      });
      if (selected.applied) {
        messages = selected.messages;
        // Re-index the surviving tool messages; dropped ones lose their entry.
        for (const [message, id] of [...toolMessageIds]) {
          if (!messages.includes(message)) toolMessageIds.delete(message);
        }
        opts.emit({ type: "context_selected", step, tokens: selected.tokens, artefacts: selected.artefactCount, reason: selected.reason });
      }
    }

    const requestTools = opts.tools.toOllama();
    // Neo N10: the tool about to be called can narrow the model for this
    // request only. `null` means "not yet known", so the run's own plan applies.
    const routingTool: string | null = lastToolCallName;
    const route: RequestRoute = {
      ...providerRouteFor(usedModel, opts.provider),
      ...(opts.account ? { account: opts.account } : {}),
      ...(opts.cacheTtlSecs !== undefined ? { cacheTtlSecs: opts.cacheTtlSecs } : {}),
      ...(opts.cacheTtlIsEstimate !== undefined ? { ttlIsEstimate: opts.cacheTtlIsEstimate } : {}),
    };
    cacheMonitor.beginRequest(route, requestSignature(routingSystem, requestTools, messages));

    const chatRequest = {
      model: opts.cfg.model,
      messages,
      tools: requestTools,
      temperature: opts.cfg.agent.temperature,
      // An explicit per-run model (the quick-edit route) wins over the config
      // default; the router still replaces it with the strongest coder on a
      // coding turn.
      ...(opts.model && opts.model.trim() ? { model: opts.model.trim() } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    };
    // Neo N10: one dispatch point. A mapped route (per-tool, then effort) takes
    // precedence; otherwise the existing coding-turn routing applies, and a run
    // with no map at all keeps the plain fallback chain it had before N10.
    const stepStartedAt = mission ? Date.now() : 0;
    const result: ChatResult = routeCoding
      ? await chatWithCodingRouter({
          cfg: opts.cfg,
          chat: chatRequest,
          fallback: opts.ollama,
          env: opts.env,
          store: opts.cooldownStore,
          createClient: opts.createProviderClient,
          onRoute: opts.onCodingRoute,
        })
      : await chatWithRouting({
          cfg: opts.cfg,
          ollama: opts.ollama,
          messages,
          tools: requestTools,
          temperature: opts.cfg.agent.temperature,
          timeoutMs: opts.cfg.agent.requestTimeoutMs,
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(opts.model && opts.model.trim() ? { model: opts.model.trim() } : {}),
          ...(outputType !== "auto" ? { outputType } : {}),
          ...(effortLevel ? { effort: effortLevel } : {}),
          ...(routingTool ? { tool: routingTool } : {}),
          env: opts.env,
          store: opts.cooldownStore,
          createClient: opts.createProviderClient,
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
    // D19 compute budget: model tokens are real work, so they count against the
    // session ceiling too (addUsage already tallied the same numbers above).
    if (opts.budget) consumeTokens(opts.budget, result.usage.promptTokens, result.usage.completionTokens);
    // Neo N6: a mission charges wall-clock and estimated cost too, so the budget
    // is the real ceiling and not just a step counter.
    if (opts.budget && mission) {
      consumeWallClock(opts.budget, Date.now() - stepStartedAt);
      consumeCost(opts.budget, estimateCostUsd(usedModel, result.usage.promptTokens, result.usage.completionTokens));
    }
    if (opts.budget && checkBudget(opts.budget).action === "warn") {
      opts.emit({ type: "error", message: "Compute budget is close to its ceiling; consider raising it." });
    }
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
        // Stop: a hook may force the agent to continue for another step.
        const stop = await runLifecycleHooks("Stop", "", { stopReason: "completed" }, workspace);
        if (stop.blocked) {
          messages.push({ role: "assistant", content: finalText });
          messages.push({
            role: "user",
            content: `Stop hook blocked completion${stop.message ? `: ${stop.message}` : ""}. Continue working toward the original request; do not claim completion yet.`,
          });
          continue;
        }
        if (stop.additionalContext) {
          messages.push({ role: "user", content: wrapHookContext(stop.additionalContext) });
        }
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
        endedReason = "completed";
      }
      // Every A/B arm finishes before the run reports completion, so the canvas
      // never leaves a sibling node in `running` once the run is done.
      await Promise.all(armPromises);
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
      "kb_search",
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
        return { name, args, t0: Date.now(), callId: toolCallIdOf(call, step, index++) };
      });
      if (logSession) {
        for (const item of prepared) recordToolCall(logSession, item.callId, item.name, opts.taskId);
      }
      // Neo N10: remember the batch's tool so the next request can honour a
      // per-tool routing entry. Parallel reads share one tool, so this is exact.
      lastToolCallName = prepared.length === 1 ? prepared[0]!.name : null;
      const batchResults = await mapWithConcurrency(prepared, PARALLEL_READ_LIMIT, (item) =>
        opts.tools.exec(item.name, item.args, {
          cfg: opts.cfg,
          workspace: opts.cfg.workspace,
          emit: opts.emit,
          ollama: opts.ollama,
          signal: opts.signal,
          allowedTools: runAllowedTools,
          readState,
          prunedStore,
          ...(opts.depth !== undefined ? { depth: opts.depth } : {}),
          ...(opts.taskId ? { taskId: opts.taskId } : {}),
        }),
      );
      for (let i = 0; i < prepared.length; i++) {
        const item = prepared[i]!;
        const toolResult = batchResults[i]!;
        if (logSession) {
          recordToolResult(logSession, item.callId, item.name, toolResult.ok ? "succeeded" : "failed", toolResult.content, opts.taskId, opts.cfg.workspace);
        }
        const evidence = { name: item.name, args: item.args, ok: toolResult.ok, summary: toolResult.content };
        trace.push(evidence);
        opts.onToolEvidence?.(evidence);
        auditEdit(item.name, item.args, usedModel, toolResult.ok, step, auditEdits, opts.taskId);
        const notice = stallGuard(item.name, item.args, toolResult.ok);
        if (notice) stallNotices.push(notice);
        const ciNotice = ciWatchEscalationNotice(toolResult.content);
        if (ciNotice) stallNotices.push(ciNotice);
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
          // N13: keep the raw output so the run graph can version it. Capped
          // (40k chars) so a large fetch cannot bloat the event payload.
          ...(toolResult.content ? { content: toolResult.content.slice(0, 40_000) } : {}),
          ...(toolResult.kbSeedIds && toolResult.kbSeedIds.length > 0 ? { kbSeedIds: toolResult.kbSeedIds } : {}),
          ...(toolResult.kbSeeds && toolResult.kbSeeds.length > 0 ? { kbSeeds: toolResult.kbSeeds } : {}),
        });
        const toolMessage = { role: "tool", tool_name: item.name, content: toolMessageContent(item.name, toolResult.content) } as ChatMessage;
        // Neo N5: capture the result as a selectable artefact and remember which
        // transcript message it belongs to, so the selector can fold it away
        // later without losing the pairing.
        toolMessageIds.set(toolMessage, selector.capture(item.name, toolResult.content, { path: editTargetPath(item.args) }).id);
        toolMessageMeta.set(toolMessage, toolMetaOf(item.callId, toolResult.ok, item.args));
        messages.push(toolMessage);
        // Stop right after the first tool when cancelled — don't even queue the rest of the batch.
        throwIfCancelled(opts.signal, opts.taskId);
      }
    } else {
      for (const call of result.toolCalls) {
        const name = call.function?.name ?? "";
        const args = normalizeArgs(call.function?.arguments);
        opts.emit({ type: "tool_call", name, args });
        lastToolCallName = name;

        const callId = toolCallIdOf(call, step, index++);
        if (logSession) recordToolCall(logSession, callId, name, opts.taskId);
        const t0 = Date.now();
        const toolResult = await opts.tools.exec(name, args, {
          cfg: opts.cfg,
          workspace: opts.cfg.workspace,
          emit: opts.emit,
          ollama: opts.ollama,
          signal: opts.signal,
          allowedTools: runAllowedTools,
          readState,
          prunedStore,
          ...(opts.depth !== undefined ? { depth: opts.depth } : {}),
          ...(opts.taskId ? { taskId: opts.taskId } : {}),
        });

        if (logSession) {
          recordToolResult(logSession, callId, name, toolResult.ok ? "succeeded" : "failed", toolResult.content, opts.taskId, opts.cfg.workspace);
        }
        opts.emit({
          type: "tool_result",
          name,
          ok: toolResult.ok,
          summary: summarize(toolResult.content),
          ms: Date.now() - t0,
          ...(toolResult.content ? { content: toolResult.content.slice(0, 40_000) } : {}),
          ...(toolResult.kbSeedIds && toolResult.kbSeedIds.length > 0 ? { kbSeedIds: toolResult.kbSeedIds } : {}),
          ...(toolResult.kbSeeds && toolResult.kbSeeds.length > 0 ? { kbSeeds: toolResult.kbSeeds } : {}),
        });
        const evidence = { name, args, ok: toolResult.ok, summary: toolResult.content };
        trace.push(evidence);
        opts.onToolEvidence?.(evidence);
        auditEdit(name, args, usedModel, toolResult.ok, step, auditEdits, opts.taskId);
        const notice = stallGuard(name, args, toolResult.ok);
        if (notice) stallNotices.push(notice);
        const ciNotice = ciWatchEscalationNotice(toolResult.content);
        if (ciNotice) stallNotices.push(ciNotice);
        if (TODO_UPDATE_TOOLS.has(name) && toolResult.ok) {
          reminders.noteTodoUpdate(step);
          currentTodos = parseTaskList(name, args);
        }
        if (MEMORY_UPDATE_TOOLS.has(name) && toolResult.ok) reminders.memoryUpdated();
        const toolMessage = { role: "tool", tool_name: name, content: toolMessageContent(name, toolResult.content) } as ChatMessage;
        toolMessageIds.set(toolMessage, selector.capture(name, toolResult.content, { path: editTargetPath(args) }).id);
        toolMessageMeta.set(toolMessage, toolMetaOf(callId, toolResult.ok, args));
        messages.push(toolMessage);
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
    // Neo N6: the step completed, so the checkpoint is a safe boundary again
    // (nothing in flight). This is the resume point a server restart uses.
    if (mission) saveCheckpoint(step);
    // Neo N6: check the budget again now that the step is fully accounted for.
    // A mission's clock is charged per step, so this is where a step that
    // crossed the wall-clock ceiling ends the mission; the next iteration's
    // pre-step check would otherwise be the only other place it can stop.
    if (opts.budget && mission) {
      const after = checkBudget(opts.budget);
      if (after.action === "stop") {
        const stopped = budgetStoppedCheckpoint({ taskId: opts.taskId, prompt: opts.prompt, lastStep: step, budget: opts.budget });
        opts.emit({ type: "budget_exhausted", taskId: opts.taskId ?? "", reason: after.reason, checkpoint: stopped });
        throw new MissionBudgetError(`${after.reason}. Raise the session budget to continue.`, stopped);
      }
    }
  }

  // Both sides converge on settling every arm here: an N10 A/B sibling must not
  // stay `running` once the run ends, and a mission is unreachable here anyway
  // (its ceiling is the budget, checked per step), so an ordinary run reports the
  // step cap it actually hit. Awaiting the arms never fails the run: each arm
  // records its own failure on its own node.
  // The step budget ran out: stop recording arms as pending so a later replay
  // cannot resurrect a node the run abandoned.
  await Promise.all(armPromises);
  const msg = `stopped after ${maxSteps} steps without finishing`;
  opts.emit({ type: "error", message: msg });
  throw new Error(msg);
  } finally {
    // A run that throws (model failure, cancellation, step budget) must still let
    // every arm settle, so no sibling node is left in `running` or `init`.
    await Promise.all(armPromises);
    // SessionEnd fires once the run reaches any terminal state (completed,
    // cancelled or failed) for a top-level run. The reason is the real
    // outcome, so a hook can tell a cancelled or failed session apart from a
    // completed one instead of always seeing "completed".
    if (!opts.suppressFinal) {
      // Cancellation is detected here: a run may be aborted before the loop ever
      // assigns a reason, in which case the real outcome is "cancelled".
      if (opts.signal?.aborted || isCancelled(opts.taskId)) endedReason = "cancelled";
      await closeSession(workspace, endedReason);
    }
  }
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
