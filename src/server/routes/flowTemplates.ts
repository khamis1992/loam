/**
 * Flow template HTTP surface (N15) — mounted by src/server/http.ts.
 *
 *   GET /api/flow-templates        the 12 seeded Loam flows
 *   GET /api/flow-templates/:id    one flow by slug (404 otherwise)
 *
 * Read-only: the templates are the JSON files in `src/templates/flows/*.json`,
 * so there is nothing to create, update or delete.
 */
import http from "node:http";
import { FLOW_TEMPLATES, getFlowTemplate } from "../../templates/flows/catalog.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

export async function handleFlowTemplateRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
): Promise<boolean> {
  if (p !== "/api/flow-templates" && !p.startsWith("/api/flow-templates/")) return false;

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  }

  const rest = p.slice("/api/flow-templates".length).replace(/^\/+/, "").replace(/\/+$/, "");
  if (!rest) {
    sendJson(res, 200, { flows: FLOW_TEMPLATES });
    return true;
  }

  const id = decodeURIComponent(rest.split("/")[0] ?? "");
  const flow = getFlowTemplate(id);
  if (!flow) {
    sendJson(res, 404, { error: "flow template not found" });
    return true;
  }
  sendJson(res, 200, { flow });
  return true;
}
