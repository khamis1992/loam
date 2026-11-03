import type { Config } from "../../config.js";
import type { OllamaClient } from "../../ollama.js";
import type { RunTaskOptions } from "../../server/http.js";
import { verifyApplication } from "../../agent/appVerification.js";
import { aiEnvFor } from "../localCloud.js";
import { DevServerManager } from "../devServer.js";
import type { VerifyDeps } from "../verifyLoop.js";
import type { VersionService } from "../versions.js";
import { CompanyEngine } from "./engine.js";

export interface CompanyRuntimeDeps {
  cfg: Config;
  ollama: OllamaClient;
  runTask(opts: RunTaskOptions): Promise<{ taskId: string; text: string }>;
  devServer?: DevServerManager;
  verify?: VerifyDeps;
  versions?: VersionService;
}

export interface CompanyRuntime {
  engine: CompanyEngine;
  devServer: DevServerManager;
}

export function createCompanyRuntime(deps: CompanyRuntimeDeps): CompanyRuntime {
  const devServer = deps.devServer ?? new DevServerManager({ onStatus: () => undefined, aiEnv: aiEnvFor });
  const engine = new CompanyEngine({
    runTask: deps.runTask,
    ollama: deps.ollama,
    model: deps.cfg.model,
    devServer,
    versions: deps.versions,
    verify: deps.verify ?? {
      ensureDevServer: (project) => devServer.ensure(project),
      reviewVisual: async (_project, shot) => ({ pass: shot.errors.length === 0, problems: shot.errors, parsed: true }),
      runContract: async (project, signal) => {
        const result = await verifyApplication({ cfg: { ...deps.cfg, workspace: project.workspaceDir }, ollama: deps.ollama, request: project.description || project.title, signal });
        return { pass: result.pass, reason: result.reason };
      },
    },
  });
  return { engine, devServer };
}
