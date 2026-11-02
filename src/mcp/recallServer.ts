import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { createRecallService, openRecallFile } from "../memory/recall/service.js";
import { LEGAL_SCOPE } from "../memory/recall/types.js";
import type { RecallService } from "../memory/recall/service.js";

interface RpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

const WRITE = process.env.LOAM_RECALL_MCP_WRITE === "1";
const SHOW_LEGAL = process.env.LOAM_RECALL_MCP_LEGAL === "1";

function dbPath(argv: string[]): string {
  const flag = argv.indexOf("--db");
  if (flag >= 0 && argv[flag + 1]) return path.resolve(argv[flag + 1]!);
  const fromEnv = process.env.LOAM_RECALL_DB;
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(process.cwd(), "data", "manus.db");
}

function toolList() {
  return [
    { name: "memory_recall", description: "Search memories", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" }, scope: { type: "string" } }, required: ["query"] } },
    { name: "memory_store", description: "Store a memory. Disabled unless LOAM_RECALL_MCP_WRITE=1.", inputSchema: { type: "object", properties: { content: { type: "string" }, importance: { type: "number" }, kind: { type: "string" }, tags: { type: "array" } }, required: ["content"] } },
    { name: "memory_temporal", description: "Memories in a time range", inputSchema: { type: "object", properties: { start: { type: "string" }, end: { type: "string" }, range: { type: "string" } } } },
    { name: "memory_forget", description: "Soft-delete a memory", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    { name: "core_memory_get", description: "Read core memory blocks", inputSchema: { type: "object", properties: { scope: { type: "string" } } } },
  ];
}

function rangeOf(name: string, now = Date.now()): { since: number; until: number } | null {
  const date = new Date(now);
  const startOfDay = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  if (name === "today") return { since: startOfDay, until: now };
  if (name === "thisWeek") return { since: now - 7 * 86400000, until: now };
  if (name === "lastWeek") return { since: now - 14 * 86400000, until: now - 7 * 86400000 };
  if (name === "thisMonth") return { since: now - 30 * 86400000, until: now };
  return null;
}

export async function handleRecallRpc(service: RecallService, request: RpcRequest): Promise<unknown> {
  const method = request.method ?? "";
  const params = request.params ?? {};
  if (method === "initialize") {
    return { protocolVersion: "2024-11-05", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "loam-recall", version: "1.0.0" } };
  }
  if (method === "tools/list") return { tools: toolList() };
  if (method === "resources/list") {
    return { resources: [{ uri: "loam-recall://core/user", name: "Core memory", mimeType: "text/markdown" }] };
  }
  if (method === "resources/read") {
    const uri = String(params.uri ?? "");
    const scope = uri.split("/").pop() || "user";
    if (scope === LEGAL_SCOPE && !SHOW_LEGAL) return { contents: [{ uri, mimeType: "text/markdown", text: "" }] };
    const core = await service.core.get(scope);
    const text = [`# User`, ...core.user, `# Environment`, ...core.environment].join("\n");
    return { contents: [{ uri, mimeType: "text/markdown", text }] };
  }
  if (method !== "tools/call") throw new Error(`unknown method ${method}`);
  const name = String(params.name ?? "");
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  if (name === "memory_recall") {
    const scope = typeof args.scope === "string" ? [args.scope] : ["user"];
    const hits = await service.search({
      text: String(args.query ?? ""),
      scope: scope.filter((item) => SHOW_LEGAL || item !== LEGAL_SCOPE),
      limit: typeof args.limit === "number" ? args.limit : 10,
      allowLegal: SHOW_LEGAL,
    });
    const visible = hits.filter((hit) => SHOW_LEGAL || hit.memory.scope !== LEGAL_SCOPE);
    return { content: [{ type: "text", text: visible.map((hit) => hit.memory.content).join("\n") }], structuredContent: visible };
  }
  if (name === "memory_store") {
    if (!WRITE) return { content: [{ type: "text", text: "writes disabled" }], isError: true };
    const result = await service.remember({
      content: String(args.content ?? ""),
      scope: "user",
      origin: "mcp",
      ...(typeof args.importance === "number" ? { importance: args.importance } : {}),
      ...(typeof args.kind === "string" ? { kind: args.kind as "fact" } : {}),
      tags: Array.isArray(args.tags) ? args.tags.filter((tag): tag is string => typeof tag === "string") : [],
    });
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  }
  if (name === "memory_temporal") {
    const named = typeof args.range === "string" ? rangeOf(args.range) : null;
    const since = named?.since ?? Date.parse(String(args.start ?? ""));
    const until = named?.until ?? Date.parse(String(args.end ?? ""));
    const rows = await service.temporal({
      since: Number.isFinite(since) ? since : 0,
      until: Number.isFinite(until) ? until : Date.now(),
    });
    const visible = rows.filter((row) => SHOW_LEGAL || row.scope !== LEGAL_SCOPE);
    return { content: [{ type: "text", text: visible.map((row) => row.content).join("\n") }], structuredContent: visible };
  }
  if (name === "memory_forget") {
    await service.forget(String(args.id ?? ""), "soft");
    return { content: [{ type: "text", text: "trashed" }] };
  }
  if (name === "core_memory_get") {
    const scope = String(args.scope ?? "user");
    if (scope === LEGAL_SCOPE && !SHOW_LEGAL) return { content: [{ type: "text", text: "" }] };
    const core = await service.core.get(scope);
    return { content: [{ type: "text", text: JSON.stringify(core) }], structuredContent: core };
  }
  throw new Error(`unknown tool ${name}`);
}

export function serveRecall(service: RecallService, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): readline.Interface {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    void (async () => {
      let request: RpcRequest;
      try { request = JSON.parse(trimmed) as RpcRequest; }
      catch { output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`); return; }
      if (request.id === undefined || request.id === null) return;
      try {
        const result = await handleRecallRpc(service, request);
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
      } catch (error) {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } })}\n`);
      }
    })();
  });
  return rl;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isDirectRun()) {
  const file = dbPath(process.argv);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = openRecallFile(file);
  const service = createRecallService(db);
  serveRecall(service, process.stdin, process.stdout);
}
