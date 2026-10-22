import http from "node:http";
import { getAssetsSnapshot, injectMockInbound, setEmailAlias, setPhoneNumber, setWalletPlaceholder } from "../assets.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, maxBytes = 64_000): Promise<unknown> {
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

/**
 * Asset routes (OPD option #8). LOCAL + MOCK ONLY: the email inbox is a
 * local mock store; nothing is sent over the network. Mount via http.ts:
 *   if (await handleAssetsRoutes(req, res, p)) return;
 */
export async function handleAssetsRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  _ctx?: Record<string, unknown>,
): Promise<boolean> {
  if (p === "/api/assets" && req.method === "GET") {
    sendJson(res, 200, getAssetsSnapshot());
    return true;
  }

  if (p === "/api/assets/email/mock-inbound" && req.method === "POST") {
    const body = (await readJson(req)) as { from?: unknown; subject?: unknown; body?: unknown };
    try {
      const message = injectMockInbound({
        from: typeof body.from === "string" ? body.from : "",
        subject: typeof body.subject === "string" ? body.subject : "",
        body: typeof body.body === "string" ? body.body : "",
      });
      sendJson(res, 200, { message, mock: true });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (p === "/api/assets/email/alias" && req.method === "POST") {
    const body = (await readJson(req)) as { alias?: unknown };
    try {
      const address = setEmailAlias(typeof body.alias === "string" ? body.alias : "");
      sendJson(res, 200, { address, mock: true });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (p === "/api/assets/phone" && req.method === "POST") {
    const body = (await readJson(req)) as { number?: unknown };
    try {
      const number = setPhoneNumber(typeof body.number === "string" ? body.number : "");
      sendJson(res, 200, { number, mock: true });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (p === "/api/assets/wallet" && req.method === "POST") {
    const body = (await readJson(req)) as { placeholder?: unknown };
    try {
      const placeholder = setWalletPlaceholder(typeof body.placeholder === "string" ? body.placeholder : "");
      sendJson(res, 200, { placeholder, mock: true });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  return false;
}