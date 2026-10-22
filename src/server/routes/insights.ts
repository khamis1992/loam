import http from "node:http";
import { getTask, type Task } from "../db.js";
import { readTelemetry } from "../../telemetry/store.js";
import { computeInsights, generateInsights, type InsightsInput, type TimedAgentEvent } from "../../agent/insights.js";
import type { AgentEvent } from "../../agent/events.js";

/**
 * Session insights (D18): GET /api/tasks/:id/insights turns a finished task's
 * recorded event log into metrics, an issue timeline, knowledge usage and an
 * improved prompt. The metrics/timeline are exact and model-free; when a model
 * is supplied in ctx the feedback and improved prompt are model-enriched.
 */

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/** Build the insights input from a persisted task. Exported for tests. */
export function insightsInputForTask(task: Task): InsightsInput {
  const events: TimedAgentEvent[] = (task.steps ?? [])
    .filter((s) => s && typeof s === "object" && s.data && typeof s.data === "object")
    .map((s) => ({ at: s.at, event: s.data as AgentEvent }));

  let usage: InsightsInput["usage"];
  let telemetrySteps: number | undefined;
  for (const rec of readTelemetry(5000)) {
    if (rec.taskId !== task.id) continue;
    usage = { promptTokens: rec.usage?.promptTokens ?? 0, completionTokens: rec.usage?.completionTokens ?? 0 };
    if (typeof rec.steps === "number") telemetrySteps = rec.steps;
  }

  return {
    taskId: task.id,
    prompt: task.prompt ?? "",
    status: task.status,
    ...(task.model ? { model: task.model } : {}),
    startedAt: task.createdAt,
    endedAt: task.updatedAt,
    events,
    messages: (task.messages ?? []).map((m) => ({ role: m.role, content: m.content })),
    ...(usage ? { usage } : {}),
    ...(telemetrySteps !== undefined ? { steps: telemetrySteps } : {}),
  };
}

export interface InsightsRouteCtx {
  ollama?: { chat(opts: { model: string; messages: Array<{ role: string; content: string }> }): Promise<{ content: string }> };
  model?: string;
}

export async function handleInsightsRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  ctx?: InsightsRouteCtx,
): Promise<boolean> {
  const match = /^\/api\/tasks\/([^/]+)\/insights$/.exec(p);
  if (!match) return false;
  if (req.method !== "GET") return (sendJson(res, 405, { error: "method not allowed" }), true);

  const id = decodeURIComponent(match[1]!);
  const task = getTask(id);
  if (!task) return (sendJson(res, 404, { error: "task not found" }), true);

  const insights = await generateInsights(insightsInputForTask(task), ctx ?? {});
  sendJson(res, 200, { insights });
  return true;
}
