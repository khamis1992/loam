/**
 * Event-driven routines (frontier section 16): file-watch triggers. A watcher on
 * a user-chosen folder fires the companion's routine when files change there —
 * debounced, cancellation-aware, and registered from the schedules store so it
 * survives restarts.
 */
import fs from "node:fs";
import path from "node:path";
import { listSchedules, markScheduleRun, deleteSchedule, addSchedule } from "./db.js";
import { log } from "../log.js";

export interface WatcherHandle {
  scheduleId: string;
  dir: string;
  close(): void;
}

const active = new Map<string, WatcherHandle>();
const DEBOUNCE_MS = 2_500;

export function watchSchedules(): Array<{ id: string; dir: string }> {
  return [...active.values()].map((w) => ({ id: w.scheduleId, dir: w.dir }));
}

export function startFileWatchers(run: (opts: { prompt: string; scheduleId: string; agentId?: string; workMode?: string }) => Promise<string>): void {
  for (const s of listSchedules()) {
    if (s.kind !== "file-watch" || !s.watchPath) continue;
    startWatcher(s.id, s.watchPath, s.prompt, s.agentId, s.workMode, run);
  }
}

export function startWatcher(scheduleId: string, dir: string, prompt: string, agentId: string | undefined, workMode: string | undefined, run: (opts: { prompt: string; scheduleId: string; agentId?: string; workMode?: string }) => Promise<string>): WatcherHandle | { error: string } {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return { error: `مسار المراقبة غير موجود أو ليس مجلدًا: ${dir}` };
  stopWatcher(scheduleId);
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  const fire = (reason: string): void => {
    if (closed) return;
    log.info(`file-watch ${scheduleId}: fired (${reason})`);
    void run({ prompt, scheduleId, agentId, ...(workMode ? { workMode } : {}) })
      .then((taskId) => markScheduleRun(scheduleId, taskId))
      .catch((err) => log.warn(`file-watch ${scheduleId} run failed: ${String(err)}`));
  };
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(abs, { recursive: true }, (_event, file) => {
      if (closed) return;
      const name = String(file ?? "");
      if (name.includes("node_modules") || name.split(path.sep).includes(".loam-tasks")) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fire(`تغيير: ${name}`), DEBOUNCE_MS);
    });
  } catch (err) {
    return { error: `تعذر مراقبة المجلد: ${err instanceof Error ? err.message : String(err)}` };
  }
  const handle: WatcherHandle = {
    scheduleId,
    dir: abs,
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher.close();
      active.delete(scheduleId);
    },
  };
  active.set(scheduleId, handle);
  return handle;
}

export function stopWatcher(scheduleId: string): void {
  active.get(scheduleId)?.close();
}

export function stopAllWatchers(): void {
  for (const w of [...active.values()]) w.close();
}

/** Create a watch routine end-to-end (API/tool entry). */
export function createWatchRoutine(input: { prompt: string; watchPath: string; agentId?: string; workMode?: string; run: (opts: { prompt: string; scheduleId: string; agentId?: string; workMode?: string }) => Promise<string> }): { scheduleId: string; dir: string } | { error: string } {
  const abs = path.resolve(input.watchPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return { error: `مسار المراقبة غير موجود أو ليس مجلدًا: ${input.watchPath}` };
  const s = addSchedule(input.prompt, 3600, input.agentId, input.workMode, "file-watch", abs);
  const started = startWatcher(s.id, abs, s.prompt, s.agentId, s.workMode, input.run);
  if ("error" in started) {
    deleteSchedule(s.id);
    return { error: started.error };
  }
  return { scheduleId: s.id, dir: abs };
}
