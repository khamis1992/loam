// src/appbuilder/projects.ts — Cap G core (MISSING §4.1.3): project lifecycle over
// the store + Loam task workspaces. Scaffolding stays in the run's scaffold phase,
// so an empty project costs nothing.
import fs from "node:fs";
import path from "node:path";
import { createTask } from "../server/db.js";
import { ensureTaskWorkspace, isManagedTaskWorkspace } from "../server/taskWorkspace.js";
import { deleteAppProjectRow, getAppProject, insertAppProject, listAppProjects, newAppProjectId, updateAppProjectRow } from "./store.js";
import type { AppProject, AppProjectSettings, AppRunFlavor, TemplateFeatureId } from "./types.js";

export const DEFAULT_PROJECT_SETTINGS: AppProjectSettings = {
  defaultTier: "auto",
  raceBranches: 2,
  verifyTier: "standard",
  devServerPort: null,
};

export interface CreateAppProjectInput {
  title: string;                 // trimmed, 1..80 chars
  description?: string;          // <= 400 chars
  features?: TemplateFeatureId[];
  defaultFlavor?: AppRunFlavor;  // default "quick"
  /** Loam base workspace; the project lives in a task workspace under it */
  baseWorkspace: string;
}

export function createAppProject(input: CreateAppProjectInput): AppProject {
  const title = input.title.trim();
  if (!title || title.length > 80) throw new Error("title must be 1-80 characters");
  const description = (input.description ?? "").slice(0, 400);
  const now = new Date().toISOString();
  const task = createTask(title, `بناء تطبيق: ${title}`);
  const workspaceDir = ensureTaskWorkspace(task.id, input.baseWorkspace);
  fs.mkdirSync(path.join(workspaceDir, "app"), { recursive: true });
  const project: AppProject = {
    id: newAppProjectId(),
    taskId: task.id,
    title,
    description,
    templateId: "web-app",
    features: input.features ?? [],
    workspaceDir,
    appDir: "app",
    defaultFlavor: input.defaultFlavor ?? "quick",
    status: "idle",
    activeVersion: null,
    settings: structuredClone(DEFAULT_PROJECT_SETTINGS),
    remixOfProjectId: null,
    remixOfVersion: null,
    depsMode: "shared",
    ai: { baseUrl: null, model: null, dailyTokenCap: null },
    createdAt: now,
    updatedAt: now,
  };
  insertAppProject(project);
  return project;
}

export { getAppProject, listAppProjects };

export function updateAppProject(id: string, patch: Parameters<typeof updateAppProjectRow>[1]): AppProject {
  const next = updateAppProjectRow(id, patch);
  if (!next) throw new Error(`app project ${id} not found`);
  return next;
}

export function setProjectStatus(id: string, status: AppProject["status"]): void {
  updateAppProjectRow(id, { status });
}

/** Deletes rows and, if removeFiles is true, the task workspace folder. Requires the UI to confirm twice. */
export function deleteAppProject(id: string, removeFiles: boolean): void {
  const project = getAppProject(id);
  if (!project) throw new Error(`app project ${id} not found`);
  if (removeFiles) {
    if (!isManagedTaskWorkspace(project.workspaceDir)) {
      throw new Error("refusing to delete a folder outside a managed task workspace");
    }
    fs.rmSync(project.workspaceDir, { recursive: true, force: true });
  }
  deleteAppProjectRow(id);
}
