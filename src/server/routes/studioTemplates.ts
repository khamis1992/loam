import http from "node:http";
import { TEMPLATES } from "../../../packages/web/src/components/home/templates.js";
import { APP_TEMPLATE_PREVIEWS } from "../../../packages/web/src/components/home/appTemplateData.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

export async function handleStudioTemplateRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
): Promise<boolean> {
  if (p !== "/api/studio-templates") return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  }
  sendJson(res, 200, { templates: TEMPLATES, appTemplates: APP_TEMPLATE_PREVIEWS });
  return true;
}
