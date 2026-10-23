import http from "node:http";
import { getAgent } from "../agents.js";
import { listSchedulesByAgent } from "../db.js";
import { DEFAULT_TIMEZONE } from "../scheduleTime.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/** Agent routines routes. Dispatched before generic /api/agents/:id handlers. */
export async function handleSchedulesRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  _ctx?: Record<string, unknown>,
): Promise<boolean> {
  if (!p.startsWith("/api/agents/")) return false;
  const match = /^\/api\/agents\/([^\/]+)\/schedules$/.exec(p);
  if (!match) return false;
  const agentId = decodeURIComponent(match[1]!);

  if (!getAgent(agentId)) {
    sendJson(res, 404, { error: "agent not found" });
    return true;
  }

  if (req.method === "GET") {
    const schedules = listSchedulesByAgent(agentId).map((s) => ({
      id: s.id,
      prompt: s.prompt,
      cron: s.cron ?? null,
      runAt: s.runAt ?? null,
      intervalSeconds: s.intervalSeconds,
      timezone: s.timezone ?? DEFAULT_TIMEZONE,
      nextRunAt: s.nextRunAt ?? null,
      lastRunAt: s.lastRunAt ?? null,
      lastStatus: s.lastStatus ?? null,
      attempts: s.attempts ?? 0,
      lastError: s.lastError ?? null,
      enabled: s.enabled,
      // D14: trigger metadata (never the webhook secret).
      trigger: s.trigger ?? "cron",
      githubEvents: s.githubEvents ?? null,
      projectId: s.projectId ?? null,
      playbook: s.playbook ?? null,
    }));
    sendJson(res, 200, { schedules });
    return true;
  }

  sendJson(res, 405, { error: "method not allowed" });
  return true;
}
