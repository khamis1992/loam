// src/appbuilder/runtime.ts — W3-c: the live App Builder runtime bound to the
// Loam server (engine + race engine + verify loop + dev server over the shared
// version service). The routes resolve it through appRuntime(); tests replace
// it with setAppRuntime() so every contract runs on fixtures, never a live
// model (the real-cloud-model run is a separate, user-keyed gate).
import fs from "node:fs";
import path from "node:path";
import { loadConfig, type Config } from "../config.js";
import { OllamaClient } from "../ollama.js";
import { ToolRegistry, type Tool } from "../tools/registry.js";
import { AppRunEngine, createModelVersionNamer, createRunAgentRoleRunner, scaffoldProject, type AppEngineDeps, type RoleTurnRunner } from "./engine.js";
import { RaceEngine, createModelCoverage, createRaceBranchRunner, type RaceDeps } from "./race.js";
import { VerifyLoop } from "./verifyLoop.js";
import { DevServerManager } from "./devServer.js";
import { versionService } from "./versions.js";
import { createAppBuilderTools } from "./tools.js";
import { isCloudModel, modelForStep } from "./stepRouting.js";
import { aiEnvFor, stripeEnvFor } from "./localCloud.js";
import { modelAbChain } from "../llm/router.js";
import { resolveTierModel } from "../server/modelTiers.js";
import { visualReview } from "../agent/visualReview.js";
import { verifyApplication } from "../agent/appVerification.js";
import { emitProjectEvent } from "./events.js";
import { VISUAL_REVIEW_SYSTEM } from "./prompts.js";
import { getAppProject } from "./projects.js";
import type { AppProject, DevServerStatus } from "./types.js";

export interface DevServerHandle {
  ensure(project: AppProject): Promise<string>;
  stop(projectId: string): void;
  stopApi(projectId: string): Promise<void>;
  status(projectId: string): DevServerStatus;
  logTail(projectId: string, lines?: number): string[];
}

export interface AppRuntime {
  engine: AppRunEngine;
  races: RaceEngine;
  versions: typeof versionService;
  devServer: DevServerHandle;
  /** The shared VerifyLoop (edit-session commits run a fast tier through it). */
  verify: import("./tools.js").VerifyRunner;
}

