import crypto from "node:crypto";
import { database, transaction, putEntity as put, getEntity as get, allEntities as all, removeEntity as remove } from "./sqliteStore.js";
export { closeDb } from "./sqliteStore.js";
import type { SavedRun } from "./recovery.js";

export type TaskStatus = "queued" | "running" | "done" | "error" | "interrupted" | "cancelled";

export interface TaskMessage {
  role: "user" | "assistant" | "system";
  content: string;
  at: string;
}

export interface StepRecord {
  at: string;
  type: string;
  data?: unknown;
}

export interface Project {
  id: string;
  name: string;
  instruction?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  model?: string;
  workspace?: string;
  mode?: string;
  error?: string;
  projectId?: string | null;
  /** Owning agent (bot) for one-thread-per-agent continuity; null/undefined = base agent. */
  agentId?: string | null;
  /** Delegator agent id when this task was created by companion_delegate. */
  delegatedByAgentId?: string;
  createdAt: string;
  updatedAt: string;
  messages: TaskMessage[];
  steps: StepRecord[];
}

export interface Schedule {
  id: string;
  prompt: string;
  intervalSeconds: number;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt?: string;
  lastTaskId?: string;
  /** Frontier stage 4: routines belong to a companion (continuous mode). */
  agentId?: string;
  /** Where the routine executes: app workspace or the companion's own device. */
  workMode?: string;
  /** Frontier 16: event-driven routines. */
  kind?: "cron" | "file-watch" | "service-watch";
  watchPath?: string;
}


function editTask(id: string, edit: (task: Task) => void): void {
  transaction(() => { const task = getTask(id); if (!task) throw new Error("task not found"); edit(task); task.updatedAt = new Date().toISOString(); put("tasks", task); });
}
export function newId(prefix: string): string { return prefix + "_" + Date.now().toString(36) + crypto.randomBytes(6).toString("hex"); }
export function loadDb(): void { database(); }
/** Server boot only. Opening the database for a reader must not interrupt tasks. */
export function recoverInterruptedTasks(): number {
  return transaction(() => {
    let count = 0;
    for (const task of listTasks()) {
      if (task.status !== "running" && task.status !== "queued") continue;
      task.status = "interrupted";
      task.error = "Execution interrupted by application shutdown. Resume requires review.";
      task.updatedAt = new Date().toISOString();
      put("tasks", task); count++;
    }
    return count;
  });
}
export function createTask(prompt: string, title?: string, projectId?: string | null, agentId?: string | null): Task {
  const now = new Date().toISOString();
  const task: Task = { id: newId("task"), title: (title ?? prompt).slice(0, 80), prompt, status: "queued", projectId: projectId ?? null, agentId: agentId ?? null, createdAt: now, updatedAt: now, messages: [], steps: [] };
  put("tasks", task); return task;
}
export function setTaskDelegator(id: string, delegatedByAgentId: string): void { editTask(id, t => { t.delegatedByAgentId = delegatedByAgentId; }); }
export function getTask(id: string): Task | undefined { return get<Task>("tasks", id); }
export function setTaskMode(id: string, mode: string): void { editTask(id, t => { t.mode = mode; }); }
export function setTaskWorkspace(id: string, workspace: string): void { editTask(id, t => { if (t.workspace && t.workspace !== workspace) throw new Error("task workspace is immutable"); t.workspace = workspace; }); }
export function listTasks(projectId?: string | null): Task[] { return all<Task>("tasks").sort((a,b) => b.createdAt.localeCompare(a.createdAt)).filter((t) => projectId === undefined || (projectId === null ? !t.projectId : t.projectId === projectId)); }
export function setTaskProject(id: string, projectId: string | null): void { editTask(id, (t) => { t.projectId = projectId; }); }
export function appendStep(id: string, step: StepRecord): void { editTask(id, (t) => { t.steps.push(step); }); }
export function appendMessage(id: string, role: TaskMessage["role"], content: string): void { editTask(id, (t) => { t.messages.push({role, content, at: new Date().toISOString()}); }); }
export function setTaskAgent(id: string, agentId: string | null): void {
  editTask(id, (t) => { if (agentId) t.agentId = agentId; else delete t.agentId; });
}

