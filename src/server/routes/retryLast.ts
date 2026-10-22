import http from "node:http";
import { getTask } from "../db.js";
import { executionQueue } from "../executionQueue.js";

/**
 * Re-run the last user turn of a task (option #12). The UI's Retry button on
 * the last assistant message lands here; the server re-issues the newest user
 * message as a fresh turn in the same task through the shared runTask engine
 * (exposed on globalThis by src/index.ts because routes cannot receive deps).
 */

type RunTaskFn = (opts: {
  prompt: string;
  emit: (event: unknown) => void;
  taskId?: string;
  model?: string;
  mode?: string;
  agentId?: string;
  effort?: string;
  projectId?: string | null;
}) => Promise<{ taskId: string; text: string }>;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function runTaskRef(): RunTaskFn | undefined {
  return (globalThis as { __loamRunTask?: RunTaskFn }).__loamRunTask;
}

/** Find the newest user turn; this is what a retry re-runs. */
export function lastUserMessage(task: { messages?: Array<{ role: string; content: string }> }): { role: string; content: string } | undefined {
  return [...(task.messages ?? [])].reverse().find((m) => m.role === "user");
}

export async function handleRetryLastRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  _ctx?: Record<string, unknown>,
): Promise<boolean> {
  const match = /^\/api\/tasks\/([^/]+)\/retry-last$/.exec(p);
  if (!match || req.method !== "POST") return false;
  const id = decodeURIComponent(match[1]!);
  const task = getTask(id);
  if (!task) return (sendJson(res, 404, { error: "task not found" }), true);
  if (executionQueue.has(id) || task.status === "queued" || task.status === "running") {
    return (sendJson(res, 409, { error: "task is already running" }), true);
  }
  const last = lastUserMessage(task);
  if (!last || !last.content.trim()) {
    return (sendJson(res, 409, { error: "no user message to retry" }), true);
  }
  const runTask = runTaskRef();
  if (!runTask) return (sendJson(res, 503, { error: "run engine is not ready" }), true);
  void runTask({
    taskId: id,
    prompt: last.content,
    ...(task.model ? { model: task.model } : {}),
    ...(task.mode ? { mode: task.mode } : {}),
    ...(task.agentId ? { agentId: task.agentId } : {}),
    emit: () => {},
  }).catch(() => {});
  sendJson(res, 202, { taskId: id, status: getTask(id)?.status ?? "queued", retriedPrompt: last.content });
  return true;
}
