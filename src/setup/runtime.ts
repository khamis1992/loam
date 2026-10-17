import { createLoamTools } from "../tools/loam.js";
import path from "node:path";
import type { Config } from "../config.js";
import { log } from "../log.js";
import { OllamaClient } from "../ollama.js";
import { ToolRegistry } from "../tools/registry.js";
import { disposeShellSessions, shellTools } from "../tools/shell.js";
import { fileTools } from "../tools/files.js";
import { attachmentTools } from "../tools/attachments.js";
import { symbolTools } from "../tools/symbols.js";
import { pentestTools } from "../tools/pentest.js";
import { mirofishTools } from "../tools/mirofish.js";
import { createSubagentTools } from "../tools/subagents.js";
import { webTools } from "../tools/web.js";
import { browserTools, closeBrowser } from "../tools/browser.js";
import { computerUseTools } from "../tools/computerUse.js";
import { initPty, disposePty, ptyStatus, ptyTools } from "../tools/pty.js";
import { registerMcpTools, type McpToolset } from "../tools/mcp.js";
import { OllamaEmbedder } from "../memory/embeddings.js";
import { MemoryStore } from "../memory/store.js";
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

export interface Runtime {
  cfg: Config;
  ollama: OllamaClient;
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
  const ollama = new OllamaClient(cfg.ollamaUrl);
  await initPty();
  log.info(`pty: ${ptyStatus()}`);

  const registry = new ToolRegistry();
  registry.registerAll([...fileTools, ...shellTools, ...ptyTools, ...webTools, ...browserTools, ...computerUseTools, ...attachmentTools(), ...symbolTools(), ...pentestTools(), ...mirofishTools()]);

  const embedder = new OllamaEmbedder(cfg.ollamaUrl, cfg.memory.model);
  const memory = cfg.memory.enabled
    ? new MemoryStore(cfg.memory.file, embedder, cfg.memory.model, cfg.memory.dedupeThreshold)
    : null;
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
  if (cfg.screen.enabled) registry.registerAll(createScreenTools(screenLive, cfg));
  const preview = new PreviewService();
  registry.registerAll(createPreviewTools(preview));
  registry.registerAll(createRorkTools(preview));
  registry.registerAll(createFrontierBridgeTools(preview));
  registry.registerAll(createSubagentTools(ollama, registry));

  const mcp = opts.mcp === false ? null : await registerMcpTools(registry, cfg.mcpServers, cfg.workspace);

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
      screenLive.stop();
      preview.stop();
      disposeShellSessions();
      disposePty();
      await closeBrowser();
      if (mcp) await mcp.close();
    },
  };
}
