// src/appbuilder/appSync.ts — W4b: minimal pull/push sync for a generated
// app's SQLite file (app/data/app.sqlite), served by the app's own local API
// server (the server/index.mjs process the DevServerManager spawns):
//   GET  /__loam/sync/pull  → the data file bytes, streamed, capped at 25MB
//   POST /__loam/sync/push  ← replacement bytes (atomic .tmp + rename), capped
// The endpoints are local-only by contract: the app API server binds 127.0.0.1
// and these routes must never be exposed further. Two artifacts live here:
//   1. createLoamSyncHandler() — the Loam-side handler (tests, host tooling).
//   2. writeSyncOverlay() — writes server/loam-sync.mjs into the app dir so a
//      fullstack app server mounts the same routes in its own process. The
//      file is Loam-owned and refreshed on every dev-server start.
import fs from "node:fs";
import path from "node:path";
import type http from "node:http";

export const SYNC_MAX_BYTES = 25 * 1024 * 1024;
export const SYNC_PULL_PATH = "/__loam/sync/pull";
export const SYNC_PUSH_PATH = "/__loam/sync/push";

export interface LoamSyncOptions {
  /** The app's SQLite file; resolved per request so push/pull always see the current path. */
  dbPath: string | (() => string);
  /** Pull/push cap in bytes. Default SYNC_MAX_BYTES (25MB). */
  maxBytes?: number;
}

export type LoamSyncHandler = (req: http.IncomingMessage, res: http.ServerResponse) => boolean;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(data);
}

/** The canonical handler. Returns true when the request was one of the sync routes. */
export function createLoamSyncHandler(opts: LoamSyncOptions): LoamSyncHandler {
  const cap = opts.maxBytes ?? SYNC_MAX_BYTES;
  return (req, res) => {
    let pathname: string;
    try { pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname; } catch { return false; }
    if (pathname !== SYNC_PULL_PATH && pathname !== SYNC_PUSH_PATH) return false;
    const dbPath = typeof opts.dbPath === "function" ? opts.dbPath() : opts.dbPath;
    const method = (req.method ?? "GET").toUpperCase();

    if (pathname === SYNC_PULL_PATH) {
      if (method !== "GET") { sendJson(res, 405, { error: "method_not_allowed" }); return true; }
      let st: fs.Stats;
      try { st = fs.statSync(dbPath); } catch { sendJson(res, 404, { error: "no_database" }); return true; }
      if (!st.isFile()) { sendJson(res, 404, { error: "no_database" }); return true; }
      if (st.size > cap) { sendJson(res, 413, { error: "too_large", maxBytes: cap }); return true; }
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(st.size),
        "cache-control": "no-store",
        "x-loam-sync": "pull",
      });
      const stream = fs.createReadStream(dbPath);
      stream.on("error", () => res.destroy());
      stream.pipe(res);
      return true;
    }

    // push
    if (method !== "POST") { sendJson(res, 405, { error: "method_not_allowed" }); return true; }
    let size = 0;
    let over = false;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      if (over) return; // already refused: drain the rest so the response flushes cleanly
      size += c.length;
      if (size > cap) {
        over = true;
        sendJson(res, 413, { error: "too_large", maxBytes: cap });
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (over) return;
      const body = Buffer.concat(chunks);
      if (body.length === 0) { sendJson(res, 400, { error: "empty_body" }); return; }
      try {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        const tmp = `${dbPath}.push-tmp`;
        fs.writeFileSync(tmp, body);      // same volume as the target…
        fs.renameSync(tmp, dbPath);       // …so the rename replaces atomically
        sendJson(res, 200, { ok: true, bytes: body.length });
      } catch {
        sendJson(res, 500, { error: "write_failed" });
      }
    });
    req.on("error", () => { if (!res.writableEnded) res.destroy(); });
    return true;
  };
}

// ----------------------------------------------------------------------------
// The in-app overlay: server/loam-sync.mjs (plain ESM, no imports beyond node
// builtins, identical behaviour to the handler above; verified by the same
// test round-trip). Loam owns this file; it is refreshed on every dev-server
// start and must not be edited inside the app.
// ----------------------------------------------------------------------------
export const SYNC_OVERLAY_RELATIVE = "server/loam-sync.mjs";

