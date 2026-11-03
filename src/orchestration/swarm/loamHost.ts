/**
 * C11: the two Loam task calls the coding team needs, behind one small interface so the
 * service can be tested without Loam's task database. Same calls SwarmService makes
 * (createTask + ensureTaskWorkspace; setTaskStatus).
 */
import type { Config } from "../../config.js";
import { createTask, setTaskStatus, type TaskStatus } from "../../server/db.js";
import { ensureTaskWorkspace } from "../../server/taskWorkspace.js";

export interface SwarmHost {
  createRunWorkspace(goal: string): { taskId: string; workspace: string };
  /** Accepts the swarm's own statuses ("completed"/"failed" map to Loam's "done"/"error"). */
  setTaskStatus(taskId: string, status: string, error?: string): void;
}

const TASK_STATUS: Record<string, TaskStatus> = {
  queued: "queued",
  running: "running",
  completed: "done",
  failed: "error",
  interrupted: "interrupted",
  cancelled: "cancelled",
};

export function loamSwarmHost(cfg: Config): SwarmHost {
  return {
    createRunWorkspace(goal) {
      const task = createTask(goal, `فريق البرمجة: ${goal.slice(0, 55)}`);
      return { taskId: task.id, workspace: ensureTaskWorkspace(task.id, cfg.workspace ?? process.cwd()) };
    },
    setTaskStatus(taskId, status, error) {
      const mapped = TASK_STATUS[status] ?? "error";
      try {
        setTaskStatus(taskId, mapped, error ? { error } : undefined);
      } catch {
        /* a task-status write never breaks a run */
      }
    },
  };
}
