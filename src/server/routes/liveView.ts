import http from "node:http";
import { loadConfig } from "../../config.js";
import type { ScreenLive } from "../../screen/live.js";
import {
  latestBrowserFrame,
  registerBrowserFrameSink,
  resolveFrameKey,
} from "../../tools/browserFrames.js";
import { log } from "../../log.js";

export interface LiveViewDeps {
  screenLive?: ScreenLive;
}

export interface LiveViewFramePayload {
  source: "screen" | "browser";
  /** base64 image payload without the data: prefix. */
  data: string | null;
  mediaType: string;
  at: number;
  width: number | null;
  height: number | null;
  url: string | null;
  title: string | null;
}

export interface LiveViewStatus {
  screen: {
    /** Feature flag: true only when the ScreenLive streaming infra exists and is enabled in config. */
    available: boolean;
    running: boolean;
    fps: number | null;
    frames: number | null;
    subscribers: number | null;
    lastError: string | null;
    lastAt: string | null;
  };
  browser: {
    available: boolean;
    url: string | null;
    title: string | null;
    at: number | null;
  };
  /** Overall flag the client uses to decide live view vs. a graceful placeholder. */
  available: boolean;
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

function screenAvailable(deps: LiveViewDeps): boolean {
  return Boolean(deps.screenLive) && loadConfig().screen.enabled;
}

function screenFrame(deps: LiveViewDeps): LiveViewFramePayload | null {
  const frame = deps.screenLive?.latest() ?? null;
  if (!frame) return null;
  return {
    source: "screen",
    data: frame.base64,
    mediaType: frame.mediaType,
    at: Date.parse(frame.at) || 0,
    width: frame.width,
    height: frame.height,
    url: null,
    title: null,
  };
}

function browserFramePayload(key: string): LiveViewFramePayload | null {
  const frame = latestBrowserFrame(key);
  if (!frame || !frame.jpegBase64) return null;
  return {
    source: "browser",
    data: frame.jpegBase64,
    mediaType: "image/jpeg",
    at: frame.at,
    width: null,
    height: null,
    url: frame.url,
    title: frame.title ?? null,
  };
}

function statusBody(deps: LiveViewDeps, key: string): LiveViewStatus {
  const screen = screenAvailable(deps);
  const live = deps.screenLive?.status();
  const bframe = latestBrowserFrame(key);
  const browserFrameAvailable = Boolean(bframe?.jpegBase64);
  return {
    screen: {
      available: screen,
      running: live?.running ?? false,
      fps: live?.fps ?? null,
      frames: live?.frames ?? null,
      subscribers: live?.subscribers ?? null,
      lastError: live?.lastError ?? null,
      lastAt: live?.lastAt ?? null,
    },
    browser: {
      // The browser frame hub ships with the browser tool; frames appear as the
      // agent navigates, so the infra itself is always available in this build.
      available: true,
      url: bframe?.url ?? null,
      title: bframe?.title ?? null,
      at: bframe?.at ?? null,
    },
    // Live view as a whole works when either source has streaming infra.
    available: screen || browserFrameAvailable || true,
  };
}

/** Start live capture when the panel opens so the tab is immediately useful,
 *  without fighting the agent's own screen_stream_start/stop lifecycle: we
 *  intentionally do NOT stop the capture on client disconnect. */
function ensureScreenLive(deps: LiveViewDeps): boolean {
  if (!deps.screenLive || !loadConfig().screen.enabled) return false;
  if (!deps.screenLive.running) deps.screenLive.start(loadConfig().screen.fps);
  return true;
}

/** Live computer view routes (dispatched from src/server/http.ts):
 *  - GET /api/live-view/status?taskId=      → feature flag + latest-frame metadata
 *  - GET /api/live-view/frame?taskId=&source=screen|browser → single JSON snapshot
 *  - GET /api/live-view/stream?taskId=&source=screen|browser|both → SSE frame stream */
export async function handleLiveViewRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  deps: LiveViewDeps = {},
): Promise<boolean> {
  const base = "/api/live-view";
  if (!p.startsWith(base)) return false;
  const url = new URL(req.url ?? "/", "http://localhost");
  const key = resolveFrameKey(url.searchParams.get("taskId") ?? "");

  if (p === `${base}/status` && req.method === "GET") {
    sendJson(res, 200, statusBody(deps, key));
    return true;
  }

  if (p === `${base}/frame` && req.method === "GET") {
    const source = url.searchParams.get("source") === "browser" ? "browser" : "screen";
    if (source === "screen" && !screenAvailable(deps)) {
      sendJson(res, 200, { source, available: false, frame: null, error: "screen streaming disabled" });
      return true;
    }
    const frame = source === "screen" ? screenFrame(deps) : browserFramePayload(key);
    // available mirrors the per-source feature flag (screen) or always-present hub (browser).
    sendJson(res, 200, { source, available: source === "screen" ? screenAvailable(deps) : true, frame });
    return true;
  }

  if (p === `${base}/stream` && req.method === "GET") {
    const sourceParam = url.searchParams.get("source") ?? "both";
    const wantScreen = sourceParam !== "browser";
    const wantBrowser = sourceParam !== "screen";
    const screenOk = wantScreen ? ensureScreenLive(deps) : false;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    let closing = false;
    const send = (obj: unknown): void => {
      if (closing || res.destroyed) return;
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
    send({
      type: "status",
      screen: { available: screenOk, running: deps.screenLive?.running ?? false },
      browser: { available: wantBrowser },
    });
    const unsubscribeScreen = wantScreen && deps.screenLive
      ? deps.screenLive.subscribe((frame) => {
          send({
            type: "frame",
            source: "screen",
            data: frame.base64,
            mediaType: frame.mediaType,
            at: Date.parse(frame.at) || 0,
            width: frame.width,
            height: frame.height,
            url: null,
            title: null,
          });
        })
      : null;
    // Push the latest frames right away so the panel is never blank on open.
    const initialScreen = wantScreen ? screenFrame(deps) : null;
    if (initialScreen) send({ type: "frame", ...initialScreen });
    const unsubscribeBrowser = wantBrowser
      ? registerBrowserFrameSink(key, (frame) => {
          if (!frame.jpegBase64) return;
          send({
            type: "frame",
            source: "browser",
            data: frame.jpegBase64,
            mediaType: "image/jpeg",
            at: frame.at,
            width: null,
            height: null,
            url: frame.url,
            title: frame.title ?? null,
          });
        })
      : null;
    const initialBrowser = wantBrowser ? browserFramePayload(key) : null;
    if (initialBrowser) send({ type: "frame", ...initialBrowser });

    const keepalive = setInterval(() => {
      if (!res.destroyed) res.write(": ping\n\n");
    }, 15_000);
    req.on("close", () => {
      closing = true;
      clearInterval(keepalive);
      unsubscribeScreen?.();
      unsubscribeBrowser?.();
    });
    log.info(`live view: stream open (source=${sourceParam}, task=${key || "n/a"})`);
    return true;
  }

  return false;
}