/** Builds the runtime over explicit cfg/ollama/registry (index.ts owns these). */
export function buildAppRuntime(opts: { cfg: Config; ollama: OllamaClient; baseTools: ToolRegistry }): AppRuntime {
  const { cfg, ollama } = opts;

  const manager = new DevServerManager({
    onStatus: (status) => emitProjectEvent(status.projectId, "appDevServer", { status }),
    // §4.10.4 + W4b BYOK: the user's own AI provider env and Stripe keys, resolved
    // server side straight into the app server's spawn env. Never logged, never
    // written into app code, never passed to the Vite process.
    aiEnv: (project) => ({ ...aiEnvFor(project), ...stripeEnvFor() }),
  });
  const devServer: DevServerHandle = {
    ensure: (project) => manager.ensure(project),
    stop: (projectId) => manager.stop(projectId),
    stopApi: (projectId) => manager.stopApi(projectId),
    status: (projectId) => manager.status(projectId),
    logTail: (projectId, lines) => manager.logTail(projectId, lines),
  };

  const verify = new VerifyLoop({
    ensureDevServer: (project) => devServer.ensure(project),
    reviewVisual: async (project, shot) => {
      // §4.6.5: one vision-class call with the screenshots and DESIGN.md; a
      // reply that does not parse (or a failed call) counts as pass.
      const design = fs.existsSync(path.join(project.workspaceDir, "DESIGN.md"))
        ? fs.readFileSync(path.join(project.workspaceDir, "DESIGN.md"), "utf8").slice(0, 6_000)
        : "(no DESIGN.md)";
      const images = shot.shots.map((s) => s.file).filter((p): p is string => Boolean(p)).map((p) => fs.readFileSync(p).toString("base64"));
      try {
        const model = cfg.vision.model || cfg.model;
        const { result } = await visualReview(ollama, {
          model,
          messages: [
            { role: "system", content: VISUAL_REVIEW_SYSTEM },
            { role: "user", content: `DESIGN.md:\n${design}`, ...(images.length ? { images } : {}) },
          ],
        });
        const text = result.content;
        const first = text.indexOf("{");
        const last = text.lastIndexOf("}");
        const parsed = first >= 0 && last > first ? JSON.parse(text.slice(first, last + 1)) as { pass?: unknown; problems?: unknown } : null;
        if (parsed && typeof parsed.pass === "boolean") {
          return { pass: parsed.pass, problems: Array.isArray(parsed.problems) ? parsed.problems.map(String).slice(0, 8) : [], parsed: true };
        }
        return { pass: true, problems: [], parsed: false };
      } catch {
        return { pass: true, problems: [], parsed: false };
      }
    },
    runContract: async (project, signal) => {
      try {
        const evidence = await verifyApplication({
          cfg: { ...cfg, workspace: project.workspaceDir },
          ollama,
          request: `Verify the app in ${path.join(project.workspaceDir, project.appDir)}`,
          ...(signal ? { signal } : {}),
        });
        return { pass: evidence.pass, reason: evidence.reason };
      } catch (err) {
        return { pass: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  const runner: RoleTurnRunner = createRunAgentRoleRunner({ cfg: () => cfg, ollama: () => ollama, baseTools: () => opts.baseTools });

  const engineDeps: AppEngineDeps = {
    pickModel: (project, role, step) => modelForStep(cfg, project, role, step), // throws NoCloudModelError
    runRoleTurn: runner,
    verify,
    versions: versionService,
    scaffold: (project) => scaffoldProject(project),
    stopAppServer: async (project) => {
      await devServer.stopApi(project.id);
    },
    nameVersion: createModelVersionNamer(runner),
  };
  const engine = new AppRunEngine(engineDeps);

  const raceDeps: RaceDeps = {
    // §4.13.2: modelAbChain filtered by isCloudModel.
    cloudModels: (count) => modelAbChain({ cfg, effort: "", outputType: "" }, count).filter((m) => isCloudModel(cfg, m)),
    runBranch: createRaceBranchRunner(runner, opts.baseTools.names()),
    coverage: createModelCoverage(runner),
    versions: versionService,
  };
  const races = new RaceEngine(raceDeps);

  return { engine, races, versions: versionService, devServer, verify };
}

const globalWithRegistry = globalThis as { __loamRegistry?: ToolRegistry | undefined };
let cachedOllama: OllamaClient | undefined;

/** The registry the engine runs tools on: the server's registry plus the app_* tools. */
export function appBuilderRegistry(base?: ToolRegistry): ToolRegistry {
  const registry = base ?? globalWithRegistry.__loamRegistry;
  if (registry) return registry.withTools(createAppBuilderTools() as Tool[]);
  // Standalone (tests/scripts before the server boots): a registry with just the app_* tools.
  const fresh = new ToolRegistry();
  fresh.registerAll(createAppBuilderTools() as Tool[]);
  return fresh;
}

let current: AppRuntime | undefined;

/** The live runtime; lazily bound to loadConfig() + the server registry bridge. */
export function appRuntime(): AppRuntime {
  if (current) return current;
  const cfg = loadConfig();
  cachedOllama ??= new OllamaClient(cfg.ollamaUrl, cfg.cloudModel);
  current = buildAppRuntime({ cfg, ollama: cachedOllama, baseTools: appBuilderRegistry() });
  return current;
}

/** Tests (and early server startup) replace the runtime wholesale. */
export function setAppRuntime(rt: AppRuntime | undefined): void {
  current = rt;
}

/** Convenience for routes: fresh project + runtime engine in one call. */
export function runtimeFor(projectId: string): { project: AppProject; rt: AppRuntime } | undefined {
  const project = getAppProject(projectId);
  if (!project) return undefined;
  return { project, rt: appRuntime() };
}

export { resolveTierModel };
