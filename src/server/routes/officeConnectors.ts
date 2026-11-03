import http from "node:http";
import { requireTaskWorkspace } from "../taskWorkspace.js";
import { localOfficeIdentity, requireOfficeAccess, type OfficeIdentity } from "../../office/intelligence/authorization.js";
import { OfficeIntelligenceError, isRecord, type OfficeScope } from "../../office/intelligence/contracts.js";
import { deleteOfficeConnector, getOfficeConnector, listOfficeConnectors, registerOfficeConnector, syncConnectorToSheet, syncOfficeConnector, testOfficeConnector } from "../../office/intelligence/connectors.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) { reject(new OfficeIntelligenceError("request body is too large", 413, "body_too_large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new OfficeIntelligenceError("invalid JSON body", 400, "invalid_json")); }
    });
    req.on("error", reject);
  });
}

function scope(url: URL, body?: unknown): OfficeScope {
  const value = isRecord(body) && isRecord(body.scope) ? body.scope : {};
  return {
    tenantId: String(url.searchParams.get("tenantId") ?? value.tenantId ?? "local"),
    ...(url.searchParams.get("projectId") || value.projectId ? { projectId: String(url.searchParams.get("projectId") ?? value.projectId) } : {}),
    ...(url.searchParams.get("matterId") || value.matterId ? { matterId: String(url.searchParams.get("matterId") ?? value.matterId) } : {}),
  };
}

export async function handleOfficeConnectorRoutes(req: http.IncomingMessage, res: http.ServerResponse, p: string, ctx: { workspace: string; identity?: OfficeIdentity }): Promise<boolean> {
  if (!p.startsWith("/api/office/connectors")) return false;
  const identity = ctx.identity ?? localOfficeIdentity();
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  try {
    if (p === "/api/office/connectors" && req.method === "GET") {
      const access = scope(url);
      requireOfficeAccess(identity, access, "office:read");
      sendJson(res, 200, { connectors: listOfficeConnectors(access) });
      return true;
    }
    if (p === "/api/office/connectors" && req.method === "POST") {
      const body = await readJson(req);
      requireOfficeAccess(identity, scope(url, body), "office:connector");
      sendJson(res, 201, { connector: registerOfficeConnector(body) });
      return true;
    }
    const match = /^\/api\/office\/connectors\/([^/]+)(?:\/(test|sync))?$/.exec(p);
    if (match) {
      const connector = getOfficeConnector(decodeURIComponent(match[1]!));
      requireOfficeAccess(identity, connector.scope, "office:connector");
      const action = match[2];
      const workspaces = connector.type === "sqlite" ? requireTaskWorkspace(String(url.searchParams.get("taskId") ?? ""), ctx.workspace) : ctx.workspace;
      if (action === "test" && req.method === "POST") {
        // webdav probes with PROPFIND instead of downloading the payload.
        sendJson(res, 200, await testOfficeConnector(connector.id, { workspace: workspaces }));
        return true;
      }
      if (action === "sync" && req.method === "POST") {
        const body = await readJson(req);
        if (!isRecord(body) || typeof body.taskId !== "string" || typeof body.path !== "string") throw new OfficeIntelligenceError("taskId and path are required", 422, "invalid_contract");
        const workspace = requireTaskWorkspace(body.taskId, ctx.workspace);
        const artifact = await syncConnectorToSheet(connector.id, { workspace, taskId: body.taskId, path: body.path });
        sendJson(res, 200, { artifact });
        return true;
      }
      if (!action && req.method === "DELETE") {
        deleteOfficeConnector(connector.id);
        sendJson(res, 200, { deleted: true });
        return true;
      }
      sendJson(res, 405, { error: "method not allowed" });
      return true;
    }
    sendJson(res, 404, { error: "Office connector route not found" });
    return true;
  } catch (error) {
    if (error instanceof OfficeIntelligenceError) sendJson(res, error.status, { error: error.message, code: error.code });
    else sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    return true;
  }
}
