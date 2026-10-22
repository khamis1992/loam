/** Connector routes: list, connect (auth URL), OAuth callback, disconnect. */
import http from "node:http";
import { CONNECTORS, findConnector } from "../connectors/index.js";
import { isConfigured, isConnected, getAccount, buildAuthUrl, completeCallback, disconnect, callbackPage } from "../connectors/oauth.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/** Best-effort public base for the OAuth redirect, from proxy headers first. */
function baseUrl(req: http.IncomingMessage): string {
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(",")[0]!.trim();
  const proto = String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0]!.trim();
  if (!host) throw new Error("cannot determine server base URL");
  return `${proto || "http"}://${host}`;
}

export async function handleConnectorsRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  _ctx?: Record<string, unknown>,
): Promise<boolean> {
  if (!p.startsWith("/api/connectors")) return false;

  if (p === "/api/connectors" && req.method === "GET") {
    sendJson(res, 200, {
      connectors: CONNECTORS.map((c) => ({
        id: c.id,
        name: c.name,
        configured: isConfigured(c),
        connected: isConnected(c.id),
        account: isConnected(c.id) ? getAccount(c.id) : null,
        envVars: [c.oauth.envVars.clientId, c.oauth.envVars.clientSecret],
      })),
    });
    return true;
  }

  const match = /^\/api\/connectors\/([^\/]+)\/(connect|callback|disconnect)$/.exec(p);
  if (!match) {
    sendJson(res, 404, { error: "unknown connector route" });
    return true;
  }
  const id = decodeURIComponent(match[1]!);
  const action = match[2]!;
  const def = findConnector(id);
  if (!def) {
    sendJson(res, 404, { error: "connector not found" });
    return true;
  }

  if (action === "connect" && req.method === "POST") {
    if (!isConfigured(def)) {
      sendJson(res, 400, { error: "Not configured", envVars: [def.oauth.envVars.clientId, def.oauth.envVars.clientSecret] });
      return true;
    }
    try {
      const redirectUri = `${baseUrl(req)}/api/connectors/${def.id}/callback`;
      const { authUrl } = buildAuthUrl(def, redirectUri);
      sendJson(res, 200, { authUrl });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (action === "callback" && req.method === "GET") {
    try {
      const params = new URL(req.url ?? "", "http://localhost").searchParams;
      const { account } = await completeCallback(def.id, params);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(callbackPage(true, `${def.name} connected as ${account}`));
    } catch (err) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(callbackPage(false, err instanceof Error ? err.message : String(err)));
    }
    return true;
  }

  if (action === "disconnect" && req.method === "POST") {
    disconnect(def.id);
    sendJson(res, 200, { ok: true });
    return true;
  }

  sendJson(res, 405, { error: "method not allowed" });
  return true;
}
