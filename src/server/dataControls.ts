/**
 * Data controls (Settings › Data controls):
 *  - GET /api/data/export  → full JSON download of user data
 *  - POST /api/data/delete-all {confirm:"DELETE"} → wipe user records
 *
 * Deletion only touches existing store APIs (task/project/run entities,
 * agents.json, schedules, companion memory, personalization) — records live
 * exclusively inside the app data directory.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import {
  listTasks,
  listProjects,
  listSchedules,
  deleteProjectR,
  deleteSchedule,
  clearSavedRun,
} from "./db.js";
import { listAgents, deleteAgent } from "./agents.js";
import { removeEntity } from "./sqliteStore.js";
import { listMemory, forget, type MemoryEntry } from "./companionMemory.js";
import { savePersonalization } from "./personalization.js";
import { stopAllWatchers } from "./fileWatchers.js";

const APPLICATION = "Loam";
const TEAM_SCOPE = "team";

/** Companion memory scopes that currently hold entries. */
function memoryScopes(): string[] {
  try {
    return fs
      .readdirSync(path.join(DATA_DIR, "companion-memory"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length));
  } catch {
    return [];
  }
}

function entryMetadata(e: MemoryEntry): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    id: e.id,
    agentId: e.ownerAgentId ?? "",
    kind: e.kind,
    source: e.source,
    at: e.at,
    confidence: e.confidence,
  };
  if (e.taskId) meta.taskId = e.taskId;
  if (e.expiresAt) meta.expiresAt = e.expiresAt;
  if (e.supersededBy) meta.supersededBy = e.supersededBy;
  return meta;
}

export interface DataExportReport {
  application: string;
  apiVersion: number;
  exportedAt: string;
  counts: {
    tasks: number;
    projects: number;
    schedules: number;
    agents: number;
    memoryEntries: number;
  };
  tasks: unknown[];
  projects: unknown[];
  schedules: unknown[];
  agents: unknown[];
  /** Metadata only — entry text is intentionally excluded. */
  memory: Array<{ agentId: string; entries: Array<Record<string, unknown>> }>;
}

/** Export the user's data as a JSON document. */
export function exportAllData(now = new Date()): DataExportReport {
  const tasks = listTasks();
  const projects = listProjects();
  const schedules = listSchedules();
  const agents = listAgents(true);

  const scopes = memoryScopes().includes(TEAM_SCOPE) ? memoryScopes() : [...memoryScopes(), TEAM_SCOPE];
  const memory: DataExportReport["memory"] = [];
  let memoryEntries = 0;
  for (const scope of scopes) {
    const entries = listMemory(scope, { includeInactive: true });
    if (entries.length === 0) continue;
    memoryEntries += entries.length;
    memory.push({
      agentId: scope,
      entries: entries.map(entryMetadata),
    });
  }

  return {
    application: APPLICATION,
    apiVersion: 1,
    exportedAt: now.toISOString(),
    counts: {
      tasks: tasks.length,
      projects: projects.length,
      schedules: schedules.length,
      agents: agents.length,
      memoryEntries,
    },
    tasks,
    projects,
    schedules,
    agents,
    memory,
  };
}

export interface DeleteAllReport {
  deleted: {
    tasks: number;
    projects: number;
    schedules: number;
    agents: number;
    memoryEntries: number;
  };
}

/** Delete every user data record via existing store functions. */
export function deleteAllUserData(): DeleteAllReport {
  stopAllWatchers();

  let tasks = 0;
  for (const task of listTasks()) {
    // Runs (recovery prompts) live in a separate collection keyed by task id.
    clearSavedRun(task.id);
    if (removeEntity("tasks", task.id)) tasks++;
  }

  let projects = 0;
  for (const project of listProjects()) {
    if (deleteProjectR(project.id)) projects++;
  }

  let schedules = 0;
  for (const schedule of listSchedules()) {
    if (deleteSchedule(schedule.id)) schedules++;
  }

  let agents = 0;
  for (const agent of listAgents(true)) {
    if (deleteAgent(agent.id)) agents++;
  }

  let memoryEntries = 0;
  for (const scope of memoryScopes()) {
    for (const entry of listMemory(scope, { includeInactive: true })) {
      if (forget(scope, entry.id)) memoryEntries++;
    }
  }

  // Custom instructions are user data too; reset them rather than keeping stale text.
  savePersonalization({ aboutMe: "", howToRespond: "" });

  return { deleted: { tasks, projects, schedules, agents, memoryEntries } };
}

/** The delete-all endpoint requires the exact typed confirmation string. */
export function confirmIsDelete(body: { confirm?: unknown } | undefined): boolean {
  return body?.confirm === "DELETE";
}
