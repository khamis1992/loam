import http from "node:http";
import { loadConfig } from "../../config.js";
import { requireTaskWorkspace } from "../taskWorkspace.js";
import { latestBrowserFrame } from "../../tools/browserFrames.js";
import { clearBrowserData, browserSessionsInfo } from "../../tools/browser.js";
import { getSettings, updateSettings } from "../settings.js";
import { log } from "../../log.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, maxBytes = 16_000): Promise<unknown> {
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

function isHttpUrl(value: unknown): boolean {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

/** Live browser routes (dispatched from src/server/http.ts before generic handlers):
 *  - GET  /api/browser/frame   → latest captured browser frame for a task
 *  - GET  /api/browser/settings → in-app browser settings
 *  - POST /api/browser/settings → update (headless, homepage)
 *  - POST /api/browser/clear-data → clear isolated browser profiles */
export async function handleBrowserLiveRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  _ctx?: Record<string, unknown>,
): Promise<boolean> {
  if (req.method === "GET" && p === "/api/browser/frame") {
    const taskId = new URL(req.url ?? "/", "http://localhost").searchParams.get("taskId") ?? "";
    try {
      requireTaskWorkspace(taskId || undefined as unknown as string, loadConfig().workspace);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      return true;
    }
    sendJson(res, 200, { frame: latestBrowserFrame(taskId) });
    return true;
  }

  if (p === "/api/browser/settings") {
    if (req.method === "GET") {
      const s = getSettings();
      sendJson(res, 200, {
        headless: s.browserHeadless ?? loadConfig().browser.headless,
        homepage: s.browserHomepage ?? "",
        sessions: browserSessionsInfo().length,
      });
      return true;
    }
    if (req.method === "POST") {
      let body: unknown;
      try {
        body = await readJson(req);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        return true;
      }
      const patch = (body ?? {}) as { headless?: unknown; homepage?: unknown };
      if (typeof patch.headless === "boolean") {
        updateSettings({ browserHeadless: patch.headless });
        log.info(`browser settings: headless=${patch.headless} (applies on next browser launch)`);
      }
      if (patch.homepage === "" || isHttpUrl(patch.homepage)) {
        updateSettings({ browserHomepage: typeof patch.homepage === "string" ? patch.homepage : "" });
      }
      const s = getSettings();
      sendJson(res, 200, {
        headless: s.browserHeadless ?? loadConfig().browser.headless,
        homepage: s.browserHomepage ?? "",
      });
      return true;
    }
  }

  if (p === "/api/browser/clear-data" && req.method === "POST") {
    const result = await clearBrowserData();
    sendJson(res, 200, { ok: result.profilesRemoved, profilesRemoved: result.profilesRemoved });
    return true;
  }

  return false;
}
