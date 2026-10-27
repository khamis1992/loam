import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../../config.js";
import { log } from "../../log.js";
import { getSavedRun, getTask } from "../db.js";
import { executionQueue } from "../executionQueue.js";
import { requiresReplayConfirmation } from "../recovery.js";
import { requireTaskWorkspace } from "../taskWorkspace.js";

interface ResumeTaskOptions {
  taskId: string;
  prompt: string;
  resume: true;
  retryInterruptedStep: boolean;
  emit: () => void;
}

interface TaskResumeDeps {
  cfg: Config;
  readBody(req: http.IncomingMessage): Promise<unknown>;
  runTask(opts: ResumeTaskOptions): Promise<unknown>;
  sendJson(res: http.ServerResponse, status: number, body: unknown): void;
}

export async function handleTaskResumeRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  deps: TaskResumeDeps,
): Promise<boolean> {
  if (req.method !== "POST" || !p.startsWith("/api/tasks/") || !p.endsWith("/resume")) return false;
  const id = decodeURIComponent(p.slice("/api/tasks/".length, -"/resume".length));
  const task = getTask(id);
  const saved = getSavedRun(id);
  if (!task) return (deps.sendJson(res, 404, { error: "task not found" }), true);
  if (!saved || task.status === "done" || executionQueue.has(id)) {
    return (deps.sendJson(res, 409, { error: "task cannot be resumed" }), true);
  }
  const body = await deps.readBody(req) as { retryInterruptedStep?: boolean };
  if (requiresReplayConfirmation(saved) && body.retryInterruptedStep !== true) {
    return (deps.sendJson(res, 409, { error: "قد تكون الخطوة المتوقفة نفذت إجراءات بالفعل. يلزم تأكيد إعادة المحاولة.", requiresConfirmation: true }), true);
  }
  if (!fs.existsSync(saved.workspace)) return (deps.sendJson(res, 409, { error: "saved workspace is unavailable" }), true);
  if (path.resolve(saved.workspace).toLowerCase() !== path.resolve(requireTaskWorkspace(id, deps.cfg.workspace)).toLowerCase()) {
    return (deps.sendJson(res, 409, { error: "لا يمكن استئناف التنفيذ القديم في المساحة المشتركة. ابدأ تشغيلاً جديداً معزولاً." }), true);
  }
  void deps.runTask({ taskId: id, prompt: saved.prompt, resume: true, retryInterruptedStep: body.retryInterruptedStep === true, emit: () => {} })
    .catch((error) => log.warn(`resume ${id}: ${String(error)}`));
  deps.sendJson(res, 202, { taskId: id, status: getTask(id)?.status });
  return true;
}
