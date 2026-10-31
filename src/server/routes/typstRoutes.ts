/** Typst engine routes (blueprint §7.3): honest status + compile-to-PDF.
 *  Same-origin + token auth come from the global http.ts gate. */
import http from "node:http";
import { compileTypst, typstStatus } from "../../office/typst.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, maxBytes = 2_100_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) { reject(new Error("body_too_large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new Error("invalid_json")); }
    });
    req.on("error", reject);
  });
}

export async function handleTypstRoutes(req: http.IncomingMessage, res: http.ServerResponse, p: string): Promise<boolean> {
  if (!p.startsWith("/api/office/typst")) return false;

  if (p === "/api/office/typst/status" && req.method === "GET") {
    const status = await typstStatus();
    sendJson(res, 200, status);
    return true;
  }

  // POST /api/office/typst/compile {source} → application/pdf bytes
  if (p === "/api/office/typst/compile" && req.method === "POST") {
    const body = await readJson(req).catch(() => null);
    if (!body || typeof body !== "object") { sendJson(res, 400, { error: "invalid_json" }); return true; }
    const { source } = body as Record<string, unknown>;
    if (typeof source !== "string") { sendJson(res, 400, { error: "source_required" }); return true; }
    try {
      const { pdf } = await compileTypst(source);
      res.writeHead(200, { "content-type": "application/pdf", "content-length": pdf.length });
      res.end(pdf);
      return true;
    } catch (reason) {
      sendJson(res, 422, { error: reason instanceof Error ? reason.message : String(reason) });
      return true;
    }
  }

  return false;
}