const OVERLAY_SOURCE = `// server/loam-sync.mjs — Loam sync overlay (W4b). Loam owns this file; the dev
// server regenerates it on every start. Do not edit it inside the app.
// نقاط المزامنة المحلية لملف قاعدة بيانات التطبيق: هذه الوحدة تُقدّم مسارين فقط
// (GET /__loam/sync/pull و POST /__loam/sync/push) للاستخدام المحلي على هذا الجهاز.
// لا تعرّض خادم التطبيق خارج 127.0.0.1 أثناء وجود هذه المسارات، ولا تضع أي مفاتيح
// أو أسرار داخل كود التطبيق — تصل المفاتيح عبر متغيرات البيئة فقط.
//
// Mount contract (in server/index.mjs), first thing in your request handler:
//   import { handleLoamSync } from "./loam-sync.mjs";
//   // inside createServer(async (req, res) => {
//   if (handleLoamSync(req, res)) return;
// The database path comes from process.env.LOAM_DB_PATH (set by the Loam dev server).
// Pull streams at most 25MB; push replaces the file atomically (.tmp + rename), also capped.
// SQLite WAL note: for a fully consistent snapshot pull while the server is not writing,
// or checkpoint (PRAGMA wal_checkpoint(TRUNCATE)) before pulling.
import fs from "node:fs";
import path from "node:path";

export const SYNC_MAX_BYTES = ${SYNC_MAX_BYTES};
export const SYNC_PULL_PATH = ${JSON.stringify(SYNC_PULL_PATH)};
export const SYNC_PUSH_PATH = ${JSON.stringify(SYNC_PUSH_PATH)};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(data);
}

/** Same contract as Loam's createLoamSyncHandler: true when the request was handled. */
export function handleLoamSync(req, res, options = {}) {
  let pathname;
  try { pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname; } catch { return false; }
  if (pathname !== SYNC_PULL_PATH && pathname !== SYNC_PUSH_PATH) return false;
  const cap = options.maxBytes ?? SYNC_MAX_BYTES;
  const dbPath = options.dbPath ?? process.env.LOAM_DB_PATH;
  if (!dbPath) { sendJson(res, 500, { error: "no_db_path" }); return true; }
  const method = (req.method ?? "GET").toUpperCase();

  if (pathname === SYNC_PULL_PATH) {
    if (method !== "GET") { sendJson(res, 405, { error: "method_not_allowed" }); return true; }
    let st;
    try { st = fs.statSync(dbPath); } catch { sendJson(res, 404, { error: "no_database" }); return true; }
    if (!st.isFile()) { sendJson(res, 404, { error: "no_database" }); return true; }
    if (st.size > cap) { sendJson(res, 413, { error: "too_large", maxBytes: cap }); return true; }
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(st.size),
      "cache-control": "no-store",
      "x-loam-sync": "pull",
    });
    const stream = fs.createReadStream(dbPath);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
    return true;
  }

  if (method !== "POST") { sendJson(res, 405, { error: "method_not_allowed" }); return true; }
  let size = 0;
  let over = false;
  const chunks = [];
  req.on("data", (c) => {
    if (over) return; // already refused: drain the rest so the response flushes cleanly
    size += c.length;
    if (size > cap) { over = true; sendJson(res, 413, { error: "too_large", maxBytes: cap }); return; }
    chunks.push(c);
  });
  req.on("end", () => {
    if (over) return;
    const body = Buffer.concat(chunks);
    if (body.length === 0) { sendJson(res, 400, { error: "empty_body" }); return; }
    try {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const tmp = dbPath + ".push-tmp";
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, dbPath);
      sendJson(res, 200, { ok: true, bytes: body.length });
    } catch { sendJson(res, 500, { error: "write_failed" }); }
  });
  req.on("error", () => { if (!res.writableEnded) res.destroy(); });
  return true;
}
`;

/** Writes/refreshes <appDir>/server/loam-sync.mjs. Idempotent; returns the written path. */
export function writeSyncOverlay(appDir: string): string {
  const target = path.join(appDir, SYNC_OVERLAY_RELATIVE);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== OVERLAY_SOURCE) fs.writeFileSync(target, OVERLAY_SOURCE, "utf8");
  return target;
}

/** Overlay source for tests and inspection. */
export function syncOverlaySource(): string {
  return OVERLAY_SOURCE;
}
