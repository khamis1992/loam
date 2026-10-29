import { createLoamTools } from "../tools/loam.js";
import { createEnvSnapshotTools } from "../tools/envSnapshot.js";
import { createLoamServiceTools } from "../tools/loamServices.js";
import { createWakeupTools } from "../tools/wakeupTools.js";
import { createCreativeTools } from "../tools/creative.js";
import { createCreativeStudioTools } from "../tools/creativeStudio.js";
import { createOfficeTools } from "../tools/officeTools.js";
import { createMobileTools } from "../tools/mobile.js";
import path from "node:path";
import type { Config } from "../config.js";
import { log } from "../log.js";
import { OllamaClient } from "../ollama.js";
import { FailoverClient } from "../llm/failover.js";
import { ToolRegistry } from "../tools/registry.js";
import { disposeShellSessions, shellTools } from "../tools/shell.js";
import { fileTools } from "../tools/files.js";
import { projectMemoryTools } from "../tools/projectMemoryTools.js";
import { attachmentTools } from "../tools/attachments.js";
import { symbolTools } from "../tools/symbols.js";
import { searchTools } from "../tools/search.js";
import { createWikiTools } from "../tools/wiki.js";
import { pentestTools } from "../tools/pentest.js";
import { mirofishTools } from "../tools/mirofish.js";
import { createSubagentTools } from "../tools/subagents.js";
import { createFanoutTool } from "../tools/fanout.js";
import { createManagedSessionTools } from "../tools/managedSessionTools.js";
import { webTools } from "../tools/web.js";
import { browserTools, closeBrowser } from "../tools/browser.js";
import { computerUseTools } from "../tools/computerUse.js";
import { initPty, disposePty, ptyStatus, ptyTools } from "../tools/pty.js";
import { registerMcpTools, type McpToolset } from "../tools/mcp.js";
import { prepareApiAnything } from "../tools/apiAnything/server.js";
import { createApiAnythingLearnTools } from "../tools/apiAnything/learnTools.js";
import { OllamaEmbedder } from "../memory/embeddings.js";
import { MemoryStore, startMemoryDreamJob } from "../memory/store.js";
import { createMemoryTools, createRecallTools } from "../tools/memory.js";
import { recallIndex } from "../graph/recall.js";
import { createSkillTools } from "../tools/skills.js";
import { sessionTools } from "../tools/sessions.js";
import { createScreenTools } from "../tools/screen.js";
import { ScreenLive } from "../screen/live.js";
import { PreviewService } from "../preview/serve.js";
import { createPreviewTools } from "../tools/preview.js";
import { createRorkTools } from "../tools/rork.js";
import { createFrontierBridgeTools } from "../tools/frontierBridge.js";
import { writeGate } from "../server/pending.js";
import { createIntegrationTools } from "../tools/integrations.js";
import { createGitWorkflowTools } from "../tools/gitWorkflowTools.js";
import { createCiWatchTool } from "../tools/ciWatchTools.js";
import { createPrReviewTool } from "../tools/prReviewTools.js";
import { createVerifyAndRecordTool } from "../tools/verifyAndRecordTools.js";

