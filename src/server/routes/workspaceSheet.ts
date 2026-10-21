import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { getTask } from "../db.js";
import { requireTaskWorkspace, taskPath } from "../taskWorkspace.js";
import { loadConfig } from "../../config.js";
import { SheetIOError, parseSheetDoc, readSheetDoc, writeSheetDoc } from "../workspace/sheetIO.js";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_PUT_BYTES = 30_000_000;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function serveBytes(res: http.ServerResponse, buffer: Buffer, filename: string): void {
  res.writeHead(200, {
    "content-type": XLSX_MIME,
    "content-length": buffer.length,
    "content-disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
  });
  res.end(buffer);
}

function readRawBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new SheetIOError("body too large", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function resolveFile(taskId: string, rel: string, baseWorkspace: string): { abs: string; rel: string; taskId: string } {
  if (!taskId) throw new SheetIOError("taskId is required", 400);
  if (!/\.xlsx$/i.test(rel)) throw new SheetIOError("the sheet editor edits .xlsx workspace files", 400);
  if (!getTask(taskId)) throw new SheetIOError("task not found", 404);
  const root = requireTaskWorkspace(taskId, baseWorkspace);
  const abs = taskPath(root, rel);
  return { abs, rel, taskId };
}

function fail(res: http.ServerResponse, err: unknown): void {
  if (err instanceof SheetIOError) {
    sendJson(res, err.status, { error: err.message });
    return;
  }
  sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
}

/**
 * Sheet workspace editor routes:
 *   GET  /api/workspace/sheet/file?taskId=&path=            -> JSON SheetDoc
 *   GET  /api/workspace/sheet/file?taskId=&path=&format=raw -> raw .xlsx bytes
 *   PUT  /api/workspace/sheet/file?taskId=&path=            -> JSON SheetDoc body, saved back as .xlsx
 */
export async function handleWorkspaceSheetRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  _ctx?: Record<string, unknown>,
): Promise<boolean> {
  if (p !== "/api/workspace/sheet/file") return false;
  const method = req.method ?? "";
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (method === "GET") {
      const identity = resolveFile(url.searchParams.get("taskId") ?? "", url.searchParams.get("path") ?? "", loadConfig().workspace);
      const abs = path.resolve(identity.abs);
      if (url.searchParams.get("format") === "raw") {
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new SheetIOError("file not found", 404);
        serveBytes(res, fs.readFileSync(abs), path.basename(identity.rel));
        return true;
      }
      sendJson(res, 200, await readSheetDoc(abs, { taskId: identity.taskId, path: identity.rel, name: path.basename(identity.rel) }));
      return true;
    }
    if (method === "PUT") {
      const identity = resolveFile(url.searchParams.get("taskId") ?? "", url.searchParams.get("path") ?? "", loadConfig().workspace);
      const buffer = await readRawBody(req, MAX_PUT_BYTES);
      let parsed: unknown;
      try {
        parsed = JSON.parse(buffer.toString("utf8"));
      } catch {
        throw new SheetIOError("invalid JSON body", 400);
      }
      const doc = parseSheetDoc(parsed, { taskId: identity.taskId, path: identity.rel, name: path.basename(identity.rel) });
      const result = await writeSheetDoc(path.resolve(identity.abs), doc);
      sendJson(res, 200, { ok: true, path: identity.rel, bytes: result.bytes, warnings: result.warnings });
      return true;
    }
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  } catch (err) {
    fail(res, err);
    return true;
  }
}
