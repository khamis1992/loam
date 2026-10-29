import type { Config } from "../config.js";
import type { OllamaClient } from "../ollama.js";
import type { PreviewService } from "../preview/serve.js";
import type { ToolRegistry } from "../tools/registry.js";
import { videoStudioRelay } from "../server/videoStudioRelay.js";
import { createScratchpadTools } from "../tools/scratchpadTools.js";
import { createEnvironmentIssueTools } from "../tools/environmentIssueTools.js";
import { createDeepResearchTools } from "../tools/deepResearch.js";
import { createBoardTools } from "../tools/boardTools.js";
import { createInstructionHistoryTools } from "../tools/instructionTools.js";
import { createAgentSpawnTools } from "../tools/agentSpawnTools.js";
import { createBrowserOperatorTools } from "../tools/browserOperator.js";
import { createWideResearchTool } from "../tools/wideResearch.js";
import { createFindAndEditTools } from "../tools/findAndEdit.js";
import { createGroupTools } from "../tools/groupTools.js";
import { createBackendScaffoldTools } from "../tools/backendScaffold.js";
import { createWebScaffoldTools } from "../tools/webScaffold.js";
import { createDesignStudioTools } from "../tools/designStudio.js";
import { createPlaybookTools } from "../tools/playbookTools.js";
import { createOfficeEditTools } from "../tools/officeEditAgent.js";
import { createOfficeWorkflowTools } from "../tools/officeWorkflow.js";
import { createOfficeIntelligenceTools } from "../tools/officeIntelligenceTools.js";
import { createServiceGapTools } from "../tools/serviceGapTools.js";
import { createVideoEditTools } from "../tools/videoEditAgent.js";
import { createVideoStudioTools } from "../tools/videoStudio.js";
import { createDeployTools } from "../tools/deploy.js";
import { createDesignExploreTools } from "../tools/designExplore.js";
import { createDesignLintTools } from "../tools/designLint.js";
import { createDesignAssetsTools } from "../tools/designAssets.js";
import { imageProviderFromConfig } from "../creative/imageProvider.js";
import { createDesignBriefTools } from "../tools/designBrief.js";
import { createDesignAutofixTools } from "../tools/designAutofix.js";
import { createUiExamplesTools } from "../tools/uiExamples.js";
import { createDesignCritiqueTools } from "../tools/designCritique.js";
import { createConnectorTools } from "../tools/connectorTools.js";
import { createWorkflowTools } from "../tools/workflow.js";
import { createPlanTools } from "../tools/planTools.js";
import { createAskUserTools } from "../tools/askUserTools.js";
import { createAppBuilderTools } from "../appbuilder/tools.js";

export function registerRuntimeTools(rt: {
  cfg: Config;
  ollama: OllamaClient;
  preview: PreviewService;
  registry: ToolRegistry;
}): void {
  const { cfg, ollama, preview, registry } = rt;
  registry.registerAll(createScratchpadTools());
  registry.registerAll(createEnvironmentIssueTools());
  registry.registerAll(createBoardTools());
  registry.registerAll(createInstructionHistoryTools());
  registry.registerAll(createAgentSpawnTools());
  registry.registerAll(createBrowserOperatorTools());
  registry.registerAll(createDeepResearchTools());
  registry.register(createWideResearchTool({ ollama, parentRegistry: registry }));
  registry.registerAll(createFindAndEditTools({ ollama }));
  registry.registerAll(createGroupTools());
  registry.registerAll(createBackendScaffoldTools());
  registry.registerAll(createWebScaffoldTools());
  registry.registerAll(createDesignStudioTools());
  registry.registerAll(createPlaybookTools({ ollama }));
  registry.registerAll(createOfficeEditTools());
  registry.registerAll(createOfficeWorkflowTools(cfg, ollama));
  registry.registerAll(createOfficeIntelligenceTools());
  registry.registerAll(createServiceGapTools());
  registry.registerAll(createVideoEditTools());
  registry.registerAll(createVideoStudioTools({ relay: videoStudioRelay }));
  registry.registerAll(createDeployTools({ workspace: cfg.workspace, preview }));
  registry.registerAll(createDesignExploreTools());
  registry.registerAll(createDesignLintTools());
  // W5: a configured BYOK image provider (cloudModel.images / LOAM_IMAGE_*) backs
  // design_image_generate; without one the tool keeps its local deterministic
  // generator. The provider is only wired when the network policy allows it.
  const imageGenerator = cfg.policy?.networkEnabled === false ? undefined : imageProviderFromConfig(cfg.cloudModel);
  registry.registerAll(createDesignAssetsTools({ generator: imageGenerator }));
  registry.registerAll(createDesignBriefTools({ ollama }));
  registry.registerAll(createDesignAutofixTools());
  registry.registerAll(createUiExamplesTools());
  registry.registerAll(createDesignCritiqueTools(preview, { ollama }));
  registry.registerAll(createConnectorTools());
  registry.registerAll(createWorkflowTools({ ollama, registry }));
  registry.registerAll(createPlanTools());
  registry.registerAll(createAskUserTools());
  // App Builder (MISSING §4.0/§4.1.4): the seven app_* tools sit in the Build
  // mode list; handlers refuse politely until a run engine attaches an App
  // project to the task (setActiveAppBuild in src/appbuilder/tools.ts).
  registry.registerAll(createAppBuilderTools());
}