import { createPhaseTools } from "../tools/phaseTools.js";
import { createFinishTools } from "../tools/finishTools.js";
import { createMultiEditTools } from "../tools/multiEdit.js";
import { createVaultTools } from "../tools/vaultTools.js";
import { createCodeSessionTools } from "../tools/codeSession.js";
import { createDocsLookupTools } from "../tools/docsLookup.js";
import { createSemanticSearchTools } from "../tools/semanticSearch.js";
import { createKnowledgeTools, createTaskFilesIngestTool, type KnowledgeToolOptions } from "../tools/knowledge.js";
import { createLegalTools } from "../tools/legalTools.js";
import { normalizeLegalConfig } from "../legal/config.js";
import { requestMattersKey, parentPortOf } from "../legal/keyHandoff.js";
import { createLegalRuntime, type LegalRuntime } from "../legal/runtime.js";
import { configureLegalProtection } from "../legal/security/protection.js";
import { fromFile } from "../knowledge/importers.js";
import { DATA_DIR } from "../config.js";
import { createGenExtraTools } from "../tools/genExtra.js";
import { defaultGenProviders } from "../creative/genProviders.js";
import { createArtifactTools } from "../tools/artifactTools.js";
import { planTool, messageTool } from "../tools/specAliases.js";
import { createTodoTools } from "../tools/todoTools.js";
import { createContextRecallTools } from "../tools/contextRecallTool.js";
import { createProjectWikiTools } from "../tools/wikiTools.js";
import { createAppBridgeTools } from "../tools/appBridgeTools.js";
import { createSecurityAuditTools } from "../tools/securityAuditTools.js";
import { createSecurityScanTools } from "../tools/securityScanTools.js";
import { createReTools } from "../tools/reTools.js";
import { createFuzzTools } from "../tools/fuzzTools.js";
import { createRemediateTools } from "../tools/remediateTools.js";
// devflow mode: the نتريو swarm agent tools (same /api/swarm/runs surface the UI uses).
import { createSwarmTools } from "../tools/serviceBridgeTools.js";
import { CodeGraphService } from "../codegraph/service.js";
import { createCodeGraphTools } from "../codegraph/tools.js";
import { setWorkspaceMutationObserver } from "../codegraph/mutations.js";
import { createUnboundCodemodeTool } from "../codemode/tool.js";
import { redTools } from "../tools/red.js";
import { createMobileSecurityTools } from "../tools/mobileSecurity.js";

export interface Runtime {
  cfg: Config;
  ollama: OllamaClient | FailoverClient;
  registry: ToolRegistry;
  memory: MemoryStore | null;
  /**
   * N3 Knowledge Garden: the Ollama embedder, or null when memory embeddings
   * are off. The garden shares it with the memory store and the semantic code
   * index, so all three vector channels live in the same space.
   */
  embedder: OllamaEmbedder | null;
  screenLive: ScreenLive;
  preview: PreviewService;
  mcpServers: string[];
  /** Direct handle on the running MCP servers (null when they are disabled). */
  mcp: McpToolset | null;
  /** Legal mode runtime (corpus + encrypted matters); null when cfg.legal.enabled is false. */
  legal: LegalRuntime | null;
  /**
   * N16 cross-run recall: the shelf of finished nodes from past runs, or null
   * when memory embeddings are off and no embedder is available.
   */
  recall: import("../graph/recall.js").RecallIndex | null;
  /** Code map service (graphify engine); null when codeGraph.enabled is false. */
  codeGraph: import("../codegraph/service.js").CodeGraphService | null;
  dispose: () => Promise<void>;
}

