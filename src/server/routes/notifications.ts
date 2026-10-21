import http from "node:http";
import { unreadNotifications, listNotifications, markNotificationRead, markAllNotificationsRead, toApi } from "../notifications.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/**
 * Sidebar notification feed routes (option #20):
 *   GET  /api/notifications                    -> { notifications, unread }
 *   POST /api/notifications/read-all           -> { ok, unread }
 *   POST /api/notifications/:id/read           -> { ok, notification?, unread }
 */
export async function handleNotificationsRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  _ctx?: Record<string, unknown>,
): Promise<boolean> {
  if (!p.startsWith("/api/notifications")) return false;

  if (req.method === "GET" && p === "/api/notifications") {
    const unreadOnly = new URL(req.url ?? "", "http://localhost").searchParams.get("unread") === "1";
    const limitRaw = Number(new URL(req.url ?? "", "http://localhost").searchParams.get("limit") ?? 0);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 100;
    sendJson(res, 200, {
      notifications: listNotifications({ unreadOnly, limit }).map(toApi),
      unread: unreadNotifications(),
    });
    return true;
  }

  if (req.method === "POST" && p === "/api/notifications/read-all") {
    const count = markAllNotificationsRead();
    sendJson(res, 200, { ok: true, affected: count, unread: unreadNotifications() });
    return true;
  }

  const readMatch = /^\/api\/notifications\/([^/]+)\/read$/.exec(p);
  if (req.method === "POST" && readMatch) {
    const id = decodeURIComponent(readMatch[1]!);
    const updated = markNotificationRead(id);
    if (!updated) {
      sendJson(res, 404, { error: "notification not found" });
      return true;
    }
    sendJson(res, 200, { ok: true, notification: toApi(updated), unread: unreadNotifications() });
    return true;
  }

  return false;
}
