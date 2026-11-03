// GET /api/recorder/status — dist and native helper presence.
// POST /api/recorder/consent — user-only consent token.
// POST /api/recorder/call — bridge method. The agent uses the tool, not this
// consent route, so a model cannot approve its own capture.
import type { IncomingMessage, ServerResponse } from "node:http";
import { ROOT } from "../../config.js";
import { readRecorderStatus } from "../recorderStatus.js";
import { createFfmpegCapture } from "../recorder/ffmpegCapture.js";
import { RecorderSession, type ConsentRequest } from "../recorder/session.js";

export interface RecorderRouteOptions {
  root?: string;
  session?: RecorderSession;
}

const sessions = new Map<string, RecorderSession>();

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

export function getRecorderSession(root: string, existing?: RecorderSession): RecorderSession {
  if (existing) return existing;
  const cached = sessions.get(root);
  if (cached) return cached;
  const status = readRecorderStatus(root);
  const created = new RecorderSession({
    distInstalled: status.installed,
    helperOk: status.helper === "ok",
    compositorOk: status.compositor === "ok",
    captionsBackend: "missing",
  }, Date.now, createFfmpegCapture());
  sessions.set(root, created);
  return created;
}

function consentBody(value: unknown): ConsentRequest | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (body.confirmed !== true) return null;
  if (typeof body.sourceId !== "string" || !body.sourceId.trim()) return null;
  return {
    sourceId: body.sourceId.trim(),
    systemAudio: body.systemAudio === true,
    mic: body.mic === true,
    webcam: body.webcam === true,
  };
}

export async function handleRecorderRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  p: string,
  opts: RecorderRouteOptions = {},
): Promise<boolean> {
  if (!p.startsWith("/api/recorder")) return false;
  const root = opts.root ?? process.env.LOAM_ROOT ?? process.env.MANUS_LOCAL_ROOT ?? ROOT;
  const session = getRecorderSession(root, opts.session);
  if (req.method === "GET" && p === "/api/recorder/status") {
    const live = await session.call("status", {});
    sendJson(res, 200, { ...readRecorderStatus(root), ...(live.result as Record<string, unknown>) });
    return true;
  }
  if (req.method === "POST" && (p === "/api/recorder/consent" || p === "/api/recorder/call")) {
    const raw = await readBody(req);
    let parsed: unknown = {};
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      sendJson(res, 400, { error: "Invalid JSON" });
      return true;
    }
    if (p === "/api/recorder/consent") {
      const consent = consentBody(parsed);
      if (!consent) {
        sendJson(res, 400, { error: "Consent needs confirmed: true and a sourceId." });
        return true;
      }
      sendJson(res, 200, session.issueConsent(consent));
      return true;
    }
    const body = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    const method = typeof body.method === "string" ? body.method : "";
    sendJson(res, 200, await session.call(method, body.params ?? {}));
    return true;
  }
  sendJson(res, 404, { error: "Not found" });
  return true;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