export async function buildRuntime(cfg: Config, opts: { mcp?: boolean } = {}): Promise<Runtime> {
  const ollama = cfg.failover?.providers?.length ? new FailoverClient(cfg.failover.providers) : new OllamaClient(cfg.ollamaUrl, cfg.cloudModel);
  await initPty();
  log.info(`pty: ${ptyStatus()}`);

  const registry = new ToolRegistry();
  registry.registerAll([...fileTools, ...projectMemoryTools, ...shellTools, ...ptyTools, ...webTools, ...browserTools, ...computerUseTools, ...attachmentTools(), ...symbolTools(), ...searchTools(), ...pentestTools(), ...redTools()]);
  registry.registerAll(createPhaseTools());
  registry.registerAll(createFinishTools());
  registry.registerAll(createMultiEditTools());
  registry.registerAll(createVaultTools());
  registry.registerAll(createArtifactTools());
  registry.registerAll([planTool(), messageTool()]);
  registry.registerAll(createTodoTools());
  registry.registerAll(createContextRecallTools());
  registry.registerAll(createProjectWikiTools());
  registry.registerAll(createAppBridgeTools({ gate: writeGate }));
  registry.registerAll(createSecurityAuditTools({ cfg, ollama, tools: registry }));
  registry.registerAll(createSecurityScanTools({ ollama }));
  registry.registerAll(createMobileSecurityTools());
  registry.registerAll(createReTools());
  registry.registerAll(createFuzzTools());
  registry.registerAll(createRemediateTools());
  // devflow: swarm_run/swarm_status call the local realswarm API; reachability is
  // still per-mode (only the devflow catalog entry lists them).
  registry.registerAll(createSwarmTools());

  // Code map: tools exist only when enabled, so disabled installs see no extra schemas.
  const codeGraph = cfg.codeGraph?.enabled ? new CodeGraphService(cfg.codeGraph) : null;
  if (codeGraph) {
    registry.registerAll(createCodeGraphTools(codeGraph));
    setWorkspaceMutationObserver((workspace) => codeGraph.indexer.markDirty(workspace));
  }
  // Codemode ships in every mode but stays inert until the user opts in: the
  // instance registered here is unbound, and index.ts swaps in a per-run
  // instance bound to that run's allowlisted registry before execution.
  registry.registerAll([createUnboundCodemodeTool()]);
  // Repo wiki (D8): wiki_generate + ask_codebase. file_search is already registered above.
  registry.registerAll(createWikiTools(ollama, cfg.model, registry));
  registry.registerAll(mirofishTools().map(tool => ({ ...tool, integration: true })));

  const embedder = new OllamaEmbedder(cfg.ollamaUrl, cfg.memory.model);
  // C9 memory ranking (default off, OD-7): recency + importance re-ranking
  // of cosine hits, enabled only by the orchestration switch.
  const mr = cfg.orchestration?.memoryRanking;
  const memory = cfg.memory.enabled
    ? new MemoryStore(
        cfg.memory.file, embedder, cfg.memory.model, cfg.memory.dedupeThreshold,
        ...(mr?.enabled
          ? [{ weights: { similarityWeight: mr.similarityWeight, recencyWeight: mr.recencyWeight, importanceWeight: mr.importanceWeight, recencyHalfLifeDays: mr.recencyHalfLifeDays }, candidateMultiplier: mr.candidateMultiplier }]
          : []),
      )
    : null;
  // Background consolidation ("dreaming"): merges duplicates and drops stale
  // unused entries while preserving user preferences. Idempotent; unref'd timer.
  const stopDream = memory
    ? startMemoryDreamJob(memory, { maxEntries: cfg.memory.maxEntries })
    : undefined;
  const screenLive = new ScreenLive({
    dir: path.join(cfg.workspace, ".screenshots"),
    fps: cfg.screen.fps,
    quality: cfg.screen.quality,
    maxWidth: cfg.screen.maxWidth,
  });
  // Always hand tools a WriteGate object; per-write gateActive() decides staging vs. direct apply.
  const gate = writeGate;
  if (memory) registry.registerAll(createMemoryTools(memory, { gate }));
  // N16 cross-run recall: the shelf shares the memory embedder, and without it
  // the shelf still answers lexically, so the tools are always registered and a
  // node is vectorized exactly when memory embeddings are on. Reachability is
  // decided by the run's tool allowlist (modes/catalog.ts), not by registration:
  // an unregistered tool can never reach a run at all.
  const recall = recallIndex({ embedder: cfg.memory.enabled && cfg.memory.model ? embedder : null });
  registry.registerAll(createRecallTools({ index: recall }));
  registry.registerAll(createSkillTools({ gate, ollama, projectRoot: cfg.workspace }));
  registry.registerAll(sessionTools);
  registry.registerAll(createLoamTools());
  registry.registerAll(createEnvSnapshotTools());
  registry.registerAll(createLoamServiceTools());
  registry.registerAll(createWakeupTools());
  registry.registerAll(createCreativeTools());
  registry.registerAll(createCreativeStudioTools());
  registry.registerAll(createOfficeTools());
  registry.registerAll(createMobileTools());
  if (cfg.screen.enabled) registry.registerAll(createScreenTools(screenLive, cfg));
  const preview = new PreviewService();
  registry.registerAll(createPreviewTools(preview, cfg));
  registry.registerAll(createRorkTools(preview).map(tool => ({ ...tool, integration: true })));
  // Phase-2 W2 «تحدث مع ملفاتك»: the garden's wiring (embedder/model) is
  // resolved once and shared by the kb_* tools, the bulk task_files_ingest and
  // the legacy rag_* redirectors, so every path ranks the same way.
  const knowledgeOptions: KnowledgeToolOptions = {
    embedder: cfg.memory.enabled && cfg.memory.model ? embedder : undefined,
    model: cfg.memory.model || cfg.model,
  };
  registry.registerAll(createFrontierBridgeTools(preview, knowledgeOptions).map(tool => ({ ...tool, integration: true })));
  registry.registerAll(createSubagentTools(ollama, registry));
  registry.register(createFanoutTool({ ollama, parentRegistry: registry }));
  registry.registerAll(createManagedSessionTools({ ollama, parentRegistry: registry }));
  registry.registerAll(createGitWorkflowTools());
  // D2: CI watch polls the same D1 PR provider's check-runs; the local provider
  // serves scripted results, so no network is required in tests.
  registry.register(createCiWatchTool());
  // D15: pr_review runs the same provider's diff through the model, one changed
  // file at a time, and returns deduplicated findings.
  registry.register(createPrReviewTool({ modelClient: ollama }));
  // D5: verify_and_record derives a test plan from the PR diff, runs it with
  // Playwright against a local static app and posts the checklist to the PR body.
  registry.register(createVerifyAndRecordTool());

  registry.registerAll(createCodeSessionTools());
  registry.registerAll(createDocsLookupTools());
  // Semantic code search shares the memory embedder; without it the index still
  // answers via the BM25 fallback, so the tool is always registered.
  registry.registerAll(createSemanticSearchTools({
    embedder: cfg.memory.enabled && cfg.memory.model ? embedder : undefined,
    model: cfg.memory.model,
  }));
  // N3 Knowledge Garden: user-built RAG store. The vector channel shares the
  // memory embedder; without it the garden still answers lexically, so the tools
  // are always registered and reachability is decided by the per-run toggle.
  // Phase-2 W2: task_files_ingest bulk-imports the task workspace through the
  // same garden (it rides the same gates as kb_*, see server/knowledgeTools.ts).
  registry.registerAll(createKnowledgeTools(knowledgeOptions));
  registry.register(createTaskFilesIngestTool(knowledgeOptions));
  // Legal mode (Qatar): opt-in. The corpus is public law; matters are encrypted with a
  // DPAPI-wrapped key handed over by Electron main (fail closed without it).
  const legalConfig = normalizeLegalConfig(cfg.legal);
  const legal = legalConfig.enabled
    ? createLegalRuntime({
        dataDir: DATA_DIR,
        config: legalConfig,
        ollamaUrl: cfg.ollamaUrl,
        ...(legalConfig.embedModel ? { embedder: new OllamaEmbedder(cfg.ollamaUrl, legalConfig.embedModel) } : {}),
        extractText: async (absPath: string) => (await fromFile(absPath)).text,
      })
    : null;
  if (legal) {
    configureLegalProtection({ seal: legal.seal, open: legal.open });
    registry.registerAll(createLegalTools(legal.toolDeps));
    if (!requestMattersKey(parentPortOf(process))) log.warn("legal: no Electron parent port; matters stay locked");
  }
  // N12 generator tools: media/search providers from the environment plus the
  // runtime model as the reasoning backend for solve_logic / generate_storyboard.
  registry.registerAll(createGenExtraTools({ providers: defaultGenProviders(cfg), reasoner: ollama }));

  // Cap H: prepareApiAnything overlays panel settings, protects Loam's api-anything
  // state, installs the tier resolver, and (when enabled + vendored) adds the
  // Loam-managed server with its policy hooks. Disabled by default until H4 passes.
  const apiAnything = prepareApiAnything(cfg, cfg.mcpServers);
  const mcp = opts.mcp === false ? null : await registerMcpTools(registry, apiAnything.servers, cfg.workspace, apiAnything.hooks);
  // Cap H §6.5: the nine api_* learn tools exist only while the Loam-managed
  // server is running; they register integration:true (per-task grant), the
  // policy envelope guards every call (§6.5 P3 acceptance 1).
  if (apiAnything.policy && cfg.apiAnything && mcp?.servers.includes("api-anything")) {
    registry.registerAll(createApiAnythingLearnTools(cfg.apiAnything, apiAnything.policy));
  }
  registry.registerAll(createIntegrationTools(registry));

  return {
    cfg,
    ollama,
    registry,
    legal,
    memory,
    embedder: cfg.memory.enabled && cfg.memory.model ? embedder : null,
    screenLive,
    preview,
    recall,
    mcpServers: mcp?.servers ?? [],
    codeGraph,
    mcp,
    dispose: async (): Promise<void> => {
      stopDream?.();
      screenLive.stop();
      preview.stop();
      disposeShellSessions();
      disposePty();
      await closeBrowser();
      if (mcp) await mcp.close();
      setWorkspaceMutationObserver(null);
      if (codeGraph) await codeGraph.dispose();
    },
  };
}
