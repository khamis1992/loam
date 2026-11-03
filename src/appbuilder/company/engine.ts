import { randomUUID } from "node:crypto";
import path from "node:path";
import type { RunTaskOptions } from "../../server/http.js";
import type { OllamaClient } from "../../ollama.js";
import { collectFiles, zipBuffer } from "../../preview/zip.js";
import { VersionService, zeroUsage } from "../versions.js";
import { getAppProject, updateAppProject } from "../projects.js";
import type { AppProject } from "../types.js";
import { VerifyLoop, formatVerifyReportForModel, type VerifyDeps } from "../verifyLoop.js";
import { DevServerManager } from "../devServer.js";
import { analyzeProductIdea, buildPrompt, writeProductDocuments } from "./brief.js";
import { getCompanyRun, insertCompanyRun, listCompanyRuns, updateCompanyRun, versionRows } from "./store.js";
import type { CompanyRun } from "./types.js";

export interface CompanyEngineDeps {
  runTask(opts: RunTaskOptions): Promise<{ taskId: string; text: string }>;
  verify?: VerifyDeps;
  versions?: VersionService;
  devServer?: DevServerManager;
  ollama?: OllamaClient;
  model?: string;
}

interface ActiveRun {
  projectId: string;
  controller: AbortController;
}

const ACTIVE_STAGES = new Set(["design", "build", "verify", "repair", "version"]);

export class CompanyEngine {
  private readonly active = new Map<string, ActiveRun>();
  private readonly starting = new Set<string>();
  private readonly versions: VersionService;

  constructor(private readonly deps: CompanyEngineDeps) {
    this.versions = deps.versions ?? new VersionService(versionRows);
  }

  get(id: string): CompanyRun {
    const run = getCompanyRun(id);
    if (!run) throw new Error("company run not found");
    return run;
  }

  async start(project: AppProject, idea: string, autoStart = true): Promise<CompanyRun> {
    if (idea.trim().length < 4) throw new Error("idea is required");
    this.assertNoActiveRun(project.id);
    this.starting.add(project.id);
    try {
      const brief = await analyzeProductIdea(idea, this.deps.ollama, this.deps.model);
      project = updateAppProject(project.id, {
        description: brief.idea.slice(0, 400),
        features: [...new Set([...project.features, ...brief.features])],
      });
      const now = new Date().toISOString();
      const run: CompanyRun = {
        id: `cr_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        projectId: project.id,
        idea: idea.trim(),
        stage: autoStart && !brief.questions.length ? "design" : "awaiting_approval",
        brief,
        verifyReportId: null,
        versionNumber: null,
        previewUrl: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      };
      insertCompanyRun(run);
      if (autoStart && !brief.questions.length) return this.launch(project, run.id);
      return run;
    } finally {
      this.starting.delete(project.id);
    }
  }

  async approve(project: AppProject, runId: string): Promise<CompanyRun> {
    const run = this.get(runId);
    if (run.stage !== "awaiting_approval") throw new Error("run is not awaiting approval");
    return this.launch(project, runId);
  }

  async retry(project: AppProject, runId: string): Promise<CompanyRun> {
    const run = this.get(runId);
    if (run.stage !== "failed") throw new Error("only failed runs can be retried");
    return this.launch(project, runId);
  }

  async cancel(project: AppProject, runId: string): Promise<CompanyRun> {
    this.active.get(runId)?.controller.abort();
    this.deps.devServer?.stop(project.id);
    return updateCompanyRun(runId, { stage: "cancelled", error: null });
  }

  export(runId: string): Buffer {
    const run = this.get(runId);
    if (run.stage !== "done" || !run.versionNumber) throw new Error("a verified version is required before export");
    const project = this.project(run.projectId);
    const root = path.join(project.workspaceDir, project.appDir);
    return zipBuffer(collectFiles(root, { filter: (rel) => !rel.startsWith("node_modules/") && !rel.startsWith("data/") && !rel.startsWith(".env") && !rel.startsWith("dist/") }));
  }

  private launch(project: AppProject, runId: string): CompanyRun {
    this.assertNoActiveRun(project.id, runId);
    const controller = new AbortController();
    this.active.set(runId, { projectId: project.id, controller });
    const run = updateCompanyRun(runId, { stage: "design", error: null });
    void this.execute(project, runId, controller.signal).finally(() => {
      if (this.active.get(runId)?.controller === controller) this.active.delete(runId);
    });
    return run;
  }

  private assertNoActiveRun(projectId: string, currentRunId?: string): void {
    const active = !currentRunId && this.starting.has(projectId);
    const running = [...this.active.values()].some((entry) => entry.projectId === projectId && !entry.controller.signal.aborted);
    const persisted = listCompanyRuns(projectId).some((run) => run.id !== currentRunId && ACTIVE_STAGES.has(run.stage));
    if (active || running || persisted) throw new Error("a company run is already active for this project");
  }

  private async execute(project: AppProject, runId: string, signal: AbortSignal): Promise<void> {
    try {
      const run = this.get(runId);
      writeProductDocuments(project.workspaceDir, run.brief);
      updateCompanyRun(runId, { stage: "build" });
      await this.deps.runTask({ taskId: project.taskId, prompt: buildPrompt(run.brief), mode: "build", emit: () => {} });
      if (!this.deps.verify) throw new Error("verification is unavailable");
      const verification = new VerifyLoop(this.deps.verify);
      updateCompanyRun(runId, { stage: "verify" });
      let report = await verification.run({ project, runId, signal });
      for (let repair = 0; !report.pass && repair < 2; repair++) {
        if (signal.aborted) throw new Error("cancelled");
        updateCompanyRun(runId, { stage: "repair" });
        await this.deps.runTask({ taskId: project.taskId, prompt: `Fix only the failures in this verification report. Do not bypass or weaken tests.\n${formatVerifyReportForModel(report)}`, mode: "build", emit: () => {} });
        updateCompanyRun(runId, { stage: "verify" });
        report = await verification.run({ project, runId, signal });
      }
      updateCompanyRun(runId, { verifyReportId: report.id });
      verification.endRun(runId);
      if (!report.pass) throw new Error(`verification failed: ${report.error ?? formatVerifyReportForModel(report)}`);
      if (signal.aborted) throw new Error("cancelled");
      updateCompanyRun(runId, { stage: "version" });
      const version = await this.versions.snapshot(project, {
        title: "Verified product",
        summary: "Built and verified from the approved product brief.",
        source: "build",
        verifyReportId: report.id,
        usage: zeroUsage(),
      });
      if (!version) throw new Error("version snapshot produced no changes");
      const previewUrl = this.deps.devServer ? await this.deps.devServer.ensure(project) : null;
      updateCompanyRun(runId, { stage: "done", versionNumber: version.number, previewUrl });
    } catch (error) {
      const cancelled = signal.aborted || (error instanceof Error && error.message === "cancelled");
      updateCompanyRun(runId, { stage: cancelled ? "cancelled" : "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }

  private project(id: string): AppProject {
    const project = getAppProject(id);
    if (!project) throw new Error("app project not found");
    return project;
  }
}
