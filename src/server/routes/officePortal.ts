import http from "node:http";
import { getEntity } from "../sqliteStore.js";
import type { ClientPortalShare } from "../../office/intelligence/legal/portal.js";
import { localOfficeIdentity, requireOfficeAccess, type OfficeIdentity } from "../../office/intelligence/authorization.js";
import { OfficeIntelligenceError, isRecord } from "../../office/intelligence/contracts.js";
import { getMatter } from "../../office/intelligence/legal/matters.js";
import { createClientPortalShare, listClientPortalShares, readClientPortal, revokeClientPortalShare } from "../../office/intelligence/legal/portal.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new OfficeIntelligenceError("invalid JSON body", 400, "invalid_json")); }
    });
    req.on("error", reject);
  });
}

export async function handleOfficePortalRoutes(req: http.IncomingMessage, res: http.ServerResponse, p: string, ctx?: { identity?: OfficeIdentity }): Promise<boolean> {
  const publicMatch = /^\/api\/office\/portal\/([A-Za-z0-9_-]+)$/.exec(p);
  if (publicMatch && req.method === "GET") {
    try { sendJson(res, 200, { portal: readClientPortal(publicMatch[1]!) }); }
    catch (error) { sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) }); }
    return true;
  }
  if (publicMatch && req.method === "DELETE") {
    const identity = ctx?.identity ?? localOfficeIdentity();
    const token = publicMatch[1]!;
    const shares = listClientPortalSharesForAuthorization(token);
    requireOfficeAccess(identity, { tenantId: shares.tenantId, matterId: shares.matterId }, "office:share");
    revokeClientPortalShare(token);
    sendJson(res, 200, { revoked: true });
    return true;
  }
  const match = /^\/api\/office\/legal\/matters\/([^/]+)\/portal$/.exec(p);
  if (!match) return false;
  const identity = ctx?.identity ?? localOfficeIdentity();
  try {
    const matter = getMatter(decodeURIComponent(match[1]!));
    requireOfficeAccess(identity, { tenantId: matter.tenantId, ...(matter.projectId ? { projectId: matter.projectId } : {}), matterId: matter.id }, "office:share");
    if (req.method === "GET") {
      sendJson(res, 200, { shares: listClientPortalShares(matter.id) });
      return true;
    }
    if (req.method === "POST") {
      const body = await readJson(req);
      const expiresAt = isRecord(body) && typeof body.expiresAt === "string" ? body.expiresAt : undefined;
      sendJson(res, 201, { share: createClientPortalShare(matter.id, expiresAt) });
      return true;
    }
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  } catch (error) {
    if (error instanceof OfficeIntelligenceError) sendJson(res, error.status, { error: error.message, code: error.code });
    else sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    return true;
  }
}

function listClientPortalSharesForAuthorization(token: string): { tenantId: string; matterId: string } {
  const share = getEntity<ClientPortalShare>("office-client-portal-shares", token);
  if (!share) throw new OfficeIntelligenceError("portal share not found", 404, "portal_not_found");
  return { tenantId: share.tenantId, matterId: share.matterId };
}
