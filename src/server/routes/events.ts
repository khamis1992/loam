import http from "node:http";
import {
  after as afterSeq,
  headSeq,
  type LogEvent,
} from "../../protocol/eventLog.js";

/**
 * Durable event log HTTP routes (BUILD_SPEC §8, task O8).
 *
 *   GET /api/sessions/:id/events?after_seq=0&limit=500
 *        -> 200 { data: [LogEvent...], next_after_seq: 42, has_more: false }
 *   GET /api/sessions/:id/events/stream
 *        -> SSE; every frame carries `id: <seq>`; the request header
 *           `Last-Event-ID` (or `?after_seq=`) resumes with only the missing
 *           events; a `: hb` comment is sent every 10 s.
 *
 * The `id` field of an SSE frame is the event `seq`, so a client that stores the
 * last id it rendered can reconnect and receive exactly the rows it has not seen.
 *
 * Mount via http.ts:
 *   if (await handleEventsRoutes(req, res, p)) return;
 */

/** SSE heartbeat cadence. §8 asks for a comment at least every 10 s. */
export const EVENT_STREAM_HEARTBEAT_MS = 10_000;

const DEFAULT_LIMIT = 500;
/** One page of the HTTP listing. The stream polls in this-sized pages. */
const MAX_LIMIT = 5_000;

/** `after_seq` cursor names accepted by both routes. */
const AFTER_SEQ_PARAMS = ["after_seq", "afterSeq", "after"] as const;

const LAST_EVENT_ID_HEADER = "last-event-id";

export interface EventStreamDeps {
  /** Heartbeat cadence; defaults to EVENT_STREAM_HEARTBEAT_MS (<= 10 s per §8). */
  heartbeatMs?: number;
  /** Test seam: sleep between polling the log for new rows. */
  pollMs?: number;
  /** Test seam: clock used for the resume response's `retry` hint. */
  now?: () => number;
}

interface Cursor {
  seq: number;
  limit: number;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

/** `?after_seq=` is the documented cursor; `?after=` / `?afterSeq=` are tolerated. */
function parseCursor(value: string | null | undefined, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function parseLimit(value: string | null | undefined): number {
  const n = parseCursor(value, DEFAULT_LIMIT);
  return Math.min(Math.max(n, 1), MAX_LIMIT);
}

function cursorFromUrl(url: URL): Cursor {
  for (const name of AFTER_SEQ_PARAMS) {
    const raw = url.searchParams.get(name);
    if (raw !== null) return { seq: parseCursor(raw, 0), limit: parseLimit(url.searchParams.get("limit")) };
  }
  return { seq: 0, limit: parseLimit(url.searchParams.get("limit")) };
}

/** The SSE `Last-Event-ID` header is the documented resume cursor (§8). */
function cursorFromHeader(header: string | undefined): number {
  if (!header) return 0;
  return parseCursor(header.trim().replace(/^"|"$/g, ""), 0);
}

/** One replayed/live frame. `id` is the event `seq`, and `data` follows the §8
 *  socket envelope so a client can feed both channels through one handler: a
 *  `chat_event` row's payload *is* the `ServerEnvelope`, so it is forwarded
 *  verbatim with the durable `seq` stamped on it. */
export function streamFrame(ev: LogEvent): { id: number; data: Record<string, unknown> } {
  if (ev.kind === "chat_event") {
    const envelope = ev.payload as Record<string, unknown>;
    return { id: ev.seq, data: { ...envelope, seq: ev.seq } };
  }
  return {
    id: ev.seq,
    data: {
      id: ev.id,
      type: "event",
      sessionId: ev.sessionId,
      timestamp: ev.createdAt,
      seq: ev.seq,
      kind: ev.kind,
      event: ev.payload,
    },
  };
}

function sseHeaders(res: http.ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
}

function writeFrame(res: http.ServerResponse, frame: { id: number; data: unknown }): void {
  // §8: the SSE `id` field is the event seq, so a reconnecting client can send
  // it back as `Last-Event-ID` and receive exactly the rows it has not seen.
  res.write(`id: ${frame.id}\ndata: ${JSON.stringify(frame.data)}\n\n`);
}

/**
 * Live tail: poll the log for rows with `seq > cursor` and write one SSE frame per
 * row. Stops when the client goes away. Returns the last seq seen, so a test can
 * assert on what was streamed without parsing the whole body.
 */
async function streamTail(
  res: http.ServerResponse,
  sessionId: string,
  cursor: number,
  deps: Required<Pick<EventStreamDeps, "pollMs">> & { heartbeatMs: number },
): Promise<number> {
  let last = cursor;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    res.off("close", stop);
  };

  // `: hb` is a comment: it keeps proxies from closing an idle stream and is
  // ignored by every SSE parser, so it never displaces a real event id.
  timer = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write(": hb\n\n");
  }, deps.heartbeatMs);
  timer.unref();
  res.once("close", stop);

  try {
    for (;;) {
      if (res.destroyed || res.writableEnded) break;
      const rows = afterSeq(sessionId, last, MAX_LIMIT);
      if (rows.length > 0) {
        for (const ev of rows) {
          if (res.destroyed || res.writableEnded) break;
          writeFrame(res, streamFrame(ev));
          last = ev.seq;
        }
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, deps.pollMs));
    }
  } finally {
    stop();
  }
  return last;
}

/**
 * Handle the two event-log routes. Returns true when the path was recognised
 * (even if the response is a 4xx), false so http.ts can keep dispatching.
 */
export async function handleEventsRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  deps: EventStreamDeps = {},
): Promise<boolean> {
  const match = /^\/api\/sessions\/([^/]+)\/events(\/stream)?$/.exec(p);
  if (!match) return false;
  const sessionId = decodeURIComponent(match[1]!);

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  }

  const url = new URL(req.url ?? "/", "http://localhost");

  if (match[2] === "/stream") {
    const heartbeatMs = Math.min(
      Math.max(deps.heartbeatMs ?? EVENT_STREAM_HEARTBEAT_MS, 1),
      EVENT_STREAM_HEARTBEAT_MS,
    );
    const headerCursor = cursorFromHeader(req.headers[LAST_EVENT_ID_HEADER] as string | undefined);
    const queryCursor = cursorFromUrl(url).seq;
    // An explicit query cursor wins; otherwise resume from `Last-Event-ID`.
    const cursor = url.searchParams.has("after_seq") || url.searchParams.has("afterSeq") || url.searchParams.has("after")
      ? queryCursor
      : Math.max(headerCursor, queryCursor);

    sseHeaders(res);
    const now = deps.now ?? Date.now;
    // `retry` tells a client how long to wait before reconnecting; `id` echoes the
    // resume cursor so the client can verify the server honoured it.
    res.write(`retry: ${heartbeatMs}\n`);
    res.write(`id: ${cursor}\n`);
    res.write(`data: ${JSON.stringify({ type: "resume", sessionId, after_seq: cursor, at: now() })}\n\n`);

    await streamTail(res, sessionId, cursor, {
      heartbeatMs,
      pollMs: deps.pollMs ?? 250,
    });
    if (!res.destroyed && !res.writableEnded) res.end();
    return true;
  }

  const { seq, limit } = cursorFromUrl(url);
  const rows = afterSeq(sessionId, seq, limit);
  const next = rows.length > 0 ? rows[rows.length - 1]!.seq : headSeq(sessionId);
  sendJson(res, 200, { data: rows, next_after_seq: next, has_more: rows.length === limit });
  return true;
}
