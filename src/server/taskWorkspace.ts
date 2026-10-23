import fs from "node:fs";
import path from "node:path";
import { getTask, setTaskWorkspace } from "./db.js";
import { isInside } from "../policy/paths.js";

/** Reject links at every existing component, including dangling links and junctions. */
export function taskPath(root: string, input = "."): string {
  const base = path.resolve(root);
  const target = path.resolve(base, input);
  if (!isInside(base, target)) throw new Error("path outside task workspace");
  let cursor = path.parse(target).root;
  for (const part of target.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("links are not allowed in task paths"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return target;
}

/** Legacy shared roots are never imported; their historical messages remain available. */
export function ensureTaskWorkspace(taskId: string, baseWorkspace: string): string {
  const task = getTask(taskId);
  if (!task) throw new Error("task not found");
  if (task.workspace) { taskPath(task.workspace); return task.workspace; }
  if (!/^task_[a-zA-Z0-9_-]+$/.test(taskId)) throw new Error("invalid task id");
  const root = taskPath(baseWorkspace, path.join(".loam-tasks", taskId));
  fs.mkdirSync(root, { recursive: true });
  setTaskWorkspace(taskId, root);
  return root;
}

export function requireTaskWorkspace(taskId: unknown, baseWorkspace: string): string {
  if (typeof taskId !== "string" || !taskId) throw new Error("taskId required");
  return ensureTaskWorkspace(taskId, baseWorkspace);
}

/** Directory name Loam owns for per-task workspaces. */
export const TASKS_DIR = ".loam-tasks";

/**
 * True only for a workspace Loam created itself (`.loam-tasks/<taskId>`).
 *
 * A task workspace can also be bound to a real folder the user chose (the
 * composer folder or a git worktree). Code that writes into a workspace on the
 * task's behalf must check this first: an empty user folder is still the user's
 * folder, and filling it with a snapshot would be a destructive surprise.
 */
export function isManagedTaskWorkspace(workspace: string): boolean {
  const resolved = path.resolve(workspace);
  return path.basename(path.dirname(resolved)) === TASKS_DIR;
}
