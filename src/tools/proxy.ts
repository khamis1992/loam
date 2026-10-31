/**
 * Recording HTTP proxy (Strix `tools/proxy` parity, without a Caido sidecar).
 *
 * The proxy is a plain forward proxy on loopback: the agent points a client at
 * it (`HTTP_PROXY`/`HTTPS_PROXY`, or `curl -x`) and every exchange is recorded
 * with a stable id under the task's artifact folder. A finding can then cite
 * the id of the proving exchange and the control exchange beside it, so the
 * report is replayable evidence rather than prose.
 *
 * Plain HTTP is fully recorded. HTTPS is tunneled with CONNECT: the target and
 * the byte counts are recorded, the bodies are not (no TLS interception yet).
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { resolveWrite } from "../policy/paths.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { num, str } from "./registry.js";

const MAX_BODY = 64 * 1024;
const MAX_HEADER_VALUE = 2_048;
const MAX_EXCHANGES = 400;
const MAX_LIST = 60;

export interface ProxyExchange {
  id: string;
  taskId: string;
  at: string;
  method: string;
  url: string;
  host: string;
  status?: number;
  durationMs?: number;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  bytesIn?: number;
  bytesOut?: number;
  error?: string;
  /** Set when the exchange was produced by proxy_repeat_request. */
  parentId?: string;
  /** True for a CONNECT tunnel: target recorded, bodies not readable. */
  tunnel?: boolean;
}

interface ProxyState {
  taskId: string;
  port: number;
  scope: string[];
  exchanges: ProxyExchange[];
  server: http.Server;
  file: string;
  startedAt: string;
  hits: number;
  nextId: number;
}

const proxies = new Map<string, ProxyState>();

function headerPairs(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => { out[key] = value; });
  return out;
}

function redact(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const text = String(value).slice(0, MAX_HEADER_VALUE);
    out[key] = /^(authorization|cookie|proxy-authorization|x-api-key|set-cookie)$/i.test(key) ? `${text.slice(0, 60)}${text.length > 60 ? "..." : ""}` : text;
  }
  return out;
}

function headersToObject(raw: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

function inScope(state: ProxyState, host: string): boolean {
  if (state.scope.length === 0) return true;
  // Scope patterns are hosts; a recorded/targeted value may carry a port.
  const lower = host.toLowerCase().replace(/:\d+$/, "");
  return state.scope.some((pattern) => {
    if (pattern === lower) return true;
    if (pattern.startsWith("*.")) return lower === pattern.slice(2) || lower.endsWith(pattern.slice(1));
    return false;
  });
}

function persist(state: ProxyState): void {
  try {
    fs.writeFileSync(state.file, JSON.stringify({ taskId: state.taskId, port: state.port, startedAt: state.startedAt, scope: state.scope, exchanges: state.exchanges }, null, 2));
  } catch {
    /* recording must never fail the request */
  }
}

function cap(text: string, max = MAX_BODY): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= max) return text;
  return `${text.slice(0, max)}\n[...truncated ${bytes - max} bytes]`;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY * 4) chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function push(state: ProxyState, exchange: ProxyExchange): void {
  state.exchanges.push(exchange);
  if (state.exchanges.length > MAX_EXCHANGES) state.exchanges.splice(0, state.exchanges.length - MAX_EXCHANGES);
  persist(state);
}

function taskFor(args: Record<string, unknown>, ctx: ToolContext): string {
  return str(args, "task_id").trim() || ctx.taskId || ctx.agentId || "workspace";
}

