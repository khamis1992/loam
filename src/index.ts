import fs from "node:fs";
import { ensureTaskWorkspace } from "./server/taskWorkspace.js";
import path from "node:path";
import { loadConfig, ROOT } from "./config.js";
import { buildRuntime } from "./setup/runtime.js";
import { type ToolTraceItem } from "./agent/reflect.js";
import { loadPending } from "./server/pending.js";
import { getSettings, loadSettings } from "./server/settings.js";
import { createRunSignal, clearRunSignal, isCancelledError, cancelRunSignal, listRunningSignals, activateRunSignal } from "./server/runControl.js";
import { agentSystemSuffix, getAgent, loadAgents } from "./server/agents.js";
import { publishTaskEvent } from "./server/streams.js";
import { formatIssues, scanEncoding } from "./scripts/check-encoding.js";
import { runAgent } from "./agent/loop.js";
import { runOrchestratedAgent, type VerdictRecord } from "./agent/orchestrator.js";
import type { Emit } from "./agent/events.js";
import { startServer, type RunTaskOptions } from "./server/http.js";
import { appendMessage, appendStep, createTask, getProject, getTask, loadDb, setTaskStatus } from "./server/db.js";
import { conversationHistory } from "./agent/history.js";
import { startScheduler } from "./server/scheduler.js";
import { appendLearning } from "./server/learning.js";
import { appendTelemetry, hashPrompt } from "./telemetry/store.js";
import { loadSuite } from "./eval/suites.js";
import { evalBusy, runSuiteLocked } from "./eval/service.js";
import { lastRunForSuite } from "./eval/store.js";
import { getLoamMode } from "./modes/catalog.js";
import { closeBrowser } from "./tools/browser.js";
import { setTaskMode } from "./server/db.js";
import { log } from "./log.js";
import { recoverInterruptedTasks, getSavedRun, saveRun, queueTaskRun, completeTaskRun, closeDb } from "./server/db.js";
import { executionQueue } from "./server/executionQueue.js";
import { requiresReplayConfirmation, type SavedRun } from "./server/recovery.js";
import { acquireRuntimeLease, releaseRuntimeLease, backupDatabase } from "./server/sqliteStore.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  loadDb();
  acquireRuntimeLease();
  backupDatabase();
  const recovered = recoverInterruptedTasks();
  if (recovered) log.info(`recovery: ${recovered} interrupted task(s) awaiting resume`);
  const bootSettings = loadSettings();
  if (bootSettings.workspace && fs.existsSync(bootSettings.workspace) && fs.statSync(bootSettings.workspace).isDirectory()) {
    cfg.workspace = path.resolve(bootSettings.workspace);
  } else {
    cfg.workspace = path.resolve(cfg.workspace);
  }
  fs.mkdirSync(cfg.workspace, { recursive: true });
  loadPending();
  loadAgents();

  const encodingIssues = scanEncoding(ROOT);
  if (encodingIssues.length > 0) {
    log.warn(`encoding check found ${encodingIssues.length} issue(s) — UI text may render incorrectly:`);
    log.warn(`\n${formatIssues(encodingIssues)}`);
  } else {
    log.info("encoding check: OK (no BOM, no mojibake, all JSON valid)");
  }

  const rt = await buildRuntime(cfg);
  const { ollama, registry, memory, mcp } = rt;

  const executeTask = async (opts: RunTaskOptions & { taskId: string; savedRun: SavedRun; signal: AbortSignal }): Promise<{ taskId: string; text: string }> => {
    const { prompt, emit } = opts;
    const settings = getSettings();
    const previous = opts.taskId ? getTask(opts.taskId) : undefined;
    if (opts.taskId && !previous) throw new Error("task not found");
    if (previous?.status === "running") throw new Error("task already running");
    const history = opts.savedRun.history;
    const projectId = opts.projectId === undefined ? previous?.projectId : opts.projectId;
    const project = projectId ? getProject(projectId) : undefined;
    const task =
      opts.taskId && opts.taskId.length > 0
        ? opts.taskId
        : createTask(prompt, opts.title, opts.projectId ?? null, opts.agentId ?? null).id;

    const effectivePrompt = opts.savedRun.effectivePrompt;

    setTaskStatus(task, "running");
    activateRunSignal(task);
    opts.savedRun.started = true;
    saveRun(task, opts.savedRun);
    publishTaskEvent(task, { type: "task-status", status: "running" });
    // Announce the id immediately so the UI can cancel while the run is alive.
    emit({ type: "task", taskId: task });

    const startedAt = Date.now();
    const promptHash = hashPrompt(effectivePrompt);

    const trace: ToolTraceItem[] = [];
    const lastArgs = new Map<string, unknown>();
    let doneEvent: Parameters<Emit>[0] | undefined;
    const wrappedEmit: Emit = (event) => {
      if (event.type === "done") { doneEvent = event; return; }
      emit(event);
      publishTaskEvent(task, event);
      if (event.type === "tool_call") {
        lastArgs.set(event.name, event.args);
      }
      if (event.type === "tool_result") {
        const args = lastArgs.get(event.name);
        trace.push({ name: event.name, ok: event.ok, summary: event.summary, ms: event.ms, ...(args !== undefined ? { args } : {}) });
        lastArgs.delete(event.name);
      }
      if (event.type !== "assistant_token") {
        appendStep(task, { at: new Date().toISOString(), type: event.type, data: event });
      }
    };

    // Agent (multi-agent) resolution: agent model overrides the default; instructions inject into the system prompt.
    const agentId = opts.agentId ?? previous?.agentId;
    const agent = agentId ? getAgent(agentId) : undefined;
    const chosenModel = opts.model && opts.model.trim().length > 0 ? opts.model : agent?.model ?? settings.model;
    const effectiveCfg = { ...cfg, policy: { ...cfg.policy, allowOutsideWorkspaceRead: false }, workspace: opts.savedRun.workspace, model: chosenModel || cfg.model };

    // Loam task controls: explicit mode and execution effort.
    const effortBudgets: Record<string, number> = { max: 80, high: 64, medium: 40, low: 16 };
    const modeDefinition = getLoamMode(opts.savedRun.mode);
    const effectiveMode = modeDefinition.id;
    const askMode = effectiveMode === "ask";
    const effectiveEffort = String(opts.effort ?? agent?.effort ?? "").toLowerCase();
    const effortMaxSteps = effortBudgets[effectiveEffort];
    const runSignal = opts.signal;
    const askModeSuffix =
      effectiveMode === "ask"
        ? "وضع السؤال (Ask): أجب بالقراءة والتحليل فقط — لا تعدّل الملفات، لا تنفّذ أوامر نظام، ولا تبدأ مهام تنفيذية؛ إن أحبّت اقترح الخطوات دون تنفيذها."
        : undefined;

    const recordTelemetry = (status: "done" | "error", extra: { model: string; steps: number; usage: { promptTokens: number; completionTokens: number }; error?: string }): void => {
      appendTelemetry({
        at: new Date().toISOString(),
        kind: "task",
        taskId: task,
        model: extra.model,
        status,
        steps: extra.steps,
        durationMs: Date.now() - startedAt,
        usage: extra.usage,
        toolCalls: trace.map((t) => ({ name: t.name, ok: t.ok, ...(t.ms !== undefined ? { ms: t.ms } : {}) })),
        promptHash,
        promptChars: effectivePrompt.length,
        ...(extra.error ? { error: extra.error } : {}),
      });
    };

    // Task isolation: never silently inject memories or execute background tools from other tasks.
    const memories: Array<{ text: string; score: number }> = [];
    try {
      // The application has a serial queue; close the previous browser session before this task.
      await closeBrowser();
      rt.preview.stop();
      const verdicts: VerdictRecord[] = [];
      wrappedEmit({ type: "mode", mode: effectiveMode, label: modeDefinition.label, labelAr: modeDefinition.labelAr, reason: "selected task mode" });
      const agentSuffix = agent ? agentSystemSuffix(agent) : undefined;
      const suffix = [
        `You are Loam. Active mode: ${modeDefinition.labelAr}. ${modeDefinition.description} Only use the provided tool capabilities.`,
        agentSuffix, askModeSuffix,
      ].filter(Boolean).join("\n\n");
      const agentTools = registry.forMode(effectiveMode).cloneFiltered({ deny: agent?.disabledTools ?? [] });
      const agentOpts = {
        cfg: effectiveCfg,
        ollama,
        tools: agentTools,
        emit: wrappedEmit,
        prompt: effectivePrompt,
        history,
        memories,
        ...(suffix ? { systemSuffix: suffix } : {}),
        ...(effortMaxSteps ? { maxSteps: effortMaxSteps } : {}),
        signal: runSignal,
        taskId: task,
      };
      const result = opts.savedRun.orchestrated ? await runOrchestratedAgent({
        ...agentOpts, verdicts: verdicts as VerdictRecord[], resume: opts.savedRun.checkpoint,
        saveCheckpoint: (checkpoint) => { opts.savedRun.checkpoint = checkpoint; saveRun(task, opts.savedRun); },
      }) : await runAgent(agentOpts);
      // The orchestrator can swallow an abort (it reports a failed step instead),
      // so treat a cancelled run explicitly — never as success.
      if (runSignal.aborted) throw new Error("cancelled by user");
      completeTaskRun(task, result.text, result.model);
      if (doneEvent) {
        appendStep(task, { at: new Date().toISOString(), type: doneEvent.type, data: doneEvent });
        emit(doneEvent);
        publishTaskEvent(task, doneEvent);
      }
      recordTelemetry("done", { model: result.model, steps: result.steps, usage: { promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens } });
      // Actor-critic reflection memory: non-pass verdicts feed the learning review and the audit log.
      const notable = verdicts.filter((v) => v.verdict !== "pass");
      if (notable.length > 0) {
        for (const v of notable) {
          trace.push({
            name: `verifier(${v.scope})`,
            ok: false,
            summary: `${v.verdict}: ${v.reason}${v.fixes.length > 0 ? ` | fixes: ${v.fixes.join("; ")}` : ""}`,
          });
        }
        appendLearning({
          at: new Date().toISOString(),
          task: effectivePrompt.slice(0, 200),
          applied: notable.map((v) => `orchestrator/${v.scope}: ${v.verdict} — ${v.reason}`),
        });
      }
      return { taskId: task, text: result.text };
    } catch (err) {
      if (getTask(task)?.status === "done") {
        log.warn(`post-completion bookkeeping failed for ${task}: ${String(err)}`);
        return { taskId: task, text: getTask(task)?.messages.at(-1)?.content ?? "" };
      }
      const message = err instanceof Error ? err.message : String(err);
      const cancelled = runSignal.aborted || isCancelledError(err);
      setTaskStatus(task, cancelled ? "cancelled" : "error", { error: cancelled ? "cancelled by user" : message });
      publishTaskEvent(task, cancelled ? { type: "cancelled" } : { type: "error", message });
      wrappedEmit({ type: "error", message: cancelled ? "⏹ أُوقفت المهمة بناءً على طلبك" : message });
      recordTelemetry("error", { model: effectiveCfg.model, steps: 0, usage: { promptTokens: 0, completionTokens: 0 }, error: cancelled ? "cancelled by user" : message });
      if (!cancelled) throw err;
      return { taskId: task, text: "" };
    }
  };

  const runTask = async (opts: RunTaskOptions): Promise<{ taskId: string; text: string }> => {
    const previous = opts.taskId ? getTask(opts.taskId) : undefined;
    if (opts.taskId && !previous) throw new Error("task not found");
    if (opts.taskId && executionQueue.has(opts.taskId)) throw new Error("task already queued or running");
    let saved: SavedRun;
    if (opts.resume) {
      const pending = previous ? getSavedRun(previous.id) : undefined;
      if (!pending || previous?.status === "done") throw new Error("no saved execution to resume");
      if (requiresReplayConfirmation(pending) && !opts.retryInterruptedStep) {
        throw new Error("Interrupted step may already have performed actions; explicit retryInterruptedStep confirmation required");
      }
      if (!fs.existsSync(pending.workspace)) throw new Error("saved workspace is unavailable");
      if (path.resolve(pending.workspace).toLowerCase() !== path.resolve(ensureTaskWorkspace(previous!.id, cfg.workspace)).toLowerCase()) {
        throw new Error("Legacy shared-workspace execution cannot resume; start a new isolated run");
      }
      saved = pending;
    } else {
      const projectId = opts.projectId === undefined ? previous?.projectId : opts.projectId;
      const project = projectId ? getProject(projectId) : undefined;
      const agentId = opts.agentId ?? previous?.agentId ?? undefined;
      const agent = agentId ? getAgent(agentId) : undefined;
      saved = {
        prompt: opts.prompt, effectivePrompt: project?.instruction ? `[Project: ${project.name}]\n${project.instruction}\n\n${opts.prompt}` : opts.prompt,
        history: conversationHistory(previous?.messages ?? []), workspace: cfg.workspace,
        model: opts.model || agent?.model || getSettings().model || cfg.model,
        projectId, agentId, mode: getLoamMode(opts.mode ?? previous?.mode ?? agent?.mode).id, effort: opts.effort ?? agent?.effort ?? "",
        orchestrated: cfg.orchestrator.enabled, started: false,
      };
    }
    const task = previous ?? createTask(saved.prompt, opts.title, saved.projectId, saved.agentId);
    saved.mode = getLoamMode(saved.mode).id;
    setTaskMode(task.id, saved.mode);
    saved.workspace = ensureTaskWorkspace(task.id, cfg.workspace);
    queueTaskRun(task.id, saved, opts.resume === true, opts.scheduleId, opts.title);
    const signal = createRunSignal(task.id, false);
    opts.emit({ type: "task", taskId: task.id });
    opts.emit({ type: "task-status", status: "queued" });
    publishTaskEvent(task.id, { type: "task-status", status: "queued" });
    try {
      return await executionQueue.enqueue(task.id, () => executeTask({
        ...opts, ...saved, taskId: task.id, savedRun: saved, signal,
      }), signal);
    } catch (error) {
      if (getTask(task.id)?.status === "queued" || getTask(task.id)?.status === "running") {
        const message = error instanceof Error ? error.message : String(error);
        setTaskStatus(task.id, isCancelledError(error) ? "cancelled" : "error", { error: message });
        const event = { type: "error" as const, message };
        opts.emit(event); publishTaskEvent(task.id, event);
      }
      throw error;
    } finally { clearRunSignal(task.id); }
  };

  const server = await startServer({
    cfg,
    ollama,
    registry,
    runTask,
    memory: memory ?? undefined,
    screenLive: rt.screenLive,
    preview: rt.preview,
    mcp,
  });

  const stopScheduler = startScheduler({
    runScheduled: async (prompt: string, scheduleId: string) => {
      const res = await runTask({
        prompt,
        scheduleId,
        emit: () => {
          /* scheduled runs are persisted in db, no SSE consumer */
        },
      });
      log.info(`scheduled run finished: ${res.taskId}`);
      return res.taskId;
    },
  });

  let evalTimer: NodeJS.Timeout | null = null;
  if (cfg.evaluation.enabled) {
    const intervalMs = Math.max(5, cfg.evaluation.intervalMinutes) * 60_000;
    const previous = lastRunForSuite(cfg.evaluation.suite);
    const previousAt = previous ? Date.parse(previous.finishedAt) : Number.NaN;
    let lastEvalAt = Number.isFinite(previousAt) ? previousAt : Date.now();
    evalTimer = setInterval(() => {
      if (Date.now() - lastEvalAt < intervalMs) return;
      if (evalBusy()) return;
      lastEvalAt = Date.now();
      void (async (): Promise<void> => {
        try {
          const suite = loadSuite(cfg.evaluation.suite);
          const run = await runSuiteLocked(suite, { cfg, ollama, registry, critique: cfg.evaluation.critique });
          const attempted = run.summary.pass + run.summary.fail + run.summary.error;
          log.info(`eval (scheduled) ${run.suiteId}: passRate=${(run.summary.passRate * 100).toFixed(0)}% (${run.summary.pass}/${attempted})`);
        } catch (err) {
          log.warn(`eval (scheduled) skipped: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    }, 60_000);
    evalTimer.unref?.();
  }

  log.info(`Loam ready → http://${cfg.server.host}:${cfg.server.port}`);
  log.info(`model=${cfg.model} fallback=${cfg.fallbackModel} workspace=${cfg.workspace}`);
  log.info(`tools=${registry.names().length} mcpServers=[${rt.mcpServers.join(", ")}] eval=${cfg.evaluation.enabled ? `${cfg.evaluation.suite} كل ${cfg.evaluation.intervalMinutes}د` : "يدوي"}`);

  const shutdown = async (): Promise<void> => {
    log.info("shutting down...");
    stopScheduler();
    if (evalTimer) clearInterval(evalTimer);
    executionQueue.stop();
    for (const id of listRunningSignals()) cancelRunSignal(id);
    await rt.dispose();
    server.close();
    releaseRuntimeLease();
    closeDb();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  log.error(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
