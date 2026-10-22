/**
 * Loam Studio Host routes (clean-room; see NOTICE in src/tools/loamStudioHost.ts).
 *
 * Mounted BEFORE the existing studio-artifact handlers in http.ts. Coexistence
 * rule: GET /api/studio WITH a `taskId` query is the legacy artifact read and
 * returns false here; only the taskId-less form is served as the studio list.
 * POST /api/studio/:app/command is new and collides with nothing.
 */
import http from "node:http";
import {
  listStudios,
  runStudioCommand,
  registryResolver,
  type StudioEngineResolver,
} from "../../tools/loamStudioHost.js";

/** JSON.stringify that never throws on circular/BigInt payloads. */
function safeStringify(body: unknown): string {
  try {
    return JSON.stringify(body);
  } catch {
    return JSON.stringify({ ok: false, error: "response could not be serialized" });
  }
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const text = safeStringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, maxBytes = 64_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        fail(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) {
        settled = true;
        resolve({});
        return;
      }
      try {
        settled = true;
        resolve(JSON.parse(text));
      } catch (err) {
        settled = true;
        reject(new Error(`invalid JSON body: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
    req.on("error", fail);
    req.on("aborted", () => fail(new Error("request aborted")));
  });
}

function resolverFrom(ctx?: Record<string, unknown>): StudioEngineResolver {
  const injected = ctx?.studioEngineResolver;
  return typeof injected === "function" ? (injected as StudioEngineResolver) : registryResolver;
}

const COMMAND_PATH = /^\/api\/studio\/([A-Za-z0-9_-]+)\/command$/;

/** Studio host routes: GET /api/studio (list) and POST /api/studio/:app/command (proxy). */
export async function handleStudioHostRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  ctx?: Record<string, unknown>,
): Promise<boolean> {
  if (!p.startsWith("/api/studio")) return false;

  try {
    if (p === "/api/studio" && req.method === "GET") {
      const query = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`).searchParams;
      if (query.has("taskId")) return false; // legacy studio-artifact read; not ours
      sendJson(res, 200, { studios: listStudios(resolverFrom(ctx)) });
      return true;
    }

    const match = COMMAND_PATH.exec(p);
    if (!match) return false;
    const app = decodeURIComponent(match[1]!);

    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" }, { allow: "POST" });
      return true;
    }

    let body: unknown;
    try {
      body = await readJson(req);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
      return true;
    }
    const command = (typeof body === "object" && body !== null ? body : {}) as { id?: unknown; params?: unknown };
    const outcome = await runStudioCommand(app, command, resolverFrom(ctx));

    if (!outcome.ok) {
      if (outcome.kind === "bad_request") {
        sendJson(res, 400, { ok: false, error: outcome.error });
        return true;
      }
      if (outcome.kind === "unknown_app") {
        sendJson(res, 404, { ok: false, error: outcome.error, app: outcome.app });
        return true;
      }
      // Engine-level failures stay 200 with an ok:false envelope (proxy semantics).
      const errorBody: Record<string, unknown> = { ok: false, error: outcome.error };
      if (outcome.kind === "disabled") errorBody.reason = outcome.reason;
      if (outcome.kind === "unsupported_command") errorBody.commandId = outcome.commandId;
      sendJson(res, 200, errorBody);
      return true;
    }

    if (outcome.kind === "commands") {
      sendJson(res, 200, { ok: true, commands: outcome.commands });
      return true;
    }
    sendJson(res, 200, { ok: true, data: outcome.data });
    return true;
  } catch (err) {
    // Never let an unexpected error escape as an unhandled rejection/hung socket.
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: "studio host error" });
    } else {
      res.end();
    }
    return true;
  }
}
