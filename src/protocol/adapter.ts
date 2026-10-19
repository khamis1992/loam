import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Config } from "../config.js";
import type { RunTaskOptions } from "../server/http.js";
import type { Task } from "../server/db.js";
import { log } from "../log.js";
import { ProtocolStore } from "./store.js";
import { createChatSocket } from "./socket.js";
import { makeRpcHandlers, rpcError, tokenToUserUid, consumeLoginToken, issueLoginToken } from "./rpc.js";
import { shortUid } from "./events.js";

export interface ProtocolAdapterDeps {
  cfg: Config;
  runTask: (opts: RunTaskOptions) => Promise<{ taskId: string; text: string }>;
  getTask: (id: string) => Task | undefined;
  port?: number;
}

export interface ProtocolAdapter {
  server: http.Server;
  io: ReturnType<typeof createChatSocket>;
  store: ProtocolStore;
  port: number;
  close: () => Promise<void>;
}

const HTTP_STATUS: Record<string, number> = {
  unauthenticated: 401,
  not_found: 404,
  invalid_argument: 400,
  permission_denied: 403,
};

async function readBody(req: http.IncomingMessage, maxBytes = 1_000_000): Promise<unknown> {
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

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

export async function startProtocolAdapter(deps: ProtocolAdapterDeps): Promise<ProtocolAdapter> {
  const store = new ProtocolStore();
  const handlers = makeRpcHandlers(store);
  const blobs = new Map<string, Buffer>();
  const publicPaths = new Set(["user.v1.UserAuthPublicService/ExchangeTokenByCode"]);

  const server = http.createServer((req, res) => {
    void (async (): Promise<void> => {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
        const p = url.pathname;
        const rpcPath = p.replace(/^\//, "");

        // CORS
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, connect-protocol-version, x-client-id, x-client-type, x-client-version, x-client-locale, x-client-timezone, x-client-timezone-offset");
        if (req.method === "OPTIONS") {
          res.writeHead(204).end();
          return;
        }

        // Dev login redirect page (mirrors BUILD_SPEC §8.4).
        if (req.method === "GET" && p === "/login") {
          const nonce = url.searchParams.get("nonce") ?? "";
          const type = url.searchParams.get("type") ?? "signIn";
          const loginToken = issueLoginToken(nonce);
          const scheme = process.env.DEEP_LINK_SCHEME ?? "agentstudio";
          const location = `${scheme}://auth/callback?token=${loginToken}&nonce=${encodeURIComponent(nonce)}`;
          res.writeHead(302, { Location: location }).end();
          log.info(`protocol login redirect type=${type} nonce=${nonce}`);
          return;
        }

        // Upload 3-step contract (§8.1).
        if (req.method === "PUT" && p.startsWith("/blob/")) {
          const id = p.slice(6);
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          blobs.set(id, Buffer.concat(chunks));
          res.writeHead(200).end();
          return;
        }
        if (req.method === "GET" && p.startsWith("/blob/")) {
          const b = blobs.get(p.slice(6));
          if (b) { res.writeHead(200).end(b); } else { res.writeHead(404).end(); }
          return;
        }
        if (req.method === "POST" && (p === "/api/chat/getPresignedUploadUrl" || p === "/api/chat/uploadComplete")) {
          const body = (await readBody(req)) as Record<string, unknown>;
          const base = `http://localhost:${deps.port ?? 8787}/blob/`;
          if (p === "/api/chat/getPresignedUploadUrl") {
            const id = shortUid();
            blobs.set(id, Buffer.alloc(0));
            sendJson(res, 200, { data: { uploadUrl: base + id, id } });
          } else {
            const id = String(body.id ?? "");
            sendJson(res, 200, { data: { fileUrl: base + id } });
          }
          return;
        }

        // Connect JSON RPC routes.
        if (req.method === "POST" && handlers[rpcPath]) {
          const auth = req.headers.authorization?.replace(/^Bearer /, "");
          const isLoginToken = !!auth && consumeLoginToken(auth) !== undefined;
          const userUid = auth ? tokenToUserUid(auth) ?? (isLoginToken ? "u_1" : null) : null;
          if (!publicPaths.has(rpcPath) && !userUid) {
            sendJson(res, 401, { code: "unauthenticated", message: "login required" });
            return;
          }
          if (rpcPath === "user.v1.UserAuthService/GenerateTempAuthCode" && isLoginToken && auth) {
            consumeLoginToken(auth);
          }
          const body = (await readBody(req)) as Record<string, unknown>;
          const result = handlers[rpcPath]!(body, { userUid, isPublic: isLoginToken });
          sendJson(res, 200, result);
          return;
        }

        // Health check used by clients and tests.
        if (req.method === "GET" && p === "/api/health") {
          sendJson(res, 200, { ok: true, service: "protocol-adapter" });
          return;
        }

        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      } catch (err) {
        log.error(`protocol adapter http error ${req.method} ${req.url}: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) {
          const e = err as { code?: string };
          const status = HTTP_STATUS[e.code ?? ""] ?? 500;
          sendJson(res, status, { code: e.code ?? "internal", message: err instanceof Error ? err.message : String(err) });
        } else {
          res.end();
        }
      }
    })();
  });

  const io = createChatSocket({ httpServer: server, store, runTask: deps.runTask, getTask: deps.getTask });

  let port = deps.port ?? (Number(process.env.AS_PROTOCOL_PORT) || 8787);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      port = address.port;
      log.info(`protocol adapter ready → http://127.0.0.1:${port}`);
      resolve();
    });
  });

  return {
    server,
    io,
    store,
    port,
    close: () =>
      new Promise((resolve) => {
        io.close(() => {
          server.close(() => resolve());
        });
      }),
  };
}
