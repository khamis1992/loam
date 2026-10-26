import http from "node:http";
import { pendingInterrupts, resolveInterrupt, dismissInterrupt, type InterruptRecord } from "../../orchestration/durable/interrupts.js";

export type ResumeFromInterrupt = (rec: InterruptRecord) => Promise<boolean>;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, max = 256_000): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new Error("body_too_large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

/** C2 §4.2.4: GET /api/interrupts, POST /api/interrupts/:id/{resolve,dismiss}. */
export async function handleInterruptRoutes(req: http.IncomingMessage, res: http.ServerResponse, p: string, url: URL, resume: ResumeFromInterrupt): Promise<boolean> {
  if (p === "/api/interrupts" && req.method === "GET") {
    sendJson(res, 200, { interrupts: pendingInterrupts(url.searchParams.get("taskId") ?? undefined) });
    return true;
  }
  const m = /^\/api\/interrupts\/([^/]+)\/(resolve|dismiss)$/.exec(p);
  if (!m) return false;
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  }
  const id = decodeURIComponent(m[1] ?? "");
  if (m[2] === "dismiss") {
    sendJson(res, dismissInterrupt(id) ? 200 : 409, { ok: true });
    return true;
  }
  let body: { response?: unknown };
  try {
    body = (await readJson(req)) as { response?: unknown };
  } catch {
    sendJson(res, 400, { error: "invalid body" });
    return true;
  }
  const r = resolveInterrupt(id, body.response, "user");
  if (!r.ok) {
    sendJson(res, r.error === "not_found" ? 404 : r.error === "not_pending" ? 409 : 400, { error: r.error, issues: r.issues ?? [] });
    return true;
  }
  // No live waiter = the run that raised it is gone (restart): resume it from its checkpoint.
  const resumed = r.hadLiveWaiter ? false : await resume(r.record);
  sendJson(res, 200, { record: r.record, resumed });
  return true;
}
