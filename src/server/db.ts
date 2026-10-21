import crypto from "node:crypto";
import { database, transaction, putEntity as put, getEntity as get, allEntities as all, removeEntity as remove } from "./sqliteStore.js";
export { closeDb } from "./sqliteStore.js";
import type { SavedRun } from "./recovery.js";
import { initialNextRunAt, isValidTimezone, nextOccurrenceAfter, parseCron, DEFAULT_RETRY_DELAY_MS } from "./scheduleTime.js";
export { DEFAULT_TIMEZONE, DEFAULT_RETRY_DELAY_MS } from "./scheduleTime.js";
import { assertRunLease, expireAllRunLeases, type RunLease } from "./runLease.js";

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
  /** Absolute folder on the machine where Loam runs (option 17 context chips). */
  folder?: string;
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
  /** Frontier 16: event-driven routines. MF7 adds url-watch (scheduled fetch). */
  kind?: "cron" | "file-watch" | "service-watch" | "url-watch";
  watchPath?: string;
  /** MF7 url-watch: watchPath holds the watched URL; these carry extra state. */
  watchSelector?: string;
  watchConnector?: string;
  lastWatchHash?: string;
  lastWatchSnippet?: string;
  lastWatchCheckedAt?: string;
  lastWatchChangedAt?: string;
  /** MF2: 5-field cron expression evaluated in `timezone`. */
  cron?: string;
  /** MF2: one-shot ISO instant (offset-less strings read in `timezone`). */
  runAt?: string;
  /** MF2: IANA timezone for cron/at wall times (default Asia/Qatar). */
  timezone?: string;
  /** MF2: run attempts since the last success (retry policy: one retry). */
  attempts?: number;
  /** MF2: last run failure message. */
  lastError?: string;
  /** MF2: last run outcome; "retrying" means the single retry is pending. */
  lastStatus?: "ok" | "retrying" | "failed";
}

/** MF2: timing spec for a schedule (cron / one-shot at / recurring interval). */
export interface ScheduleSpec {
  cron?: string;
  runAt?: string;
  timezone?: string;
}