export function setTaskStatus(id: string, status: TaskStatus, extra?: {model?: string; error?: string}): void {
  editTask(id, (t) => { t.status = status; if (["queued", "running", "done"].includes(status)) delete t.error; if (extra?.model) t.model = extra.model; if (extra?.error) t.error = extra.error; });
}
export function createProject(name: string, instruction?: string): Project {
  const now = new Date().toISOString(); const project: Project = { id: newId("proj"), name: name.slice(0,80), instruction, createdAt: now, updatedAt: now }; put("projects", project); return project;
}
export function getProject(id: string): Project | undefined { return get<Project>("projects", id); }
export function listProjects(): Project[] { return all<Project>("projects").sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)); }
export function updateProject(id: string, patch: {name?: string; instruction?: string}): Project | undefined {
  return transaction(() => { const p = getProject(id); if (!p) return; if (patch.name?.trim()) p.name = patch.name.trim().slice(0,80); if (typeof patch.instruction === "string") p.instruction = patch.instruction; p.updatedAt = new Date().toISOString(); put("projects",p); return p; });
}
export function deleteProjectR(id: string): boolean {
  return transaction(() => { const removed = remove("projects",id); for (const t of listTasks(id)) { t.projectId = null; put("tasks",t); } return removed; });
}
export function addSchedule(prompt: string, intervalSeconds: number, agentId?: string, workMode?: string, kind?: "cron" | "file-watch" | "service-watch", watchPath?: string, enabled = true): Schedule {
  const interval = Math.max(30, Math.floor(intervalSeconds));
  const s: Schedule = {id:newId("sched"),prompt,intervalSeconds:interval,enabled,nextRunAt:new Date(Date.now()+interval*1000).toISOString(),...(agentId?{agentId}:{}),...(workMode?{workMode}:{}),...(kind?{kind}:{}),...(watchPath?{watchPath}:{})}; put("schedules",s); return s;
}
export function setScheduleEnabled(id: string, enabled: boolean): boolean {
  return transaction(() => { const s = get<Schedule>("schedules", id); if (!s) return false; s.enabled = enabled; if (enabled && s.nextRunAt && Date.parse(s.nextRunAt) < Date.now()) s.nextRunAt = new Date(Date.now() + s.intervalSeconds * 1000).toISOString(); put("schedules", s); return true; });
}
/** Test helper: force a schedule's next run time (scheduler gates). */
export function setScheduleNextRunAt(id: string, at: string): boolean {
  return transaction(() => { const s = get<Schedule>("schedules", id); if (!s) return false; s.nextRunAt = at; put("schedules", s); return true; });
}
export function listSchedules(): Schedule[] { return all<Schedule>("schedules"); }
export function deleteSchedule(id: string): boolean { return remove("schedules",id); }
export function dueSchedules(now = new Date()): Schedule[] { return listSchedules().filter((s) => s.enabled && Date.parse(s.nextRunAt) <= now.getTime()); }
export function markScheduleRun(id: string, taskId: string): void {
  transaction(() => { const s=get<Schedule>("schedules",id); if (!s) return; s.lastRunAt=new Date().toISOString(); s.lastTaskId=taskId; s.nextRunAt=new Date(Date.now()+s.intervalSeconds*1000).toISOString(); put("schedules",s); });
}
export function saveRun(taskId: string, run: SavedRun): void { put("runs", { ...run, id: taskId }); }
export function getSavedRun(taskId: string): SavedRun | undefined { return get<SavedRun>("runs",taskId); }
export function clearSavedRun(taskId: string): void { remove("runs",taskId); }

export function queueTaskRun(taskId: string, run: SavedRun, resume: boolean, scheduleId?: string, title?: string): void {
  transaction(() => {
    const task = getTask(taskId);
    if (!task) throw new Error("task not found");
    task.status = "queued";
    if (!task.prompt && !resume) { task.prompt = run.prompt; task.title = (title?.trim() || run.prompt).slice(0, 80); }
    delete task.error;
    task.updatedAt = new Date().toISOString();
    if (!resume) task.messages.push({ role: "user", content: run.prompt, at: task.updatedAt });
    put("tasks", task);
    saveRun(taskId, run);
    if (scheduleId) {
      const schedule = get<Schedule>("schedules", scheduleId);
      if (schedule) {
        schedule.lastTaskId = taskId;
        schedule.lastRunAt = task.updatedAt;
        schedule.nextRunAt = new Date(Date.now() + schedule.intervalSeconds * 1000).toISOString();
        put("schedules", schedule);
      }
    }
  });
}
export function completeTaskRun(taskId: string, text: string, model: string): void {
  transaction(() => {
    const task = getTask(taskId);
    if (!task) throw new Error("task not found");
    task.status = "done";
    task.model = model;
    delete task.error;
    task.updatedAt = new Date().toISOString();
    task.messages.push({ role: "assistant", content: text, at: task.updatedAt });
    put("tasks", task);
    clearSavedRun(taskId);
  });
}
