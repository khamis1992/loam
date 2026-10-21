import http from "node:http";
import { getAgent } from "../agents.js";
import { listSchedulesByAgent, getSchedule, listSchedules } from "../db.js";
import { createUrlWatch, deleteUrlWatch } from "../urlWatch.js";
import { MIN_URL_WATCH_INTERVAL_SECONDS } from "../urlWatch.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => { data += chunk.toString("utf8"); if (data.length > 100_000) { reject(new Error("body too large")); req.destroy(); } });
    req.on("end", () => { try { const parsed: unknown = data.trim() ? JSON.parse(data) : {}; resolve(parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {}); } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); } });
    req.on("error", reject);
  });
}

/** Watch row shape for the UI (MF7). */
export function watchRow(s: NonNullable<ReturnType<typeof getSchedule>>): Record<string, unknown> {
  return {
    id: s.id,
    url: s.watchPath ?? "",
    intervalMinutes: Math.round(s.intervalSeconds / 60),
    intervalSeconds: s.intervalSeconds,
    selector: s.watchSelector ?? null,
    prompt: s.prompt,
    enabled: s.enabled,
    agentId: s.agentId ?? null,
    lastCheckedAt: s.lastWatchCheckedAt ?? null,
    lastChangedAt: s.lastWatchChangedAt ?? null,
    lastHash: s.lastWatchHash ?? null,
    snippet: s.lastWatchSnippet ?? null,
    lastTaskId: s.lastTaskId ?? null,
  };
}

/** MF7 url-watch routes. Dispatched before generic /api/agents/:id handlers.
 *  GET    /api/agents/:id/watches
 *  POST   /api/agents/:id/watches  {url, intervalMinutes?, selector?, prompt}
 *  DELETE /api/watches/:id
 */
export async function handleWatchesRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  _ctx?: Record<string, unknown>,
): Promise<boolean> {
  const agentMatch = /^\/api\/agents\/([^\/]+)\/watches$/.exec(p);
  if (agentMatch) {
    const agentId = decodeURIComponent(agentMatch[1]!);
    if (!getAgent(agentId)) {
      sendJson(res, 404, { error: "agent not found" });
      return true;
    }

    if (req.method === "GET") {
      const watches = listSchedulesByAgent(agentId)
        .filter((s) => s.kind === "url-watch")
        .map(watchRow);
      sendJson(res, 200, { watches });
      return true;
    }

    if (req.method === "POST") {
      let body: Record<string, unknown>;
      try {
        body = await readBody(req);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        return true;
      }
      const url = typeof body.url === "string" ? body.url.trim() : "";
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      if (!url || !prompt) {
        sendJson(res, 400, { error: "url and prompt are required" });
        return true;
      }
      const rawInterval = Number(body.intervalMinutes);
      const intervalMinutes = Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : MIN_URL_WATCH_INTERVAL_SECONDS / 60;
      const created = createUrlWatch({
        url,
        intervalSeconds: Math.round(intervalMinutes * 60),
        ...(typeof body.selector === "string" && body.selector.trim() ? { selector: body.selector.trim() } : {}),
        prompt,
        agentId,
      });
      if ("error" in created) {
        sendJson(res, 400, { error: created.error });
        return true;
      }
      const schedule = getSchedule(created.scheduleId);
      sendJson(res, 201, { watch: schedule ? watchRow(schedule) : { ...created, selector: null } });
      return true;
    }

    sendJson(res, 405, { error: "method not allowed" });
    return true;
  }

  const deleteMatch = /^\/api\/watches\/([^\/]+)$/.exec(p);
  if (deleteMatch && req.method === "DELETE") {
    const id = decodeURIComponent(deleteMatch[1]!);
    const s = listSchedules().find((x) => x.id === id && x.kind === "url-watch");
    if (!s) {
      sendJson(res, 404, { error: "watch not found" });
      return true;
    }
    const ok = deleteUrlWatch(id);
    sendJson(res, 200, { ok });
    return true;
  }

  return false;
}
