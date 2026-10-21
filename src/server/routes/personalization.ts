import http from "node:http";
import { getPersonalization, savePersonalization } from "../personalization.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, maxBytes = 24_000): Promise<unknown> {
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

/** User custom instructions ("about me" / "how to respond"); persisted in the
 *  SQLite store and injected into every agent system prompt (src/agent/prompt.ts). */
export async function handlePersonalizationRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
): Promise<boolean> {
  if (!p.startsWith("/api/personalization")) return false;

  if (p === "/api/personalization" && req.method === "GET") {
    sendJson(res, 200, { personalization: getPersonalization() });
    return true;
  }

  if (p === "/api/personalization" && req.method === "POST") {
    const body = (await readJson(req)) as { aboutMe?: unknown; howToRespond?: unknown };
    const saved = savePersonalization({
      aboutMe: typeof body.aboutMe === "string" ? body.aboutMe : undefined,
      howToRespond: typeof body.howToRespond === "string" ? body.howToRespond : undefined,
    });
    sendJson(res, 200, { personalization: saved });
    return true;
  }

  sendJson(res, 405, { error: "method not allowed" });
  return true;
}
