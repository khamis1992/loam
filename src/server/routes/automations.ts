/**
 * D14 — automation event-trigger route.
 *
 *   POST /api/automations/trigger/:id
 *
 * One endpoint for both event triggers. The automation's stored trigger decides
 * the transport: `webhook` verifies an `x-loam-signature` HMAC over the raw
 * body; `github` verifies `x-hub-signature-256`, maps the `x-github-event`
 * payload to a prompt and only fires for the automation's allow-listed events.
 * A verified delivery starts a Loam agent session through the scheduled-run
 * engine (the same path cron routines use).
 */
import http from "node:http";
import { getSchedule } from "../db.js";
import { log } from "../../log.js";
import {
  automationTriggerOf,
  buildAutomationPrompt,
  githubEventMatches,
  githubEventName,
  parseSignatureHeader,
  verifyHmacSignature,
} from "../webhookTriggers.js";

export interface ScheduledRun {
  (o: { prompt: string; scheduleId: string; agentId?: string; workMode?: string }): Promise<string>;
}

interface TriggerContext {
  /** Test/embedding override for the scheduled-run engine. */
  run?: ScheduledRun;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readRawBody(req: http.IncomingMessage, maxBytes = 1_000_000): Promise<Buffer> {
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
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" ? value : undefined;
}

function resolveRun(ctx?: TriggerContext): ScheduledRun | undefined {
  return ctx?.run ?? (globalThis as { __loamScheduledRun?: ScheduledRun }).__loamScheduledRun;
}

/** Parse a JSON body, tolerating an empty body (webhooks may send none). */
function parseJson(raw: Buffer): unknown {
  if (!raw.length) return undefined;
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return undefined;
  }
}

export async function handleAutomationsRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  ctx?: TriggerContext,
): Promise<boolean> {
  const match = /^\/api\/automations\/trigger\/([^\/]+)$/.exec(p);
  if (!match || req.method !== "POST") return false;
  const id = decodeURIComponent(match[1]!);
  const schedule = getSchedule(id);
  if (!schedule) {
    sendJson(res, 404, { error: "automation not found" });
    return true;
  }

  const trigger = automationTriggerOf(schedule);
  if (trigger === "cron") {
    sendJson(res, 400, { error: "automation is not an event trigger" });
    return true;
  }

  let raw: Buffer;
  try {
    raw = await readRawBody(req);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }

  let githubEvent: string | undefined;
  if (trigger === "webhook") {
    const signature = parseSignatureHeader(header(req, "x-loam-signature"));
    if (!schedule.webhookSecret || !verifyHmacSignature(raw, signature, schedule.webhookSecret)) {
      sendJson(res, 401, { error: "invalid signature" });
      return true;
    }
  } else {
    const signature = parseSignatureHeader(header(req, "x-hub-signature-256"));
    if (!schedule.webhookSecret || !verifyHmacSignature(raw, signature, schedule.webhookSecret)) {
      sendJson(res, 401, { error: "invalid signature" });
      return true;
    }
    const payload = parseJson(raw);
    const action = (payload && typeof payload === "object" && typeof (payload as { action?: unknown }).action === "string"
      ? (payload as { action: string }).action
      : undefined);
    githubEvent = githubEventName(header(req, "x-github-event"), action);
    if (!githubEvent) {
      sendJson(res, 400, { error: "missing x-github-event" });
      return true;
    }
    if (!githubEventMatches(schedule.githubEvents, githubEvent)) {
      sendJson(res, 202, { ignored: true, event: githubEvent, reason: "event not subscribed" });
      return true;
    }
  }

  const payload = parseJson(raw);
  const prompt = buildAutomationPrompt(schedule, payload, githubEvent);
  const run = resolveRun(ctx);
  if (!run) {
    sendJson(res, 503, { error: "trigger engine is not initialized" });
    return true;
  }

  void run({
    prompt,
    scheduleId: schedule.id,
    ...(schedule.agentId ? { agentId: schedule.agentId } : {}),
    ...(schedule.workMode ? { workMode: schedule.workMode } : {}),
  }).catch((err) => {
    // The run is persisted by the engine; a rejection here must not crash the request.
    log.warn(`automation trigger ${schedule.id}: ${String(err)}`);
  });

  sendJson(res, 202, { started: true, scheduleId: schedule.id, trigger, ...(githubEvent ? { event: githubEvent } : {}) });
  return true;
}
