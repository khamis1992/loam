import http from "node:http";
import type { ToolRegistry } from "../../tools/registry.js";
import { getTask, appendMessage, createTask, setTaskMode } from "../db.js";
import { cancelRunSignal } from "../runControl.js";
import {
  buildSideChatTools,
  filterReadOnlyToolNames,
  SIDE_CHAT_READ_ONLY_TOOLS,
  MUTATING_TOOLS,
} from "../../agent/sideChat.js";

export { SIDE_CHAT_READ_ONLY_TOOLS, MUTATING_TOOLS };

/**
 * Session timeline UX controls (D16):
 *   POST /api/tasks/:id/btw     — read-only side-chat question ("/btw ...")
 *   POST /api/tasks/:id/pause   — pause the running agent
 *   POST /api/tasks/:id/resume  — take over: append a "user changed X" note and continue
 *
 * The run engine and tool registry are read through the same globalThis bridges
 * the other route modules use (src/index.ts sets them at startup), so this
 * module stays free of server deps.
 */

type RunTaskFn = (opts: {
  taskId?: string;
  prompt: string;
  mode?: string;
  projectId?: string | null;
  agentId?: string;
  sideChat?: boolean;
  resume?: boolean;
  retryInterruptedStep?: boolean;
  emit: (event: unknown) => void;
}) => Promise<{ taskId: string; text: string }>;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, maxBytes = 8_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
    req.on("error", reject);
  });
}

function runTaskRef(): RunTaskFn | undefined {
  return (globalThis as { __loamRunTask?: RunTaskFn }).__loamRunTask;
}

function registryRef(): ToolRegistry | undefined {
  return (globalThis as { __loamRegistry?: ToolRegistry }).__loamRegistry;
}

/** The read-only tool allowlist a side-chat run is restricted to. */
export function sideChatToolNames(): string[] {
  const registry = registryRef();
  const names = registry ? buildSideChatTools(registry).names() : [...SIDE_CHAT_READ_ONLY_TOOLS];
  return filterReadOnlyToolNames(names);
}

// ---- pause / take-over state ----
interface PauseState {
  note?: string;
  at: number;
}
const paused = new Map<string, PauseState>();

export function isSessionPaused(id: string): boolean {
  return paused.has(id);
}

export function getPauseState(id: string): PauseState | undefined {
  return paused.get(id);
}

export function pauseSession(id: string, note?: string): PauseState {
  const state: PauseState = { note, at: Date.now() };
  paused.set(id, state);
  return state;
}

export function resumeSession(id: string): PauseState | undefined {
  const state = paused.get(id);
  paused.delete(id);
  return state;
}

export async function handleSessionControlRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
): Promise<boolean> {
  const btw = /^\/api\/tasks\/([^/]+)\/btw$/.exec(p);
  if (btw && req.method === "POST") {
    const id = decodeURIComponent(btw[1]!);
    const main = getTask(id);
    if (!main) return (sendJson(res, 404, { error: "task not found" }), true);
    const body = (await readJson(req)) as { question?: unknown };
    const question = typeof body?.question === "string" ? body.question.trim() : "";
    if (!question) return (sendJson(res, 400, { error: "question is required" }), true);
    const runTask = runTaskRef();
    if (!runTask) return (sendJson(res, 503, { error: "run engine is not ready" }), true);
    // A side-chat question is its own read-only run so the main run keeps going.
    const task = createTask(question, question.slice(0, 80), main.projectId ?? null, main.agentId ?? null);
    setTaskMode(task.id, "ask");
    void runTask({ taskId: task.id, prompt: question, mode: "ask", sideChat: true, emit: () => {} }).catch(() => {});
    sendJson(res, 202, { taskId: task.id, sideChat: true, readOnlyTools: sideChatToolNames() });
    return true;
  }

  const pause = /^\/api\/tasks\/([^/]+)\/pause$/.exec(p);
  if (pause && req.method === "POST") {
    const id = decodeURIComponent(pause[1]!);
    const task = getTask(id);
    if (!task) return (sendJson(res, 404, { error: "task not found" }), true);
    if (task.status !== "running") return (sendJson(res, 409, { error: "task is not running" }), true);
    pauseSession(id);
    // Abort the in-flight agent; resume re-issues it with the user's note.
    cancelRunSignal(id);
    sendJson(res, 200, { taskId: id, paused: true, status: getTask(id)?.status ?? task.status });
    return true;
  }

  const resume = /^\/api\/tasks\/([^/]+)\/resume$/.exec(p);
  if (resume && req.method === "POST") {
    const id = decodeURIComponent(resume[1]!);
    const task = getTask(id);
    if (!task) return (sendJson(res, 404, { error: "task not found" }), true);
    const state = resumeSession(id);
    if (!state) return (sendJson(res, 409, { error: "task is not paused" }), true);
    const body = (await readJson(req)) as { note?: unknown };
    const raw = typeof body?.note === "string" ? body.note.trim() : "";
    const text = raw ? `user changed: ${raw}` : "user changed the task";
    appendMessage(id, "user", text);
    const runTask = runTaskRef();
    if (runTask) {
      void runTask({ taskId: id, prompt: text, resume: true, retryInterruptedStep: true, emit: () => {} }).catch(() => {});
    }
    sendJson(res, 200, { taskId: id, paused: false, note: text, status: getTask(id)?.status ?? task.status });
    return true;
  }

  return false;
}
