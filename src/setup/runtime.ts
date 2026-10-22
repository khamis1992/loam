import { createLoamTools } from "../tools/loam.js";
import { createLoamServiceTools } from "../tools/loamServices.js";
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
import { webTools } from "../tools/web.js";
import { browserTools, closeBrowser } from "../tools/browser.js";
import { computerUseTools } from "../tools/computerUse.js";
import { initPty, disposePty, ptyStatus, ptyTools } from "../tools/pty.js";
import { registerMcpTools, type McpToolset } from "../tools/mcp.js";
import { OllamaEmbedder } from "../memory/embeddings.js";
import { MemoryStore, startMemoryDreamJob } from "../memory/store.js";
import { createMemoryTools } from "../tools/memory.js";
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

import { createPhaseTools } from "../tools/phaseTools.js";
import { createFinishTools } from "../tools/finishTools.js";
import { createMultiEditTools } from "../tools/multiEdit.js";
import { createVaultTools } from "../tools/vaultTools.js";
import { createCodeSessionTools } from "../tools/codeSession.js";
import { createDocsLookupTools } from "../tools/docsLookup.js";
import { createSemanticSearchTools } from "../tools/semanticSearch.js";
import { createGenExtraTools } from "../tools/genExtra.js";
import { defaultGenProviders } from "../creative/genProviders.js";
import { createArtifactTools } from "../tools/artifactTools.js";
import { planTool, messageTool } from "../tools/specAliases.js";
import { createTodoTools } from "../tools/todoTools.js";

export interface Runtime {
  cfg: Config;
  ollama: OllamaClient | FailoverClient;
  registry: ToolRegistry;
  memory: MemoryStore | null;
  screenLive: ScreenLive;
  preview: PreviewService;
  mcpServers: string[];
  /** Direct handle on the running MCP servers (null when they are disabled). */
  mcp: McpToolset | null;
  dispose: () => Promise<void>;
}

export async function buildRuntime(cfg: Config, opts: { mcp?: boolean } = {}): Promise<Runtime> {
  const ollama = cfg.failover?.providers?.length ? new FailoverClient(cfg.failover.providers) : new OllamaClient(cfg.ollamaUrl, cfg.cloudModel);
  await initPty();
  log.info(`pty: ${ptyStatus()}`);

  const registry = new ToolRegistry();
  registry.registerAll([...fileTools, ...projectMemoryTools, ...shellTools, ...ptyTools, ...webTools, ...browserTools, ...computerUseTools, ...attachmentTools(), ...symbolTools(), ...searchTools(), ...pentestTools()]);
  registry.registerAll(createPhaseTools());
  registry.registerAll(createFinishTools());
  registry.registerAll(createMultiEditTools());
  registry.registerAll(createVaultTools());
  registry.registerAll(createArtifactTools());
  registry.registerAll([planTool(), messageTool()]);
  registry.registerAll(createTodoTools());
  // Repo wiki (D8): wiki_generate + ask_codebase. file_search is already registered above.
  registry.registerAll(createWikiTools(ollama, cfg.model, registry));
  registry.registerAll(mirofishTools().map(tool => ({ ...tool, integration: true })));

  const embedder = new OllamaEmbedder(cfg.ollamaUrl, cfg.memory.model);
  const memory = cfg.memory.enabled
    ? new MemoryStore(cfg.memory.file, embedder, cfg.memory.model, cfg.memory.dedupeThreshold)
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
  registry.registerAll(createSkillTools({ gate }));
  registry.registerAll(sessionTools);
  registry.registerAll(createLoamTools());
  registry.registerAll(createLoamServiceTools());
  registry.registerAll(createCreativeTools());
  registry.registerAll(createCreativeStudioTools());
  registry.registerAll(createOfficeTools());
  registry.registerAll(createMobileTools());
  if (cfg.screen.enabled) registry.registerAll(createScreenTools(screenLive, cfg));
  const preview = new PreviewService();
  registry.registerAll(createPreviewTools(preview));
  registry.registerAll(createRorkTools(preview).map(tool => ({ ...tool, integration: true })));
  registry.registerAll(createFrontierBridgeTools(preview).map(tool => ({ ...tool, integration: true })));
  registry.registerAll(createSubagentTools(ollama, registry));
  registry.registerAll(createGitWorkflowTools());

  registry.registerAll(createCodeSessionTools());
  registry.registerAll(createDocsLookupTools());
  // Semantic code search shares the memory embedder; without it the index still
  // answers via the BM25 fallback, so the tool is always registered.
  registry.registerAll(createSemanticSearchTools({
    embedder: cfg.memory.enabled && cfg.memory.model ? embedder : undefined,
    model: cfg.memory.model,
  }));
  // N12 generator tools: media/search providers from the environment plus the
  // runtime model as the reasoning backend for solve_logic / generate_storyboard.
  registry.registerAll(createGenExtraTools({ providers: defaultGenProviders(cfg), reasoner: ollama }));

  const mcp = opts.mcp === false ? null : await registerMcpTools(registry, cfg.mcpServers, cfg.workspace);
  registry.registerAll(createIntegrationTools(registry));

  return {
    cfg,
    ollama,
    registry,
    memory,
    screenLive,
    preview,
    mcpServers: mcp?.servers ?? [],
    mcp,
    dispose: async (): Promise<void> => {
      stopDream?.();
      screenLive.stop();
      preview.stop();
      disposeShellSessions();
      disposePty();
      await closeBrowser();
      if (mcp) await mcp.close();
    },
  };
}
