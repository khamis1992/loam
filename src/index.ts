import fs from "node:fs";
import { EventLog } from "./session/eventLog.js";
import { ensureTaskWorkspace } from "./server/taskWorkspace.js";
import path from "node:path";
import { loadConfig, ROOT, DATA_DIR } from "./config.js";
import { setLocalAuthUserDataDir } from "./security/localAuth.js";
import { buildRuntime } from "./setup/runtime.js";
import { type ToolTraceItem } from "./agent/reflect.js";
import { loadPending, writeGate } from "./server/pending.js";
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
import { managedSessions } from "./server/managedSessions.js";
import { createApproval, waitForDecision } from "./server/approvals.js";
import { approvalStableKey, getReplayDecision, matchApprovalRule, saveApprovalDecision, taskApprovalAuto, taskSandboxMode, taskPermissionMode } from "./server/approvalRules.js";
import { resolveSandboxPolicy } from "./policy/riskTier.js";
import { DEFAULT_PERMISSION_MODE, isPlanMode } from "./policy/permissionModes.js";
import type { Tool } from "./tools/registry.js";
import { createScratchpadTools } from "./tools/scratchpadTools.js";
import { createEnvironmentIssueTools } from "./tools/environmentIssueTools.js";
import { createDeepResearchTools } from "./tools/deepResearch.js";
import { createBoardTools } from "./tools/boardTools.js";
import { createInstructionHistoryTools } from "./tools/instructionTools.js";
import { createAgentSpawnTools } from "./tools/agentSpawnTools.js";
import { createBrowserOperatorTools } from "./tools/browserOperator.js";
import { suggestSkillsAfterSession } from "./tools/skillSuggest.js";
import { createWideResearchTool } from "./tools/wideResearch.js";
import { createFindAndEditTools } from "./tools/findAndEdit.js";
import { createGroupTools } from "./tools/groupTools.js";
import { createBackendScaffoldTools } from "./tools/backendScaffold.js";
import { createWebScaffoldTools } from "./tools/webScaffold.js";
import { createDesignStudioTools } from "./tools/designStudio.js";
import { createPlaybookTools } from "./tools/playbookTools.js";
import { createOfficeEditTools } from "./tools/officeEditAgent.js";
import { createVideoEditTools } from "./tools/videoEditAgent.js";
import { createVideoStudioTools } from "./tools/videoStudio.js";
import { createDeployTools } from "./tools/deploy.js";
import { createDesignExploreTools } from "./tools/designExplore.js";
import { createDesignLintTools } from "./tools/designLint.js";
import { createDesignAssetsTools } from "./tools/designAssets.js";
import { createDesignBriefTools } from "./tools/designBrief.js";
import { createDesignAutofixTools } from "./tools/designAutofix.js";
import { createDesignCritiqueTools } from "./tools/designCritique.js";
import { createConnectorTools } from "./tools/connectorTools.js";
import { createWorkflowTools } from "./tools/workflow.js";
import { createFanoutTool } from "./tools/fanout.js";
import { applyPlanApprovalGate, applyPlanModeGate, createPlanTools } from "./tools/planTools.js";
import { applyAskUserGate, createAskUserTools } from "./tools/askUserTools.js";
import { connectedConnectorToolNames } from "./server/connectors/index.js";
import { mergeAlwaysOnTools } from "./server/runTools.js";
import { applyKnowledgeGate } from "./server/knowledgeTools.js";
import { planQuickEditRoute } from "./agent/quickEdit.js";
import { SIDE_CHAT_READ_ONLY_TOOLS } from "./agent/sideChat.js";
import { OllamaEmbedder } from "./memory/embeddings.js";
import { publishTaskEvent } from "./server/streams.js";
import { videoStudioRelay } from "./server/videoStudioRelay.js";
import { formatIssues, scanEncoding } from "./scripts/check-encoding.js";
import { runAgent } from "./agent/loop.js";
import { isOutputType, modelAbChain, normalizeEffort, type EffortLevel } from "./llm/router.js";
import { runOrchestratedAgent, type VerdictRecord } from "./agent/orchestrator.js";
import type { Emit } from "./agent/events.js";
import { applyRunEvent, beginRun, recallGraphHandle } from "./agent/runGraphAdapter.js";
import { createRecallTools } from "./tools/memory.js";
import { OllamaClient } from "./ollama.js";
import { flexCredentials } from "./server/modelTiers.js";
import { startServer, type RunTaskOptions } from "./server/http.js";
import { logMissingCraftDists } from "./server/craftStatus.js";
import { appendMessage, appendStep, createTask, getProject, getTask, loadDb, setTaskStatus, listSchedules, setTaskDelegator } from "./server/db.js";
import { conversationHistory } from "./agent/history.js";
import { startScheduler } from "./server/scheduler.js";
import { startChannelRouter } from "./server/channels/router.js";
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
import {
  admitAllPending,
  admitPending as admitPendingInputs,
  hasPending,
} from "./server/inputQueue.js";
import { claimRunLease, releaseRunLease, startLeaseHeartbeat, type LeaseHeartbeat, type RunLease } from "./server/runLease.js";
import { recordTaskUsage } from "./server/credits.js";
// D19 session runtime: sleep/wake lifecycle + per-session compute budget.
import { SessionRuntime, DEFAULT_IDLE_MINUTES, DEFAULT_STEP_LIMIT, DEFAULT_TOKEN_LIMIT } from "./server/sessionRuntime.js";
import { browserSessionFor } from "./tools/browser.js";
import { killAllSessions } from "./tools/pty.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  setLocalAuthUserDataDir(process.env.LOAM_LOCAL_TOKEN_DIR || DATA_DIR);
  loadDb();
  acquireRuntimeLease();
  backupDatabase();
  const recovered = recoverInterruptedTasks();
  if (recovered) log.info(`recovery: ${recovered} interrupted task(s) awaiting resume`);
  // O6: messages that arrived while the process was down become durable `input`
  // events now, even if their task is never resumed. Admitting twice is safe
  // because the append is keyed by the input id.
  const admittedInputs = admitAllPending();
  if (admittedInputs.length > 0) log.info(`recovery: admitted ${admittedInputs.length} queued message(s)`);
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
  rt.registry.registerAll(createEnvironmentIssueTools());
  rt.registry.registerAll(createBoardTools());
  rt.registry.registerAll(createInstructionHistoryTools());
  rt.registry.registerAll(createAgentSpawnTools());
  rt.registry.registerAll(createBrowserOperatorTools());
  rt.registry.registerAll(createDeepResearchTools());
  rt.registry.register(createWideResearchTool({ ollama: rt.ollama, parentRegistry: rt.registry }));
  rt.registry.register(createFanoutTool({ ollama: rt.ollama, parentRegistry: rt.registry }));
  rt.registry.registerAll(createFindAndEditTools({ ollama: rt.ollama }));
  rt.registry.registerAll(createGroupTools());
  rt.registry.registerAll(createBackendScaffoldTools());
  rt.registry.registerAll(createWebScaffoldTools());
  rt.registry.registerAll(createDesignStudioTools());
  rt.registry.registerAll(createPlaybookTools({ ollama: rt.ollama }));
  rt.registry.registerAll(createOfficeEditTools());
  rt.registry.registerAll(createVideoEditTools());
  rt.registry.registerAll(createVideoStudioTools({ relay: videoStudioRelay }));
  rt.registry.registerAll(createDeployTools({ workspace: cfg.workspace, preview: rt.preview }));
  rt.registry.registerAll(createDesignExploreTools());
  rt.registry.registerAll(createDesignLintTools());
  rt.registry.registerAll(createDesignAssetsTools());
  rt.registry.registerAll(createDesignBriefTools({ ollama: rt.ollama }));
  rt.registry.registerAll(createDesignAutofixTools());
  rt.registry.registerAll(createDesignCritiqueTools(rt.preview, { ollama: rt.ollama }));
  rt.registry.registerAll(createConnectorTools());
  rt.registry.registerAll(createWorkflowTools({ ollama: rt.ollama, registry: rt.registry }));
  rt.registry.registerAll(createPlanTools());
  rt.registry.registerAll(createAskUserTools());
  const { ollama, registry, memory, mcp } = rt;

  // D19 session runtime: one manager owns both the sleep lifecycle and the
  // per-session compute budget. Hooks release real resources (the browser
  // context for this task and its pty terminals) only AFTER the session state
  // has been persisted, and wake restores the browser on the next message.
  const sessionRuntime = new SessionRuntime({
    idleMinutes: cfg.session?.idleMinutes || DEFAULT_IDLE_MINUTES,
    stepLimit: cfg.session?.stepLimit || DEFAULT_STEP_LIMIT,
    tokenLimit: cfg.session?.tokenLimit || DEFAULT_TOKEN_LIMIT,
  });
  sessionRuntime.start();

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

    // D19 session runtime: the run starts, so the session is active and its
    // budget is live. Hooks release this task's browser context and pty
    // terminals when it later sleeps, after the state has been persisted.
    void sessionRuntime.markActive(task);
    sessionRuntime.setHooks(task, {
      persist: () => { saveRun(task, opts.savedRun, opts.lease); },
      release: () => {
        void closeBrowserSession(browserSessionFor({ cfg, workspace: opts.savedRun.workspace, emit: () => {}, taskId: task }));
        // D19: reclaim this session's terminals. An exited session is already
        // gone from the registry, so only live ones need killing.
        killAllSessions();
      },
      restore: () => {
        // The browser is recreated lazily by the next browser_* tool call and
        // pty sessions are created on demand by pty_start; nothing to do here.
      },
    });

    const startedAt = Date.now();
    const promptHash = hashPrompt(effectivePrompt);

    // Session event log: mirror agent emit() events into a per-task append-only log.
    // Logging must never break the task, so open/append failures are caught and warned.
    let sessionLog: EventLog | undefined;
    if (cfg.sessionLog?.enabled !== false) {
      try {
        const log = new EventLog(task);
        await log.init(task, process.cwd());
        sessionLog = log;
      } catch (err) {
        console.warn(`[sessionLog] failed to open log for task ${task}: ${String(err)}`);
      }
    }

    const trace: ToolTraceItem[] = [];
    const lastArgs = new Map<string, unknown>();
    let doneEvent: Parameters<Emit>[0] | undefined;
    // Neo run graph (N1): record the agent's events as nodes of the task's graph.
    // Off by config, and recording must never break the task, so the adapter
    // swallows and logs any failure instead of throwing into the run.
    const recordGraph = cfg.runGraph?.enabled !== false;
    if (recordGraph) beginRun(task, effectivePrompt || "");
    const wrappedEmit: Emit = (event) => {
      if (recordGraph) applyRunEvent(task, event);
      if (sessionLog) {
        try {
          void sessionLog.append(event.type, event).catch((err) => {
            console.warn(`[sessionLog] failed to append event: ${String(err)}`);
          });
        } catch (err) {
          console.warn(`[sessionLog] failed to append event: ${String(err)}`);
        }
      }
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
    // Option 18 Flex: when the chosen model is the vault-backed flex model, run through the
    // user's own base URL/key with a run-scoped client. The key never leaves this boundary.
    const flexCreds = opts.model && opts.model.trim().length > 0 ? flexCredentials() : null;
    const flexModelId = flexCreds ? (flexCreds.model.endsWith(":cloud") ? flexCreds.model : `${flexCreds.model}:cloud`) : "";
    const runOllama = flexCreds && effectiveCfg.model === flexModelId ? new OllamaClient(cfg.ollamaUrl, { baseUrl: flexCreds.baseUrl, apiKey: flexCreds.apiKey }) : ollama;

    // Loam task controls: explicit mode and execution effort.
    const effortBudgets: Record<string, number> = { max: 80, high: 64, medium: 40, low: 16 };
    const modeDefinition = getLoamMode(opts.savedRun.mode);
    const effectiveMode = modeDefinition.id;
    const askMode = effectiveMode === "ask";
    const effectiveEffort = String(opts.effort ?? agent?.effort ?? "").toLowerCase();
    const effortMaxSteps = effortBudgets[effectiveEffort];
    const runSignal = opts.signal;
    // Neo N10: the composer's output type and effort level are resolved once, here,
    // so the loop, the prompt and the routing map all agree on the same values.
    const runOutputType = isOutputType(opts.outputType) ? opts.outputType : "auto";
    const routingEffort: EffortLevel | "" = normalizeEffort(opts.effort ?? agent?.effort ?? "");
    // Neo N10 A/B: an explicit arm list wins; otherwise the routing map's own
    // models (per-tool specialists + effort model) become the sibling arms.
    const abModels = opts.abModels && opts.abModels.length > 0
      ? [...new Set(opts.abModels.map((m) => m.trim()).filter(Boolean))].slice(0, 4)
      : modelAbChain({ cfg, outputType: runOutputType, effort: routingEffort }, 4).filter((m) => m !== chosenModel);
    const hasAbArms = abModels.length >= 2;

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
    // N16 cross-run recall: the shelf is process-wide, but *attaching* a recalled
    // node is run-scoped, so these instances are rebuilt per run with the run id
    // and a callback that files the hit into this run's graph.
    const recallToolInstances = createRecallTools({
      index: rt.recall ?? undefined,
      runId: task,
      attach: (source, runId, query) =>
        recallGraphHandle().attachRecallNode(
          runId,
          source,
          query,
          (s) => recallGraphHandle().getNode(s.nodeId, s.runId),
        ) ?? undefined,
    });
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
    const sideChatSuffix = opts.savedRun.sideChat
      ? "سؤال جانبي (Side chat): أجب عن سؤال المستخدم بالقراءة والتحليل فقط. المهمة الرئيسية ما زالت تعمل؛ لا تعدّل أي ملف، لا تنفّذ أوامر، ولا تتدخّل في سير المهمة."
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
    const usesPreview = capabilities.allow.some((t) => t === "preview_serve" || t === "preview_stop" || t === "preview_status" || t === "preview_screenshot");
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
      // Quick-edit route: a narrow follow-up edit runs on the fast model with a
      // targeted-edit instruction; larger work keeps the base model.
      const quickEditRoute = planQuickEditRoute(effectiveCfg, effectivePrompt);
      // Provenance-aware index summary: a bounded digest of long-term memory so
      // the agent knows what it already knows without a tool call.
      const memoryIndexSummary = memory && memory.count > 0 ? memory.indexSummary(8) : undefined;
      const suffix = [
        `You are Loam. Active mode: ${modeDefinition.labelAr}. ${modeDefinition.description} Only use the provided tool capabilities.`,
        modeDefinition.outputHint,
        workModeDefinition.policy,
        memoryContextSuffix,
        memoryIndexSummary,
        agentSuffix, askModeSuffix, sideChatSuffix,
        quickEditRoute.suffix,
      ].filter(Boolean).join("\n\n");
      // The gateway's resolved allowlist is the base tool set for this run: mode ∪
      // work-mode grants − revoked services − agent service/tool denials. Always-on
      // core tools (per-agent scratchpad — low-risk, approval-free) are merged in on
      // top; the agent's tool denials still remove them. In own-device mode the
      // device_* tools are bound to the companion's device; companion-memory tools
      // are bound to this agent in every mode.
      const dynamicAllow = new Set(capabilities.allow);
      const baseRunAllow = mergeAlwaysOnTools({ resolvedAllow: [...capabilities.allow, ...connectedConnectorToolNames(agent?.disabledTools)], registeredTools: registry.names(), disabledTools: agent?.disabledTools });
      // Side-chat ("/btw question") runs are read-only: even when a mutating
      // tool is granted by the mode/work mode, the side-chat question may never
      // modify files, run commands or drive the browser while the main run lives.
      const runAllow = opts.savedRun.sideChat
        ? baseRunAllow.filter((name) => SIDE_CHAT_READ_ONLY_TOOLS.includes(name))
        : baseRunAllow;
      // N3 Knowledge Garden: kb_* tools stay registered (the companion gateway
      // advertises them) but only reach the model when the run's garden is on.
      const knowledgeRunAllow = applyKnowledgeGate(runAllow, opts.savedRun.knowledge === true);
      const runAllowSet = new Set(knowledgeRunAllow);
      // N16: recall/recall_status are always-on names (runTools.ts) but the
      // run-scoped instances above are the ones that can attach a hit to THIS
      // run, so they replace the process-wide copies instead of colliding.
      const agentTools = registry.forAllowlist(knowledgeRunAllow).withBound([...deviceToolInstances, ...memoryToolInstances, ...teamToolInstances, ...recallToolInstances].filter((t) => dynamicAllow.has(t.name) && runAllowSet.has(t.name)));

      // Sensitive host-input actions need an explicit user decision first (section 18).
      // MF4 (option 14): the gate resolves each request idempotently — replay of a
      // decided key returns the same decision, saved approval rules (agent-specific
      // first, then global) and the per-task "Approve for me" mode are checked
      // BEFORE prompting, and no card is shown twice.
      const SENSITIVE_HOST_INPUT = new Set(["computer_click", "computer_type", "computer_key", "computer_ui_click", "computer_ui_set_text"]);
      for (const name of agentTools.names()) {
        if (!SENSITIVE_HOST_INPUT.has(name)) continue;
        const original = agentTools.get(name)!;
        agentTools.replaceTool({
          ...original,
          async run(args, ctx) {
            const toolCallId = (ctx as { toolCallId?: string } | undefined)?.toolCallId;
            const stableKey = approvalStableKey(task, toolCallId, name, args);
            const replay = getReplayDecision(stableKey);
            const autoForTask = !replay && taskApprovalAuto(task);
            const rule = !replay && !autoForTask ? matchApprovalRule({ agentId: agentId ?? null, tool: name, args }) : undefined;
            if (replay || autoForTask || rule) {
              const allow = replay ? replay.decision === "allow" : autoForTask ? true : rule!.decision === "allow";
              saveApprovalDecision(stableKey, allow ? "allow" : "deny", replay ? replay.source : autoForTask ? "auto" : "rule");
              if (!allow) {
                return { ok: false, content: "رفض المستخدم هذا الإجراء — لم يُنفّذ." };
              }
            } else {
              const approval = createApproval({ taskId: task, tool: name, summary: `إجراء تحكم حساس بجهازك (${name}) في انتظار موافقتك`, argsPreview: JSON.stringify(args ?? {}) });
              wrappedEmit({ type: "approval_required", approvalId: approval.id, tool: name, summary: approval.summary });
              const decision = await waitForDecision(approval.id, runSignal);
              saveApprovalDecision(stableKey, decision === "approved" ? "allow" : "deny", "user");
              if (decision !== "approved") {
                return { ok: false, content: decision === "denied" ? "رفض المستخدم هذا الإجراء — لم يُنفّذ." : `انتهت مهلة الموافقة (${decision}) — لم يُنفّذ.` };
              }
            }
            return original.run(args, ctx);
          },
        } satisfies Tool);
      }
      // Plan mode (C13): a task whose local permission mode is `plan` is strictly
      // read-only. Every tool call is gated before it runs — reads and read-only
      // web research pass, while writes, commands, destructive and secret actions
      // are refused with an actionable message. `plan_exit` is the escape hatch:
      // it presents the plan through the existing approval card and, once the
      // user approves, switches the task to acceptEdits (`approve_for_me`). The
      // wrapper re-reads the mode on each call so later edits in the same run are
      // allowed after approval.
      if (isPlanMode(taskPermissionMode(task) ?? DEFAULT_PERMISSION_MODE)) {
        applyPlanModeGate(agentTools, { taskId: task, workspaceRoot: effectiveCfg.workspace });
      }
      // Pending plan approval (D4): while `suggest_plan` has a plan awaiting the
      // user's decision, every mutating tool call is refused. `suggest_plan`
      // itself stays available so the model can re-present a plan after an edit.
      // The wrapper re-checks the pending store on each call, so once the plan
      // is approved later edits in the same run proceed.
      applyPlanApprovalGate(agentTools, { taskId: task, workspaceRoot: effectiveCfg.workspace });
      // Pending ask-user request (N9): while a clarification is unanswered, every
      // mutating tool call is refused so the run cannot guess past the question.
      // Read/network tools stay available so the agent can still gather context
      // while it waits, and `ask_user` stays available for a follow-up question.
      applyAskUserGate(agentTools, { taskId: task, workspaceRoot: effectiveCfg.workspace });
      // Sandbox gate (risk-tier approval): config default < per-task persisted
      // override < explicit approved override. The resolved mode is rendered into
      // the system prompt so the model knows what it may do without asking.
      const sandboxPolicy = resolveSandboxPolicy({
        session: {
          policy: effectiveCfg.policy.sandboxMode,
          override: taskSandboxMode(task),
          workspaceRoot: effectiveCfg.workspace,
        },
        workspaceRoot: effectiveCfg.workspace,
      });
      const agentOpts = {
        cfg: effectiveCfg,
        ollama: runOllama,
        tools: agentTools,
        emit: wrappedEmit,
        prompt: effectivePrompt,
        history,
        memories,
        ...(suffix ? { systemSuffix: suffix } : {}),
        ...(effortMaxSteps ? { maxSteps: effortMaxSteps } : {}),
        model: quickEditRoute.model,
        // Neo N10: output type narrows the tool set, effort picks the model and
        // the A/B arms fan the same prompt out on the canvas.
        outputType: runOutputType,
        effort: routingEffort,
        ...(hasAbArms ? { abModels } : {}),
        signal: runSignal,
        taskId: task,
        sandboxMode: sandboxPolicy.mode,
        // O6: drain the durable inbound queue at each step boundary so a message
        // sent while this run was busy becomes a durable `input` event exactly once.
        ...(opts.inputSessionId
          ? { inputSessionId: opts.inputSessionId, onAdmitPending: (sessionId: string) => admitPendingInputs(sessionId) }
          : {}),
        // D19 compute budget: shared with the UI badge so the counters and the
        // badge always agree, and the run stops when the ceiling is hit.
        budget: sessionRuntime.getBudget(task),
      };
      const result = opts.savedRun.orchestrated ? await runOrchestratedAgent({
        ...agentOpts, verdicts: verdicts as VerdictRecord[], resume: opts.savedRun.checkpoint, lifecycleHooks: true,
        saveCheckpoint: (checkpoint) => { opts.savedRun.checkpoint = checkpoint; saveRun(task, opts.savedRun, opts.lease); },
      }) : await runAgent(agentOpts);
      // The orchestrator can swallow an abort (it reports a failed step instead),
      // so treat a cancelled run explicitly — never as success.
      if (runSignal.aborted) throw new Error("cancelled by user");
      if (result.verified !== true) throw new Error("task incomplete: mandatory final verification missing");
      // D19: the run stopped working and is now waiting on the user. The
      // session may sleep after the idle threshold and be woken by a message.
      sessionRuntime.markIdle(task);
      completeTaskRun(task, result.text, result.model, opts.lease);
      recordTaskUsage(task, result.usage); // OPD #9: one mock usage entry per completed task
      if (doneEvent) {
        appendStep(task, { at: new Date().toISOString(), type: doneEvent.type, data: doneEvent });
        emit(doneEvent);
        publishTaskEvent(task, doneEvent);
      }
      // Turn boundary: drain pending appends and fsync the session log.
      await sessionLog?.flush();
      recordTelemetry("done", { model: result.model, steps: result.steps, usage: { promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens } });
      // Repo-local skill auto-suggest: after a successful session, propose a new
      // SKILL.md from the observed setup/verify steps. Staged for approval only.
      if (effectiveCfg.skills.autoSuggest) {
        void suggestSkillsAfterSession({
          cfg: effectiveCfg,
          ollama: runOllama,
          projectRoot: effectiveCfg.workspace,
          prompt: effectivePrompt,
          finalText: result.text,
          trace,
          gate: writeGate,
        }).catch((err) => log.warn(`skill suggest failed: ${String(err)}`));
      }
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
      // Turn boundary on failure/cancel too: fsync whatever was logged so far.
      await sessionLog?.flush();
      if (!cancelled) throw err;
      return { taskId: task, text: "" };
    }
  };

  const runTask = async (opts: RunTaskOptions): Promise<{ taskId: string; text: string }> => {
    const previous = opts.taskId ? getTask(opts.taskId) : undefined;
    if (opts.taskId && !previous) throw new Error("task not found");
    if (opts.taskId && executionQueue.has(opts.taskId)) throw new Error("task already queued or running");
    // D19: a new user message wakes a sleeping session and restores its
    // released resources before the run starts.
    if (opts.taskId) await sessionRuntime.onUserMessage(opts.taskId);
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
        // Neo N10: the composer's output type and the resolved routing effort
        // survive the queue, so a resumed run keeps the same model map.
        outputType: isOutputType(opts.outputType) ? opts.outputType : undefined,
        routingEffort: normalizeEffort(opts.effort ?? agent?.effort ?? ""),
        workMode: normalizeWorkMode(opts.workMode ?? agent?.workMode),
        orchestrated: cfg.orchestrator.enabled, started: false,
        sideChat: opts.sideChat === true,
        knowledge: opts.knowledge === true,
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
    if (laneCaps.allow.some((t) => t === "preview_serve" || t === "preview_stop" || t === "preview_status" || t === "preview_screenshot")) locks.push("preview");
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
    } finally {
      clearRunSignal(task.id); heartbeat?.stop(); if (lease) releaseRunLease(lease); videoStudioRelay.cancelTask(task.id);
      // O6: a message that landed during the last step would otherwise sit
      // `received` forever, since no further step boundary runs. Admit it on every
      // exit path (done, error, cancel) so it is never silently lost.
      if (opts.inputSessionId && hasPending(opts.inputSessionId)) {
        const carried = admitPendingInputs(opts.inputSessionId);
        log.info(`input queue: admitted ${carried.length} message(s) at run end for ${opts.inputSessionId}`);
      }
    }
  };

  // Bridge for src/server/routes/retryLast.ts: the route module cannot receive
  // runTask through startServer deps, so it reads this global per request.
  (globalThis as { __loamRunTask?: typeof runTask }).__loamRunTask = runTask;
  // Tool registry bridge for route modules that narrow tool sets (D16 side chat).
  (globalThis as { __loamRegistry?: unknown }).__loamRegistry = registry;

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

  // D12: managed child sessions wake the coordinator by event, not polling.
  // A child finishing (or asking for input) enqueues a fresh run for the parent
  // agent with a synthesized prompt, so the coordinator resumes exactly once.
  managedSessions.onAnyCoordinatorWake((event) => {
    if (event.type === "needs_input") {
      void runTask({
        prompt: `[managed child ${event.childId} needs input]\n${event.question ?? "(no question provided)"}\nAnswer it with managed_child_answer.`,
        agentId: event.parentAgentId,
        emit: () => {
          /* triggered runs are persisted in db, no SSE consumer */
        },
      }).catch((error) => log.warn(`managed child input wake run: ${String(error)}`));
      return;
    }
    const summary = event.status === "done"
      ? (event.output || "(no output)")
      : `status=${event.status}${event.error ? `: ${event.error}` : ""}`;
    void runTask({
      prompt: `[managed child ${event.childId} finished: ${event.status}]\n${summary}`,
      agentId: event.parentAgentId,
      emit: () => {
        /* triggered runs are persisted in db, no SSE consumer */
      },
    }).catch((error) => log.warn(`managed child wake run: ${String(error)}`));
  });

  const server = await startServer({
    cfg,
    ollama,
    registry,
    runTask,
    memory: memory ?? undefined,
    embedder: rt.embedder ?? undefined,
    screenLive: rt.screenLive,
    preview: rt.preview,
    mcp,
  });

  // Non-failing startup check: log how to install any missing Craft dists.
  // Never downloads; a missing dist just means the app falls back to Loam's
  // own editor for that file type.
  logMissingCraftDists();

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

  // MF7: url-change triggers poll on their own interval and fire only on change.
  const { startUrlWatchers, registerBuiltInConnectors } = await import("./server/urlWatch.js");
  registerBuiltInConnectors();
  const stopUrlWatchers = startUrlWatchers({ run: scheduledRunObj });

  const stopScheduler = startScheduler({ runScheduled: scheduledRun });

  // MF11 messaging channels: Telegram/Email inbound -> agent thread task, reply -> channel.
  const stopChannelRouter = startChannelRouter({
    runAgentTurn: async ({ taskId, prompt, agentId }) => {
      const result = await runTask({ taskId, prompt, agentId, emit: () => {} });
      return result.text;
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
    stopChannelRouter();
    stopAllWatchers();
    stopServiceWatch();
    stopUrlWatchers();
    if (evalTimer) clearInterval(evalTimer);
    // D19: stop the sleep sweep (records survive in the store; the sweep is
    // only a timer, and it must not fire during shutdown).
    sessionRuntime.close();
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
