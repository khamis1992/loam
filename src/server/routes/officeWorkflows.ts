import http from "node:http";
import type { Config } from "../../config.js";
import type { OllamaClient } from "../../ollama.js";
import { localOfficeIdentity, requireOfficeAccess, type OfficeIdentity } from "../../office/intelligence/authorization.js";
import { OfficeIntelligenceError, isRecord, type OfficeScope } from "../../office/intelligence/contracts.js";
import { createOfficeModelGateway } from "../../office/intelligence/modelGateway.js";
import { deleteOfficeWorkflow, getOfficeWorkflow, listOfficeWorkflows, registerOfficeWorkflow, runOfficeWorkflow } from "../../office/intelligence/workflows.js";

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

function scope(url: URL, body?: unknown): OfficeScope {
  const value = isRecord(body) && isRecord(body.scope) ? body.scope : {};
  return {
    tenantId: String(url.searchParams.get("tenantId") ?? value.tenantId ?? "local"),
    ...(url.searchParams.get("projectId") || value.projectId ? { projectId: String(url.searchParams.get("projectId") ?? value.projectId) } : {}),
    ...(url.searchParams.get("matterId") || value.matterId ? { matterId: String(url.searchParams.get("matterId") ?? value.matterId) } : {}),
  };
}

export async function handleOfficeWorkflowRoutes(req: http.IncomingMessage, res: http.ServerResponse, p: string, ctx: { workspace: string; cfg: Config; ollama: OllamaClient; identity?: OfficeIdentity }): Promise<boolean> {
  if (!p.startsWith("/api/office/workflows")) return false;
  const identity = ctx.identity ?? localOfficeIdentity();
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  try {
    if (p === "/api/office/workflows" && req.method === "GET") {
      const access = scope(url);
      requireOfficeAccess(identity, access, "office:read");
      sendJson(res, 200, { workflows: listOfficeWorkflows(access) });
      return true;
    }
    if (p === "/api/office/workflows" && req.method === "POST") {
      const body = await readJson(req);
      requireOfficeAccess(identity, scope(url, body), "office:approve");
      sendJson(res, 201, { workflow: registerOfficeWorkflow(body) });
      return true;
    }
    const match = /^\/api\/office\/workflows\/([^/]+)(?:\/run)?$/.exec(p);
    if (match) {
      const workflow = getOfficeWorkflow(decodeURIComponent(match[1]!));
      if (match[2] === "run" && req.method === "POST") {
        requireOfficeAccess(identity, workflow.scope, "office:approve");
        requireOfficeAccess(identity, workflow.scope, "office:write");
        sendJson(res, 200, await runOfficeWorkflow(workflow.id, { baseWorkspace: ctx.workspace, model: createOfficeModelGateway(ctx.cfg, ctx.ollama) }));
        return true;
      }
      if (!match[2] && req.method === "DELETE") {
        requireOfficeAccess(identity, workflow.scope, "office:approve");
        deleteOfficeWorkflow(workflow.id);
        sendJson(res, 200, { deleted: true });
        return true;
      }
      sendJson(res, 405, { error: "method not allowed" });
      return true;
    }
    sendJson(res, 404, { error: "Office workflow route not found" });
    return true;
  } catch (error) {
    if (error instanceof OfficeIntelligenceError) sendJson(res, error.status, { error: error.message, code: error.code });
    else sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    return true;
  }
}
