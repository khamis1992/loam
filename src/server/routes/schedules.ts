import http from "node:http";
import { getAgent } from "../agents.js";
import { addSchedule, listSchedulesByAgent, publicSchedule, updateSchedule, type AutomationTrigger } from "../db.js";
import { DEFAULT_TIMEZONE } from "../scheduleTime.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, maxBytes = 64_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
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
      until: s.until ?? null,
      missionId: s.missionId ?? null,
      instruction: s.instruction ?? null,
      round: s.round ?? null,
    }));
    sendJson(res, 200, { schedules });
    return true;
  }

  if (req.method === "POST") {
    try {
      const body = await readJson(req) as Record<string, unknown>;
      const prompt = typeof body.prompt === "string" && body.prompt.trim() ? body.prompt.trim() : "";
      if (!prompt) return sendJson(res, 400, { error: "prompt is required" }), true;
      const intervalSeconds = typeof body.intervalSeconds === "number" && Number.isFinite(body.intervalSeconds) ? body.intervalSeconds : 3600;
      const kind = body.kind === "file-watch" || body.kind === "service-watch" || body.kind === "url-watch" ? body.kind : "cron";
      const events = Array.isArray(body.githubEvents) ? body.githubEvents : Array.isArray(body.events) ? body.events : undefined;
      const schedule = addSchedule(
        prompt,
        intervalSeconds,
        agentId,
        typeof body.workMode === "string" ? body.workMode : undefined,
        kind,
        typeof body.watchPath === "string" ? body.watchPath : undefined,
        body.enabled !== false,
        {
          ...(typeof body.cron === "string" && body.cron.trim() ? { cron: body.cron.trim() } : {}),
          ...(typeof body.runAt === "string" && body.runAt.trim() ? { runAt: body.runAt.trim() } : {}),
          ...(typeof body.timezone === "string" && body.timezone.trim() ? { timezone: body.timezone.trim() } : {}),
          ...(typeof body.trigger === "string" ? { trigger: body.trigger as AutomationTrigger } : {}),
          ...(typeof body.webhookSecret === "string" && body.webhookSecret.trim() ? { webhookSecret: body.webhookSecret.trim() } : {}),
          ...(events ? { githubEvents: events as string[] } : {}),
          ...(typeof body.playbook === "string" && body.playbook.trim() ? { playbook: body.playbook.trim() } : {}),
        },
      );
      sendJson(res, 201, { schedule: publicSchedule(schedule) });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (req.method === "PUT") {
    const body = await readJson(req) as { id?: unknown; enabled?: unknown; prompt?: unknown };
    if (typeof body.id !== "string" || !body.id.trim()) return sendJson(res, 400, { error: "schedule id is required" }), true;
    const owned = listSchedulesByAgent(agentId).find((schedule) => schedule.id === body.id);
    if (!owned) return sendJson(res, 404, { error: "schedule not found" }), true;
    const schedule = updateSchedule(body.id, {
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
      ...(typeof body.prompt === "string" ? { prompt: body.prompt } : {}),
    });
    sendJson(res, 200, { schedule: schedule ? publicSchedule(schedule) : null });
    return true;
  }

  sendJson(res, 405, { error: "method not allowed" });
  return true;
}
