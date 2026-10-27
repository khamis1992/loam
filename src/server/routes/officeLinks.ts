import http from "node:http";
import { requireTaskWorkspace } from "../taskWorkspace.js";
import { localOfficeIdentity, requireOfficeAccess, type OfficeIdentity } from "../../office/intelligence/authorization.js";
import { OfficeIntelligenceError, isRecord, type OfficeScope } from "../../office/intelligence/contracts.js";
import { readOfficeArtifact } from "../../office/intelligence/artifactIO.js";
import { applyOfficeLink, deleteOfficeLink, getOfficeLink, listOfficeLinks, previewOfficeLink, registerOfficeLink } from "../../office/intelligence/links.js";

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

export async function handleOfficeLinkRoutes(req: http.IncomingMessage, res: http.ServerResponse, p: string, ctx: { workspace: string; identity?: OfficeIdentity }): Promise<boolean> {
  if (!p.startsWith("/api/office/links")) return false;
  const identity = ctx.identity ?? localOfficeIdentity();
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  try {
    if (p === "/api/office/links" && req.method === "GET") {
      const access = scope(url);
      requireOfficeAccess(identity, access, "office:read");
      sendJson(res, 200, { links: listOfficeLinks(access) });
      return true;
    }
    if (p === "/api/office/links" && req.method === "POST") {
      const body = await readJson(req);
      const access = scope(url, body);
      requireOfficeAccess(identity, access, "office:write");
      const link = registerOfficeLink(body);
      await Promise.all([
        readOfficeArtifact(requireTaskWorkspace(link.source.taskId, ctx.workspace), link.source),
        readOfficeArtifact(requireTaskWorkspace(link.target.taskId, ctx.workspace), link.target),
      ]);
      sendJson(res, 201, { link });
      return true;
    }
    const match = /^\/api\/office\/links\/([^/]+)(?:\/(preview|apply))?$/.exec(p);
    if (match) {
      const link = getOfficeLink(decodeURIComponent(match[1]!));
      const action = match[2];
      requireOfficeAccess(identity, link.scope, action === "apply" ? "office:approve" : "office:read");
      const workspaces = {
        sourceWorkspace: requireTaskWorkspace(link.source.taskId, ctx.workspace),
        targetWorkspace: requireTaskWorkspace(link.target.taskId, ctx.workspace),
      };
      if (action === "preview" && req.method === "POST") {
        sendJson(res, 200, { preview: await previewOfficeLink(link.id, workspaces) });
        return true;
      }
      if (action === "apply" && req.method === "POST") {
        requireOfficeAccess(identity, link.scope, "office:write");
        sendJson(res, 200, await applyOfficeLink(link.id, workspaces));
        return true;
      }
      if (!action && req.method === "DELETE") {
        requireOfficeAccess(identity, link.scope, "office:write");
        deleteOfficeLink(link.id);
        sendJson(res, 200, { deleted: true });
        return true;
      }
      sendJson(res, 405, { error: "method not allowed" });
      return true;
    }
    sendJson(res, 404, { error: "Office link route not found" });
    return true;
  } catch (error) {
    if (error instanceof OfficeIntelligenceError) sendJson(res, error.status, { error: error.message, code: error.code });
    else sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    return true;
  }
}