function editTask(id: string, edit: (task: Task) => void): void {
  transaction(() => { const task = getTask(id); if (!task) throw new Error("task not found"); edit(task); task.updatedAt = new Date().toISOString(); put("tasks", task); });
}
export function newId(prefix: string): string { return prefix + "_" + Date.now().toString(36) + crypto.randomBytes(6).toString("hex"); }
export function loadDb(): void { database(); }
/** Server boot only. Opening the database for a reader must not interrupt tasks. */
export function recoverInterruptedTasks(): number {
  const count = transaction(() => {
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
  expireAllRunLeases();
  return count;
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

export function setTaskStatus(id: string, status: TaskStatus, extra?: {model?: string; error?: string}, expectLease?: RunLease): void {
  editTask(id, (t) => { if (expectLease) assertRunLease(expectLease); t.status = status; if (["queued", "running", "done"].includes(status)) delete t.error; if (extra?.model) t.model = extra.model; if (extra?.error) t.error = extra.error; });
}
export function createProject(name: string, instruction?: string): Project {
  const now = new Date().toISOString(); const project: Project = { id: newId("proj"), name: name.slice(0,80), instruction, createdAt: now, updatedAt: now }; put("projects", project); return project;
}
export function getProject(id: string): Project | undefined { return get<Project>("projects", id); }
export function listProjects(): Project[] { return all<Project>("projects").sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)); }
export function updateProject(id: string, patch: {name?: string; instruction?: string; folder?: string}): Project | undefined {
  return transaction(() => { const p = getProject(id); if (!p) return; if (patch.name?.trim()) p.name = patch.name.trim().slice(0,80); if (typeof patch.instruction === "string") p.instruction = patch.instruction; if (typeof patch.folder === "string") { if (patch.folder.trim()) p.folder = patch.folder.trim(); else delete p.folder; } p.updatedAt = new Date().toISOString(); put("projects",p); return p; });
}
export function deleteProjectR(id: string): boolean {
  return transaction(() => { const removed = remove("projects",id); for (const t of listTasks(id)) { t.projectId = null; put("tasks",t); } return removed; });
}
export function addSchedule(prompt: string, intervalSeconds: number, agentId?: string, workMode?: string, kind?: "cron" | "file-watch" | "service-watch" | "url-watch", watchPath?: string, enabled = true, spec?: ScheduleSpec): Schedule {
  const interval = Math.max(30, Math.floor(intervalSeconds));
  // Reject invalid cron/timezone specs eagerly so a bad routine never persists.
  if (spec?.cron) parseCron(spec.cron);
  if (spec?.timezone?.trim() && !isValidTimezone(spec.timezone.trim())) throw new Error(`منطقة زمنية غير معروفة: ${spec.timezone}`);
  const timing = { intervalSeconds: interval, ...(spec?.cron ? { cron: spec.cron } : {}), ...(spec?.runAt && !spec?.cron ? { runAt: spec.runAt } : {}), ...(spec?.timezone?.trim() ? { timezone: spec.timezone.trim() } : {}) };
  const s: Schedule = {id:newId("sched"),prompt,intervalSeconds:interval,enabled,nextRunAt:initialNextRunAt(timing,new Date()),...(agentId?{agentId}:{}),...(workMode?{workMode}:{}),...(kind?{kind}:{}),...(watchPath?{watchPath}:{}),...(timing.cron?{cron:timing.cron}:{}),...(timing.runAt?{runAt:timing.runAt}:{}),...(timing.timezone?{timezone:timing.timezone}:{})}; put("schedules",s); return s;
}
export function setScheduleEnabled(id: string, enabled: boolean): boolean {
  return transaction(() => { const s = get<Schedule>("schedules", id); if (!s) return false; s.enabled = enabled; if (enabled && s.nextRunAt && Date.parse(s.nextRunAt) < Date.now()) s.nextRunAt = new Date(Date.now() + s.intervalSeconds * 1000).toISOString(); put("schedules", s); return true; });
}
/** Option 22: edit a routine's prompt and/or enabled state; re-arms nextRunAt when enabled. */
export function updateSchedule(id: string, patch: { prompt?: string; enabled?: boolean }): Schedule | undefined {
  return transaction(() => {
    const s = get<Schedule>("schedules", id);
    if (!s) return;
    if (typeof patch.prompt === "string" && patch.prompt.trim()) s.prompt = patch.prompt.trim();
    if (typeof patch.enabled === "boolean") s.enabled = patch.enabled;
    if (s.enabled && (!s.nextRunAt || Date.parse(s.nextRunAt) < Date.now())) s.nextRunAt = new Date(Date.now() + s.intervalSeconds * 1000).toISOString();
    put("schedules", s);
    return s;
  });
}
/** Test helper: force a schedule's next run time (scheduler gates). */
export function setScheduleNextRunAt(id: string, at: string): boolean {
  return transaction(() => { const s = get<Schedule>("schedules", id); if (!s) return false; s.nextRunAt = at; put("schedules", s); return true; });
}
export function listSchedules(): Schedule[] { return all<Schedule>("schedules"); }
export function getSchedule(id: string): Schedule | undefined { return get<Schedule>("schedules", id); }
/** MF2: schedules owned by one agent, soonest next run first. */
export function listSchedulesByAgent(agentId: string): Schedule[] { return listSchedules().filter((s) => s.agentId === agentId).sort((a, b) => (a.nextRunAt ?? "").localeCompare(b.nextRunAt ?? "")); }
export function deleteSchedule(id: string): boolean { return remove("schedules",id); }
/** MF7 url-watch: idempotent state patch (hash/snippet/checked/changed timestamps). */
export function updateUrlWatchState(
  id: string,
  patch: Partial<Pick<Schedule, "watchSelector" | "watchConnector" | "lastWatchHash" | "lastWatchSnippet" | "lastWatchCheckedAt" | "lastWatchChangedAt">>,
): Schedule | undefined {
  return transaction(() => {
    const s = get<Schedule>("schedules", id);
    if (!s) return undefined;
    Object.assign(s, patch);
    put("schedules", s);
    return s;
  });
}
export function dueSchedules(now = new Date()): Schedule[] { return listSchedules().filter((s) => s.enabled && Date.parse(s.nextRunAt) <= now.getTime()); }

export interface ScheduleOutcome {
  ok: boolean;
  taskId?: string;
  error?: string;
  /** Delay before the single retry of a failed run. */
  retryDelayMs?: number;
  now?: Date;
}

/**
 * MF2 retry policy: a failed run retries exactly once after a short delay,
 * then stops (recurring routines resume their normal cadence, spent one-shots
 * disable). Records attempt count and lastError/lastStatus either way.
 */
export function recordScheduleOutcome(id: string, outcome: ScheduleOutcome): Schedule | undefined {
  return transaction(() => {
    const s = get<Schedule>("schedules", id);
    if (!s) return undefined;
    const now = outcome.now ?? new Date();
    s.lastRunAt = now.toISOString();
    if (outcome.taskId) s.lastTaskId = outcome.taskId;
    const advance = (): string | null => nextOccurrenceAfter({ cron: s.cron, runAt: s.runAt, intervalSeconds: s.intervalSeconds, timezone: s.timezone }, now);
    if (outcome.ok) {
      s.attempts = 0;
      delete s.lastError;
      s.lastStatus = "ok";
      const next = advance();
      if (next) s.nextRunAt = next; else s.enabled = false; // spent one-shot
    } else {
      s.attempts = (s.attempts ?? 0) + 1;
      s.lastError = String(outcome.error ?? "run failed").slice(0, 500);
      if (s.attempts < 2) {
        s.lastStatus = "retrying";
        s.nextRunAt = new Date(now.getTime() + (outcome.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)).toISOString();
      } else {
        s.lastStatus = "failed";
        const next = advance();
        if (next) s.nextRunAt = next; else s.enabled = false; // failed one-shot stops
      }
    }
    put("schedules", s);
    return s;
  });
}
export function markScheduleRun(id: string, taskId: string): void {
  recordScheduleOutcome(id, { ok: true, taskId });
}
export function saveRun(taskId: string, run: SavedRun, expectLease?: RunLease): void {
  if (!expectLease) { put("runs", { ...run, id: taskId }); return; }
  transaction(() => { assertRunLease(expectLease); put("runs", { ...run, id: taskId }); });
}
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
        // MF2: cron-aware cadence. A one-shot keeps its (past) nextRunAt — the
        // in-flight gate protects the running task and the outcome disables it.
        schedule.nextRunAt = nextOccurrenceAfter({ cron: schedule.cron, runAt: schedule.runAt, intervalSeconds: schedule.intervalSeconds, timezone: schedule.timezone }, new Date()) ?? schedule.nextRunAt;
        put("schedules", schedule);
      }
    }
  });
}
export function completeTaskRun(taskId: string, text: string, model: string, expectLease?: RunLease): void {
  transaction(() => {
    if (expectLease) assertRunLease(expectLease);
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
