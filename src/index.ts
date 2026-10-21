import fs from "node:fs";
import { ensureTaskWorkspace } from "./server/taskWorkspace.js";
import path from "node:path";
import { loadConfig, ROOT, DATA_DIR } from "./config.js";
import { setLocalAuthUserDataDir } from "./security/localAuth.js";
import { buildRuntime } from "./setup/runtime.js";
import { type ToolTraceItem } from "./agent/reflect.js";
import { loadPending } from "./server/pending.js";
import { getSettings, loadSettings } from "./server/settings.js";
import { createRunSignal, clearRunSignal, isCancelledError, cancelRunSignal, listRunningSignals, activateRunSignal } from "./server/runControl.js";
import { agentSystemSuffix, getAgent, loadAgents } from "./server/agents.js";
import { getWorkMode, normalizeWorkMode, resolveCompanionCapabilities, COMPANION_DYNAMIC_TOOL_NAMES } from "./server/companionGateway.js";
import { deviceManager, getDeviceByAgent, loadCompanionDevices, type CompanionDeviceRecord } from "./server/companionDevices.js";
import { createDeviceTools } from "./tools/deviceTools.js";
import { createCompanionMemoryTools } from "./tools/companionMemoryTools.js";
import { memoryContext, setMemoryEmbedder } from "./server/companionMemory.js";
import { createCompanionTeamTools } from "./tools/companionTeamTools.js";
import { setDelegationRunner } from "./server/companionTeam.js";
import { createApproval, waitForDecision } from "./server/approvals.js";
import type { Tool } from "./tools/registry.js";
import { createScratchpadTools } from "./tools/scratchpadTools.js";
import { createDeepResearchTools } from "./tools/deepResearch.js";
import { createInstructionHistoryTools } from "./tools/instructionTools.js";
import { createAgentSpawnTools } from "./tools/agentSpawnTools.js";
import { createBrowserOperatorTools } from "./tools/browserOperator.js";
import { createWideResearchTool } from "./tools/wideResearch.js";
import { mergeAlwaysOnTools } from "./server/runTools.js";
import { OllamaEmbedder } from "./memory/embeddings.js";
import { publishTaskEvent } from "./server/streams.js";
import { formatIssues, scanEncoding } from "./scripts/check-encoding.js";
import { runAgent } from "./agent/loop.js";
import { runOrchestratedAgent, type VerdictRecord } from "./agent/orchestrator.js";
import type { Emit } from "./agent/events.js";
import { startServer, type RunTaskOptions } from "./server/http.js";
import { appendMessage, appendStep, createTask, getProject, getTask, loadDb, setTaskStatus, listSchedules, setTaskDelegator } from "./server/db.js";
import { conversationHistory } from "./agent/history.js";
import { startScheduler } from "./server/scheduler.js";
import { appendLearning } from "./server/learning.js";
import { appendTelemetry, hashPrompt } from "./telemetry/store.js";
import { loadSuite } from "./eval/suites.js";
import { evalBusy, runSuiteLocked } from "./eval/service.js";
import { lastRunForSuite } from "./eval/store.js";
import { getLoamMode } from "./modes/catalog.js";
import { closeBrowser, closeBrowserSession, setBrowserSessionResolver } from "./tools/browser.js";
import { setTaskMode } from "./server/db.js";
import { log } from "./log.js";
import { recoverInterruptedTasks, getSavedRun, saveRun, queueTaskRun, completeTaskRun, closeDb } from "./server/db.js";
import { startProtocolAdapter } from "./protocol/adapter.js";
import { executionQueue } from "./server/executionQueue.js";
import { requiresReplayConfirmation, type SavedRun } from "./server/recovery.js";
import { acquireRuntimeLease, releaseRuntimeLease, backupDatabase } from "./server/sqliteStore.js";
import { claimRunLease, releaseRunLease, startLeaseHeartbeat, type LeaseHeartbeat, type RunLease } from "./server/runLease.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  setLocalAuthUserDataDir(process.env.LOAM_LOCAL_TOKEN_DIR || DATA_DIR);
  loadDb();
  acquireRuntimeLease();
  backupDatabase();
  const recovered = recoverInterruptedTasks();
  if (recovered) log.info(`recovery: ${recovered} interrupted task(s) awaiting resume`);
  const bootSettings = loadSettings();
  const envRoot = process.env.LOAM_ROOT || process.env.MANUS_LOCAL_ROOT;
  if (!envRoot && bootSettings.workspace && fs.existsSync(bootSettings.workspace) && fs.statSync(bootSettings.workspace).isDirectory()) {
    cfg.workspace = path.resolve(bootSettings.workspace);
  } else {
    cfg.workspace = path.resolve(cfg.workspace);
  }
  fs.mkdirSync(cfg.workspace, { recursive: true });
  loadPending();
  loadAgents();
  loadCompanionDevices();
  // Browser isolation (section 7): every companion browses in its OWN persistent
  // session (profile under DATA_DIR/browser-profiles/agent-<id>); anonymous runs
  // get ephemeral per-task sessions instead of one shared context.
  setBrowserSessionResolver((ctx) => {
    if (!ctx.taskId) return "shared";
    const owner = getTask(ctx.taskId)?.agentId;
    return owner ? `agent:${owner}` : `task:${ctx.taskId}`;
  });
  // Semantic companion-memory search: active only when the memory stack (and its
  // embedding model) is enabled; otherwise search stays honestly text-only.
  if (cfg.memory.enabled && cfg.memory.model) {
    setMemoryEmbedder(new OllamaEmbedder(cfg.ollamaUrl, cfg.memory.model));
  }

  const encodingIssues = scanEncoding(ROOT);
  if (encodingIssues.length > 0) {
    log.warn(`encoding check found ${encodingIssues.length} issue(s) — UI text may render incorrectly:`);
    log.warn(`\n${formatIssues(encodingIssues)}`);
  } else {
    log.info("encoding check: OK (no BOM, no mojibake, all JSON valid)");
  }

  const rt = await buildRuntime(cfg);
  rt.registry.registerAll(createScratchpadTools());
  rt.registry.registerAll(createInstructionHistoryTools());
  rt.registry.registerAll(createAgentSpawnTools());
  rt.registry.registerAll(createBrowserOperatorTools());
  rt.registry.registerAll(createDeepResearchTools());
  rt.registry.register(createWideResearchTool({ ollama: rt.ollama, parentRegistry: rt.registry }));
  const { ollama, registry, memory, mcp } = rt;

  const executeTask = async (opts: RunTaskOptions & { taskId: string; savedRun: SavedRun; signal: AbortSignal; lease?: RunLease }): Promise<{ taskId: string; text: string }> => {
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

    setTaskStatus(task, "running", undefined, opts.lease);
    activateRunSignal(task);
    opts.savedRun.started = true;
    saveRun(task, opts.savedRun, opts.lease);
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

    // Companion gateway: the work mode decides where the run executes and which
    // services it may touch; the resolver output is the only tool allowlist.
    const effectiveWorkMode = normalizeWorkMode(opts.savedRun.workMode ?? agent?.workMode);
    const workModeDefinition = getWorkMode(effectiveWorkMode);

    // Own-device mode (stage 2): the run executes inside the companion's real
    // isolated environment. No device / not ready → honest refusal, never a
    // silent fallback to the user's machine.
    let deviceRecord: CompanionDeviceRecord | undefined;
    let deviceToolInstances: ReturnType<typeof createDeviceTools> = [];
    if (workModeDefinition.requiresDevice) {
      if (!agentId || !agent) {
        throw new Error("وضع «جهاز المساعد المستقل» يتطلب مساعدًا محددًا — اختر رفيقًا له جهاز قبل تشغيله.");
      }
      deviceRecord = getDeviceByAgent(agentId);
      if (!deviceRecord) {
        throw new Error(`لا يوجد جهاز للمساعد «${agent.name}» — أنشئ جهازه من لوحة الجهاز في صفحة الرفقاء ثم أعد المحاولة.`);
      }
      if (deviceRecord.state === "provisioning") {
        throw new Error(`جهاز المساعد «${deviceRecord.name}» قيد التجهيز — انتظر اكتماله من لوحة الجهاز.`);
      }
      if (deviceRecord.state !== "running") {
        throw new Error(`جهاز المساعد «${deviceRecord.name}» حالته ${deviceRecord.state} — شغّله من لوحة الجهاز ثم أعد المحاولة.`);
      }
      const readiness = await deviceManager.isReady(deviceRecord.id);
      if (!readiness.ready) {
        deviceRecord.state = "error";
        deviceRecord.lastError = readiness.detail;
        throw new Error(`فحص جاهزية جهاز المساعد «${deviceRecord.name}» فشل: ${readiness.detail}`);
      }
      deviceToolInstances = createDeviceTools(deviceManager, deviceRecord, agentId);
    }

    // Companion personal memory (stage 4a): tools bound to THIS agent only, plus
    // a bounded context of its saved preferences/instructions.
    const memoryToolInstances = agentId ? createCompanionMemoryTools(agentId) : [];
    const teamToolInstances = agentId ? createCompanionTeamTools(agentId) : [];
    const memoryContextEntries = agentId ? memoryContext(agentId) : [];
    const memoryContextSuffix =
      memoryContextEntries.length > 0
        ? [`ذاكرة «${agent?.name ?? agentId}» الشخصية (احترمها وراجعها مع المستخدم عند التعارض):`, ...memoryContextEntries.map((e) => `- (${e.source === "user" ? "قاله المستخدم" : "استنتاج"} | ثقة ${e.confidence.toFixed(2)}) ${e.text}`)].join("\n")
        : undefined;
    const capabilities = resolveCompanionCapabilities({
      mode: effectiveMode,
      workMode: effectiveWorkMode,
      allowedServices: agent?.allowedServices,
      disabledTools: agent?.disabledTools,
      registeredTools: [...registry.names(), ...COMPANION_DYNAMIC_TOOL_NAMES],
    });
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
    // Shared resources reset ONLY for runs that will actually use them — the
    // execution queue serializes browser-lane runs among themselves, so a
    // parallel own-device/office run never kills another run's browser/preview.
    const usesBrowser = capabilities.allow.some((t) => t.startsWith("browser_"));
    const usesPreview = capabilities.allow.some((t) => t === "preview_serve" || t === "preview_stop" || t === "preview_status");
    try {
      if (usesBrowser) {
        // Companion browser sessions PERSIST between runs (durable logins);
        // only anonymous per-task sessions are reset for isolation.
        const browserOwner = agentId ? null : getTask(task)?.agentId ?? null;
        if (!browserOwner) await closeBrowserSession(`task:${task}`);
      }
      if (usesPreview) rt.preview.stop();
      const verdicts: VerdictRecord[] = [];
      wrappedEmit({ type: "mode", mode: effectiveMode, label: modeDefinition.label, labelAr: modeDefinition.labelAr, reason: "selected task mode" });
      wrappedEmit({
        type: "workmode",
        workMode: effectiveWorkMode,
        labelAr: workModeDefinition.labelAr,
        deviceRequired: workModeDefinition.requiresDevice,
        ...(deviceRecord ? { deviceId: deviceRecord.id, deviceName: deviceRecord.name } : {}),
        reason: "selected work mode",
      });
      const agentSuffix = agent ? agentSystemSuffix(agent) : undefined;
      const suffix = [
        `You are Loam. Active mode: ${modeDefinition.labelAr}. ${modeDefinition.description} Only use the provided tool capabilities.`,
        modeDefinition.outputHint,
        workModeDefinition.policy,
        memoryContextSuffix,
        agentSuffix, askModeSuffix,
      ].filter(Boolean).join("\n\n");
      // The gateway's resolved allowlist is the base tool set for this run: mode ∪
      // work-mode grants − revoked services − agent service/tool denials. Always-on
      // core tools (per-agent scratchpad — low-risk, approval-free) are merged in on
      // top; the agent's tool denials still remove them. In own-device mode the
      // device_* tools are bound to the companion's device; companion-memory tools
      // are bound to this agent in every mode.
      const dynamicAllow = new Set(capabilities.allow);
      const runAllow = mergeAlwaysOnTools({ resolvedAllow: capabilities.allow, registeredTools: registry.names(), disabledTools: agent?.disabledTools });
      const agentTools = registry.forAllowlist(runAllow).withTools([...deviceToolInstances, ...memoryToolInstances, ...teamToolInstances].filter((t) => dynamicAllow.has(t.name)));

      // Sensitive host-input actions need an explicit user decision first (section 18).
      const SENSITIVE_HOST_INPUT = new Set(["computer_click", "computer_type", "computer_key", "computer_ui_click", "computer_ui_set_text"]);
      for (const name of agentTools.names()) {
        if (!SENSITIVE_HOST_INPUT.has(name)) continue;
        const original = agentTools.get(name)!;
        agentTools.replaceTool({
          ...original,
          async run(args, ctx) {
            const approval = createApproval({ taskId: task, tool: name, summary: `إجراء تحكم حساس بجهازك (${name}) في انتظار موافقتك`, argsPreview: JSON.stringify(args ?? {}) });
            wrappedEmit({ type: "approval_required", approvalId: approval.id, tool: name, summary: approval.summary });
            const decision = await waitForDecision(approval.id, runSignal);
            if (decision !== "approved") {
              return { ok: false, content: decision === "denied" ? "رفض المستخدم هذا الإجراء — لم يُنفّذ." : `انتهت مهلة الموافقة (${decision}) — لم يُنفّذ.` };
            }
            return original.run(args, ctx);
          },
        } satisfies Tool);
      }
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
        saveCheckpoint: (checkpoint) => { opts.savedRun.checkpoint = checkpoint; saveRun(task, opts.savedRun, opts.lease); },
      }) : await runAgent(agentOpts);
      // The orchestrator can swallow an abort (it reports a failed step instead),
      // so treat a cancelled run explicitly — never as success.
      if (runSignal.aborted) throw new Error("cancelled by user");
      if (result.verified !== true) throw new Error("task incomplete: mandatory final verification missing");
      completeTaskRun(task, result.text, result.model, opts.lease);
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
      let statusWritten = true;
      try {
        setTaskStatus(task, cancelled ? "cancelled" : "error", { error: cancelled ? "cancelled by user" : message }, opts.lease);
      } catch (writeError) {
        statusWritten = false;
        log.warn(`lease-fenced status write rejected for ${task}: ${String(writeError)}`);
      }
      if (statusWritten) {
        publishTaskEvent(task, cancelled ? { type: "cancelled" } : { type: "error", message });
        wrappedEmit({ type: "error", message: cancelled ? "⏹ أُوقفت المهمة بناءً على طلبك" : message });
      }
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
        workMode: normalizeWorkMode(opts.workMode ?? agent?.workMode),
        orchestrated: cfg.orchestrator.enabled, started: false,
      };
    }
    const task = previous ?? createTask(saved.prompt, opts.title, saved.projectId, saved.agentId);
    saved.mode = getLoamMode(saved.mode).id;
    setTaskMode(task.id, saved.mode);
    saved.workspace = ensureTaskWorkspace(task.id, cfg.workspace);
    queueTaskRun(task.id, saved, opts.resume === true, opts.scheduleId, opts.title);
    // Resource locks (parallel lanes): browser/preview are the only shared
    // runtime states a run may reset — everything else (own devices, files,
    // office/data) is per-run and runs fully in parallel.
    const laneAgent = saved.agentId ? getAgent(saved.agentId) : undefined;
    const laneCaps = resolveCompanionCapabilities({
      mode: saved.mode,
      workMode: normalizeWorkMode(saved.workMode ?? laneAgent?.workMode),
      allowedServices: laneAgent?.allowedServices,
      disabledTools: laneAgent?.disabledTools,
      registeredTools: [...registry.names(), ...COMPANION_DYNAMIC_TOOL_NAMES],
    });
    // Browser runs no longer lock: each run browses in its own isolated session.
    const locks: string[] = [];
    if (laneCaps.allow.some((t) => t === "preview_serve" || t === "preview_stop" || t === "preview_status")) locks.push("preview");
    // user_device runs share the single user-desktop resource; parallel runs must not fight over mouse/keyboard.
    // EVERY computer_* tool touches the same desktop, so the lock covers them all.
    if (laneCaps.allow.some((t) => t.startsWith("computer_"))) locks.push("user-desktop");
    // Each companion device is one machine: runs targeting the same device serialize on it.
    const laneDevice = saved.agentId ? getDeviceByAgent(saved.agentId) : undefined;
    if (laneCaps.allow.some((t) => t.startsWith("device_")) && laneDevice) locks.push(`device:${laneDevice.id}`);
    const signal = createRunSignal(task.id, false);
    opts.emit({ type: "task", taskId: task.id });
    opts.emit({ type: "task-status", status: "queued" });
    publishTaskEvent(task.id, { type: "task-status", status: "queued" });
    let lease: RunLease | undefined;
    let heartbeat: LeaseHeartbeat | undefined;
    try {
      const claimed = claimRunLease(task.id);
      lease = claimed;
      heartbeat = startLeaseHeartbeat(claimed, () => cancelRunSignal(task.id));
      return await executionQueue.enqueue(task.id, () => executeTask({
        ...opts, ...saved, taskId: task.id, savedRun: saved, signal, lease: claimed,
      }), signal, locks);
    } catch (error) {
      if (getTask(task.id)?.status === "queued" || getTask(task.id)?.status === "running") {
        const message = error instanceof Error ? error.message : String(error);
        try {
          setTaskStatus(task.id, isCancelledError(error) ? "cancelled" : "error", { error: message }, lease);
        } catch (writeError) {
          log.warn(`lease-fenced status write rejected for ${task.id}: ${String(writeError)}`);
        }
        const event = { type: "error" as const, message };
        opts.emit(event); publishTaskEvent(task.id, event);
      }
      throw error;
    } finally { clearRunSignal(task.id); heartbeat?.stop(); if (lease) releaseRunLease(lease); }
  };

  // Companion-to-companion delegation: the delegate task is created and queued
  // under the TARGET companion; we return its id immediately — the execution
  // queue is serial, so awaiting completion here would deadlock the delegating run.
  setDelegationRunner((req) => {
    const target = getAgent(req.toAgentId);
    const task = createTask(req.brief, req.title ?? `تفويض → ${target?.name ?? req.toAgentId}`, null, req.toAgentId);
    setTaskDelegator(task.id, req.fromAgentId);
    if (req.mode) setTaskMode(task.id, req.mode);
    void runTask({ taskId: task.id, prompt: req.brief, agentId: req.toAgentId, ...(req.mode ? { mode: req.mode } : {}), emit: () => {} })
      .catch((error) => log.warn(`delegation run ${task.id}: ${String(error)}`));
    return Promise.resolve({ taskId: task.id, queued: true });
  });

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

  // A1: Start the Manus-style protocol adapter (Connect RPC + socket.io) on top of Loam.
  const protocolAdapter = await startProtocolAdapter({ cfg, runTask, getTask });

  // Event-driven routines (16): file watchers reuse the scheduled-run path so a
  // triggered routine runs under its companion exactly like a cron routine.
  const scheduledRun = async (prompt: string, scheduleId: string, agentId?: string, workMode?: string): Promise<string> => {
    const res = await runTask({
      prompt,
      scheduleId,
      ...(agentId ? { agentId } : {}),
      ...(workMode ? { workMode } : {}),
      emit: () => {
        /* triggered runs are persisted in db, no SSE consumer */
      },
    });
    return res.taskId;
  };
  const { startFileWatchers, stopAllWatchers } = await import("./server/fileWatchers.js");
  type ScheduledRun = (o: { prompt: string; scheduleId: string; agentId?: string; workMode?: string }) => Promise<string>;
  const scheduledRunObj: ScheduledRun = (o) => scheduledRun(o.prompt, o.scheduleId, o.agentId, o.workMode);
  startFileWatchers(scheduledRunObj);
  const { startServiceWatch } = await import("./server/serviceWatch.js");
  const stopServiceWatch = startServiceWatch({
    probe: () => fetch(cfg.ollamaUrl.replace(/\/+$/, "") + "/api/tags", { signal: AbortSignal.timeout(5000) }).then((r) => r.ok).catch(() => false),
    run: scheduledRunObj,
    watches: () => listSchedules().filter((s2) => s2.kind === "service-watch").map((s2) => ({ id: s2.id, prompt: s2.prompt, agentId: s2.agentId, workMode: s2.workMode })),
  });
  (globalThis as { __loamScheduledRun?: ScheduledRun }).__loamScheduledRun = scheduledRunObj;

  const stopScheduler = startScheduler({ runScheduled: scheduledRun });

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
    stopAllWatchers();
    stopServiceWatch();
    if (evalTimer) clearInterval(evalTimer);
    executionQueue.stop();
    for (const id of listRunningSignals()) cancelRunSignal(id);
    await rt.dispose();
    await protocolAdapter.close();
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
