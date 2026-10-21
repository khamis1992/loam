import http from "node:http";
import { exportAllData, deleteAllUserData, confirmIsDelete } from "../dataControls.js";
import { log } from "../../log.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, maxBytes = 4_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
    req.on("error", reject);
  });
}

/** Settings › Data controls: full export and typed-confirmation delete-all. */
export async function handleDataControlsRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
): Promise<boolean> {
  if (!p.startsWith("/api/data/")) return false;

  if (p === "/api/data/export" && req.method === "GET") {
    const data = exportAllData();
    const text = JSON.stringify(data, null, 1);
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(text),
      "content-disposition": `attachment; filename="loam-data-export.json"`,
      "cache-control": "no-store",
    });
    res.end(text);
    return true;
  }

  if (p === "/api/data/delete-all" && req.method === "POST") {
    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      body = null;
    }
    if (!confirmIsDelete(body as { confirm?: unknown })) {
      sendJson(res, 400, { error: 'Type DELETE to confirm. Expected {"confirm":"DELETE"}.' });
      return true;
    }
    const report = deleteAllUserData();
    log.warn(`data controls: deleted all user data ${JSON.stringify(report.deleted)}`);
    sendJson(res, 200, report);
    return true;
  }

  sendJson(res, 404, { error: "unknown data control" });
  return true;
}