function proxyFile(ctx: ToolContext, taskId: string): string {
  const dir = resolveWrite(ctx.workspace, ".loam-proxy");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${taskId.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`);
}

async function startProxy(taskId: string, port: number, scope: string[], workspace: string): Promise<ProxyState> {
  const state = {
    taskId,
    port: 0,
    scope,
    exchanges: [],
    startedAt: new Date().toISOString(),
    hits: 0,
    nextId: 1,
    file: "",
    server: (undefined as unknown) as http.Server,
  } as ProxyState;
  state.file = proxyFile({ workspace } as ToolContext, taskId);

  const server = http.createServer((req, res) => {
    void (async () => {
      const startedAt = Date.now();
      const absolute = req.url ?? "";
      let target: URL;
      try {
        target = new URL(absolute);
      } catch {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("proxy expects an absolute URL (configure HTTP_PROXY, not a reverse proxy)");
        return;
      }
      const id = `px_${state.nextId++}`;
      const requestBody = await readBody(req);
      const record: ProxyExchange = {
        id,
        taskId,
        at: new Date().toISOString(),
        method: req.method ?? "GET",
        url: target.toString(),
        host: target.host,
        requestHeaders: redact(headersToObject(req.headers)),
        requestBody: requestBody ? cap(requestBody) : undefined,
        bytesIn: Buffer.byteLength(requestBody, "utf8"),
      };
      if (!inScope(state, target.host)) {
        record.status = 0;
        record.error = `out of scope: ${target.host}`;
        record.durationMs = Date.now() - startedAt;
        push(state, record);
        res.writeHead(403, { "content-type": "text/plain" });
        res.end(`out of scope: ${target.host}`);
        return;
      }
      state.hits += 1;
      // Drop proxy-only and length headers so the origin (and fetch's own body
      // framing) sees a normal request: a stale content-length is either
      // recomputed or conflicts with the body fetch writes.
      const headers: Record<string, string> = {};
      for (const key of Object.keys(record.requestHeaders)) {
        if (/^(proxy-connection|proxy-authorization|connection|host|content-length|transfer-encoding)$/i.test(key)) continue;
        const value = req.headers[key];
        if (typeof value === "string") headers[key] = value;
      }
      try {
        const upstream = await fetch(target, {
          method: record.method,
          headers,
          ...(requestBody && record.method !== "GET" && record.method !== "HEAD" ? { body: requestBody } : {}),
          redirect: "manual",
          signal: AbortSignal.timeout(60_000),
        });
        const body = cap(await upstream.text());
        record.status = upstream.status;
        record.responseHeaders = redact(headerPairs(upstream.headers));
        record.responseBody = body;
        record.bytesOut = Buffer.byteLength(body, "utf8");
        record.durationMs = Date.now() - startedAt;
        push(state, record);
        const out = headerPairs(upstream.headers);
        for (const key of ["content-encoding", "transfer-encoding", "content-length"]) delete out[key];
        res.writeHead(upstream.status, out);
        res.end(body);
      } catch (err) {
        record.durationMs = Date.now() - startedAt;
        record.error = err instanceof Error ? `${err.message}${err.cause instanceof Error ? `: ${err.cause.message}` : ""}`.slice(0, 300) : String(err).slice(0, 300);
        push(state, record);
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(`proxy upstream error: ${record.error}`);
      }
    })();
  });

  server.on("connect", (req, socket, head) => {
    const [host, rawPort] = (req.url ?? "").split(":");
    const portNumber = Number(rawPort || 443);
    const startedAt = Date.now();
    const id = `px_${state.nextId++}`;
    const record: ProxyExchange = {
      id,
      taskId,
      at: new Date().toISOString(),
      method: "CONNECT",
      url: `https://${host}:${portNumber}`,
      host: `${host}:${portNumber}`,
      requestHeaders: {},
      tunnel: true,
      bytesIn: head.length,
    };
    if (!inScope(state, `${host}:${portNumber}`) && !inScope(state, host ?? "")) {
      record.status = 403;
      record.error = "out of scope";
      push(state, record);
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    state.hits += 1;
    const upstream = net.connect(portNumber, host!, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
      record.status = 200;
      record.durationMs = Date.now() - startedAt;
      push(state, record);
    });
    upstream.on("error", (err) => {
      record.error = err.message.slice(0, 200);
      record.durationMs = Date.now() - startedAt;
      push(state, record);
      socket.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  state.port = typeof address === "object" && address ? address.port : port;
  state.server = server;
  persist(state);
  return state;
}

function listLine(exchange: ProxyExchange): string {
  const status = exchange.error ? `ERR ${exchange.error.slice(0, 60)}` : String(exchange.status ?? "-");
  return `${exchange.id} ${exchange.method} ${exchange.url} -> ${status}${exchange.parentId ? ` (replay of ${exchange.parentId})` : ""}`;
}

export function createProxyTools(): Tool[] {
  return [
    {
      name: "proxy_start",
      description:
        "Start the recording HTTP proxy for this task on loopback. Point a client at it (HTTP_PROXY/HTTPS_PROXY=http://127.0.0.1:<port>, or curl -x) so every exchange is recorded with an id you can cite as evidence. HTTPS is tunneled (target recorded, bodies not); plain HTTP is fully recorded. scope limits which hosts pass (empty = all).",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          port: { type: "number", description: "Loopback port; 0 or omitted picks a free one." },
          scope: { type: "array", items: { type: "string" }, description: "Allowed hosts; supports *.example.com. Empty = everything." },
        },
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const taskId = taskFor(args, ctx);
        const existing = proxies.get(taskId);
        if (existing) return { ok: true, content: `proxy already running on 127.0.0.1:${existing.port} (${existing.hits} hits)` };
        const scope = Array.isArray(args["scope"]) ? (args["scope"] as unknown[]).filter((s): s is string => typeof s === "string").map((s) => s.trim().toLowerCase()) : [];
        try {
          const state = await startProxy(taskId, Math.max(0, Math.floor(num(args, "port", 0))), scope, ctx.workspace);
          proxies.set(taskId, state);
          return {
            ok: true,
            content: `proxy listening on 127.0.0.1:${state.port}\nUse: curl -x http://127.0.0.1:${state.port} <url>  (or HTTP_PROXY/HTTPS_PROXY)\nscope: ${state.scope.length ? state.scope.join(", ") : "all hosts"}\nrecorded to ${state.file}`,
          };
        } catch (err) {
          return { ok: false, content: `proxy_start failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      name: "proxy_status",
      description: "Show whether the task's proxy is running, its port, scope and hit count.",
      parameters: { type: "object", properties: { task_id: { type: "string" } } },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const state = proxies.get(taskFor(args, ctx));
        if (!state) return { ok: true, content: "proxy not running" };
        return { ok: true, content: `running on 127.0.0.1:${state.port}, ${state.hits} hits, ${state.exchanges.length} recorded, scope: ${state.scope.length ? state.scope.join(", ") : "all"}` };
      },
    },
    {
      name: "proxy_list_requests",
      description: "List recorded exchanges (newest last). Filter by method, status, or a substring of the URL / response body. Ids are the evidence to cite.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          method: { type: "string" },
          status: { type: "number" },
          contains: { type: "string", description: "Substring matched against the URL and the response body." },
          limit: { type: "number", description: `Max rows (default ${MAX_LIST}).` },
        },
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const state = proxies.get(taskFor(args, ctx));
        if (!state) return { ok: false, content: "proxy not running" };
        const method = str(args, "method").toUpperCase();
        const status = args["status"] === undefined ? undefined : num(args, "status", 0);
        const contains = str(args, "contains").toLowerCase();
        const limit = Math.min(MAX_LIST, Math.max(1, Math.floor(num(args, "limit", MAX_LIST))));
        const hits = state.exchanges.filter((e) =>
          (!method || e.method === method) &&
          (status === undefined || e.status === status) &&
          (!contains || `${e.url} ${e.responseBody ?? ""} ${e.requestBody ?? ""}`.toLowerCase().includes(contains)));
        const rows = hits.slice(-limit);
        return { ok: true, content: rows.length ? `${rows.length} of ${hits.length} matching exchanges:\n${rows.map(listLine).join("\n")}` : "(no matching exchanges)" };
      },
    },
    {
      name: "proxy_view_request",
      description: "Show one recorded exchange in full (headers and capped bodies). Use it to build the proving and the control exchange of a finding.",
      parameters: { type: "object", properties: { id: { type: "string" }, task_id: { type: "string" } }, required: ["id"] },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const state = proxies.get(taskFor(args, ctx));
        if (!state) return { ok: false, content: "proxy not running" };
        const exchange = state.exchanges.find((e) => e.id === str(args, "id").trim());
        if (!exchange) return { ok: false, content: `no exchange ${str(args, "id")}` };

        return { ok: true, content: JSON.stringify(exchange, null, 2) };
      },
    },
    {
      name: "proxy_repeat_request",
      description: "Replay a recorded exchange, optionally with a different method, URL, body or headers. The replay is recorded as a new exchange that cites the original, so a baseline/variant pair is one finding's evidence.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Exchange to replay." },
          task_id: { type: "string" },
          method: { type: "string" },
          url: { type: "string", description: "Override the target URL." },
          body: { type: "string", description: "Override the request body." },
          headers: { type: "object", description: "Extra / overriding request headers." },
        },
        required: ["id"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const taskId = taskFor(args, ctx);
        const state = proxies.get(taskId);
        if (!state) return { ok: false, content: "proxy not running" };
        const original = state.exchanges.find((e) => e.id === str(args, "id").trim());
        if (!original) return { ok: false, content: `no exchange ${str(args, "id")}` };

        const method = str(args, "method").toUpperCase() || original.method;
        const url = str(args, "url") || original.url;
        const body = args["body"] === undefined ? original.requestBody : str(args, "body");
        const extra = args["headers"] && typeof args["headers"] === "object" ? args["headers"] as Record<string, unknown> : {};
        // The replay re-frames its own body, so the recorded framing headers go.
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(original.requestHeaders)) {
          if (/^(content-length|transfer-encoding|connection|host)$/i.test(key)) continue;
          headers[key] = value;
        }
        for (const [key, value] of Object.entries(extra)) if (typeof value === "string") headers[key.toLowerCase()] = value;
        const id = `px_${state.nextId++}`;
        const startedAt = Date.now();
        const record: ProxyExchange = {
          id, taskId, at: new Date().toISOString(), method, url,
          host: (() => { try { return new URL(url).host; } catch { return original.host; } })(),
          requestHeaders: redact(headers), requestBody: body, parentId: original.id,
          bytesIn: body ? Buffer.byteLength(body, "utf8") : 0,
        };
        try {
          const upstream = await fetch(url, {
            method,
            headers,
            ...(body && method !== "GET" && method !== "HEAD" ? { body } : {}),
            redirect: "manual",
            signal: AbortSignal.timeout(60_000),
          });
          const text = cap(await upstream.text());
          record.status = upstream.status;
          record.responseHeaders = redact(headerPairs(upstream.headers));
          record.responseBody = text;
          record.bytesOut = Buffer.byteLength(text, "utf8");
          record.durationMs = Date.now() - startedAt;
          push(state, record);
          return { ok: true, content: `${id} replay of ${original.id}: ${method} ${url} -> ${upstream.status} (${record.durationMs}ms)\n${text.slice(0, 2_000)}` };
        } catch (err) {
          record.error = err instanceof Error ? `${err.message}${err.cause instanceof Error ? `: ${err.cause.message}` : ""}`.slice(0, 300) : String(err).slice(0, 300);
          record.durationMs = Date.now() - startedAt;
          push(state, record);
          return { ok: false, content: `${id} replay failed: ${record.error}` };
        }
      },
    },
    {
      name: "proxy_scope",
      description: "Read or replace the proxy's host scope. Patterns are exact hosts or *.example.com; an empty list allows everything.",
      parameters: { type: "object", properties: { task_id: { type: "string" }, scope: { type: "array", items: { type: "string" } } } },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const state = proxies.get(taskFor(args, ctx));
        if (!state) return { ok: false, content: "proxy not running" };
        if (Array.isArray(args["scope"])) {
          state.scope = (args["scope"] as unknown[]).filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim().toLowerCase());
          persist(state);
        }
        return { ok: true, content: `scope: ${state.scope.length ? state.scope.join(", ") : "all hosts"}` };
      },
    },
    {
      name: "proxy_stop",
      description: "Stop the task's proxy and write the recording to disk. The exchanges stay readable through the artifact file.",
      parameters: { type: "object", properties: { task_id: { type: "string" } } },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const taskId = taskFor(args, ctx);
        const state = proxies.get(taskId);
        if (!state) return { ok: false, content: "proxy not running" };
        proxies.delete(taskId);
        await new Promise<void>((resolve) => state.server.close(() => resolve()));
        persist(state);
        return { ok: true, content: `proxy stopped: ${state.exchanges.length} exchanges recorded to ${state.file}` };
      },
    },
  ];
}
