import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { DATA_DIR, ROOT, type McpServerConfig } from "../config.js";
import { log } from "../log.js";
import type { ToolRegistry, ToolResult } from "./registry.js";
import { REA_MCP_SERVER, isReaAllowedTool, reaToolTimeoutMs } from "./reaAllowlist.js";
import { applyReaBudget } from "./reaBudget.js";
import { ReaAuditLog, reaAuditPath } from "./reaAudit.js";
import { CUA_DRIVER_MCP_SERVER, isCuaDriverAllowedTool, cuaDriverTimeoutMs } from "./cuaDriverAllowlist.js";
import { CuaAuditLog, cuaAuditPath, cuaAuditScopes } from "./cuaAudit.js";

interface McpHandle {
  name: string;
  client: Client;
  transport: Transport;
}

export interface McpToolset {
  servers: string[];
  status(): Promise<Array<{ name: string; connected: boolean; toolCount: number; error?: string }>>;
  /** Call a tool on a running MCP server directly (not via the registry) —
   *  used to wire persistent memory into the task loop. */
  callTool(server: string, tool: string, args: Record<string, unknown>, timeoutMs?: number): Promise<ToolResult>;
  close(): Promise<void>;
}

/** Expand ${ROOT}, ${WORKSPACE} and ${DATA} placeholders so config.json can point at
 *  the repo, the task workspace, or the pinned data-dir installs (rea-agents). */
function expand(value: string, workspace: string): string {
  return value.replace(/\$\{ROOT\}/g, ROOT).replace(/\$\{WORKSPACE\}/g, workspace).replace(/\$\{DATA\}/g, DATA_DIR);
}

function toResult(res: { content?: Array<{ type?: string; text?: string }>; isError?: boolean }): ToolResult {
  const text = (res.content ?? [])
    .map((c) => (c.type === "text" ? (c.text ?? "") : JSON.stringify(c)))
    .join("\n")
    .trim();
  return { ok: res.isError !== true, content: text || "(no content)" };
}

/** REA post-processing (REA_INTO_LOAM §7–§9): the catalogue is never trusted, every
 *  result is untrusted target data under the summary-first budget, and calls land
 *  in the append-only audit log. Unknown-to-Loam rea tools never execute. */
const isReaServer = (server: string): boolean => server === REA_MCP_SERVER;

function reaPostProcess(server: string, tool: string, args: Record<string, unknown>, result: ToolResult, audit: ReaAuditLog | undefined, durationMs: number): ToolResult {
  if (!isReaServer(server)) return result;
  const qualified = `mcp__${server}__${tool}`;
  if (!isReaAllowedTool(tool)) {
    audit?.append({ name: "rea.mcp.call", outcome: "denied", tool, detail: "outside Loam allowlist" });
    return { ok: false, content: `mcp ${server}/${tool} is not in the Loam REA allowlist` };
  }
  const budgeted = result.ok ? applyReaBudget(qualified, result.content) : { content: result.content, truncated: false, originalBytes: Buffer.byteLength(result.content, "utf8") };
  const contentDigest = `sha256_${createHash("sha256").update(result.content, "utf8").digest("hex").slice(0, 32)}`;
  audit?.append({
    name: "rea.mcp.call",
    outcome: result.ok ? "completed" : "failed",
    tool,
    contentDigest,
    bytes: budgeted.originalBytes,
    durationMs,
    detail: budgeted.truncated ? "summary-first truncation applied" : undefined,
  });
  void args;
  return { ...result, content: budgeted.content, untrusted: true, contentDigest };
}

/** Cua Driver post-processing (CUA_INTO_LOAM §6.2–§6.4): the 63-tool live catalogue
 *  (incl. kill_app / run_script / browser_*) is clamped to the 14 contract tools,
 *  every result is untrusted GUI-originated data (prompt-injection surface), and
 *  calls land in the audit log with ids only — never typed text or screenshots. */
const isCuaDriverServer = (server: string): boolean => server === CUA_DRIVER_MCP_SERVER;

function cuaPostProcess(server: string, tool: string, args: Record<string, unknown>, result: ToolResult, audit: CuaAuditLog | undefined, durationMs: number): ToolResult {
  if (!isCuaDriverServer(server)) return result;
  const scopes = cuaAuditScopes(args);
  if (!isCuaDriverAllowedTool(tool)) {
    audit?.append({ name: "cua.driver.allowlist.reject", outcome: "denied", tool, ...scopes });
    return { ok: false, content: `mcp ${server}/${tool} is not in the Loam Cua Driver allowlist` };
  }
  const contentDigest = `sha256_${createHash("sha256").update(result.content, "utf8").digest("hex").slice(0, 32)}`;
  audit?.append({
    name: "cua.driver.call",
    outcome: result.ok ? "completed" : "failed",
    tool,
    ...scopes,
    durationMs,
  });
  return { ...result, untrusted: true, contentDigest };
}

/** Connect configured MCP services and register their namespaced tools. */
export async function registerMcpTools(
  registry: ToolRegistry,
  servers: Record<string, McpServerConfig>,
  workspace: string,
): Promise<McpToolset> {
  const handles: McpHandle[] = [];
  const names = Object.keys(servers);
  const counts = new Map<string, number>();
  const audit = names.some(isReaServer) ? new ReaAuditLog(reaAuditPath(DATA_DIR)) : undefined;
  const cuaAudit = names.some(isCuaDriverServer) ? new CuaAuditLog(cuaAuditPath(DATA_DIR)) : undefined;

  const callToolOn = async (
    client: Client,
    server: string,
    tool: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<ToolResult> => {
    const startedAt = Date.now();
    try {
      const effectiveTimeout = isReaServer(server) ? reaToolTimeoutMs(tool)
        : isCuaDriverServer(server) ? cuaDriverTimeoutMs(tool)
        : timeoutMs;
      const res = (await client.callTool({ name: tool, arguments: args }, undefined, { timeout: effectiveTimeout })) as {
        content?: Array<{ type?: string; text?: string }>;
        isError?: boolean;
      };
      return cuaPostProcess(server, tool, args, reaPostProcess(server, tool, args, toResult(res), audit, Date.now() - startedAt), cuaAudit, Date.now() - startedAt);
    } catch (err) {
      audit?.append({ name: "rea.mcp.call", outcome: "failed", tool, durationMs: Date.now() - startedAt, detail: err instanceof Error ? err.message.slice(0, 160) : undefined });
      cuaAudit?.append({ name: "cua.driver.call", outcome: "failed", tool, ...cuaAuditScopes(args), durationMs: Date.now() - startedAt, detail: err instanceof Error ? err.message.slice(0, 160) : undefined });
      return { ok: false, content: `mcp ${server}/${tool} failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  };

  for (const name of names) {
    const cfg = servers[name];
    if (!cfg) continue;
    let client: Client | undefined;
    let transport: Transport | undefined;
    try {
      const args = (cfg.args ?? []).map((a) => expand(a, workspace));
      const env: Record<string, string> = { ...process.env } as Record<string, string>;
      for (const [k, v] of Object.entries(cfg.env ?? {})) env[k] = expand(v, workspace);

      if (cfg.transport === "http" || cfg.url) {
        if (!cfg.url) throw new Error("HTTP MCP requires url");
        const url = new URL(expand(cfg.url, workspace));
        if (!["http:", "https:"].includes(url.protocol)) throw new Error("MCP URL must use HTTP(S)");
        transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: cfg.headers } });
      } else {
        if (!cfg.command) throw new Error("stdio MCP requires command");
        transport = new StdioClientTransport({ command: cfg.command === "node" ? process.execPath : expand(cfg.command, workspace), args, env, stderr: "pipe" });
        // Drain piped diagnostics: an unread stderr pipe can block a busy child.
        (transport as StdioClientTransport).stderr?.on("data", () => {});
      }
      client = new Client({ name: "loam", version: "0.5.1" }, { capabilities: {} });
      await client.connect(transport, { timeout: 15_000 });
      const connectedClient = client;
      const tools = [];
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      do {
        const listed = await client.listTools(cursor ? { cursor } : {}, { timeout: 15_000 });
        tools.push(...listed.tools);
        cursor = listed.nextCursor;
        if (cursor && seenCursors.has(cursor)) throw new Error("MCP tool pagination repeated a cursor");
        if (cursor) seenCursors.add(cursor);
      } while (cursor);
      // The catalogue is never trusted: an optional per-server allowlist filters it,
      // and the rea server is additionally clamped to the Loam REA allowlist so a
      // compromised catalogue cannot widen the surface (REA_INTO_LOAM §5.4). The
      // cua-driver server gets the same treatment against its 14-tool contract list
      // (CUA_INTO_LOAM §7.4) — the live catalogue advertises 63 tools including
      // kill_app / run_script / browser_* which must never register.
      let visible = tools;
      if (cfg.allowlist) visible = visible.filter((t) => new Set(cfg.allowlist).has(t.name));
      if (isReaServer(name)) visible = visible.filter((t) => isReaAllowedTool(t.name));
      if (isCuaDriverServer(name)) visible = visible.filter((t) => isCuaDriverAllowedTool(t.name));
      const toolNames = visible.map((tool) => `mcp__${name}__${tool.name}`);
      if (new Set(toolNames).size !== toolNames.length || toolNames.some((toolName) => registry.get(toolName))) {
        throw new Error("MCP returned duplicate tool names");
      }
      for (const tool of visible) {
        const toolName = `mcp__${name}__${tool.name}`;
        const inputSchema = (tool.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>;
        registry.register({
          integration: true,
          name: toolName,
          description: `[MCP:${name}] ${tool.description ?? tool.name}`,
          parameters: inputSchema,
          async run(args: Record<string, unknown>): Promise<ToolResult> {
            return callToolOn(connectedClient, name, tool.name, args, 30_000);
          },
        });
      }
      handles.push({ name, client, transport });
      counts.set(name, visible.length);
      if (isReaServer(name)) audit?.append({ name: "rea.mcp.connect", outcome: "completed", tool: "server", detail: `${visible.length}/${tools.length} catalogue tools registered` });
      if (isCuaDriverServer(name)) cuaAudit?.append({ name: "cua.driver.connect", outcome: "completed", detail: `${visible.length}/${tools.length} catalogue tools registered` });
      log.info(`MCP server "${name}": ${visible.length} tools registered${visible.length < tools.length ? ` (${tools.length - visible.length} dropped by allowlist)` : ""}`);
    } catch (err) {
      try { await client?.close(); await transport?.close(); } catch { /* failed startup cleanup */ }
      log.warn(`MCP server "${name}" failed to start: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const byName = new Map(handles.map((h) => [h.name, h]));

  return {
    servers: handles.map((h) => h.name),
    async status() {
      return Promise.all(names.map(async (name) => {
        const handle = byName.get(name);
        if (!handle) return { name, connected: false, toolCount: 0, error: "connection-failed" };
        try {
          await handle.client.ping({ timeout: 3000 });
          let cursor: string | undefined;
          let toolCount = 0;
          const seen = new Set<string>();
          do {
            const listed = await handle.client.listTools(cursor ? { cursor } : {}, { timeout: 3000 });
            toolCount += listed.tools.length;
            cursor = listed.nextCursor;
            if (cursor && (seen.has(cursor) || seen.size >= 128)) throw new Error("Invalid tool pagination");
            if (cursor) seen.add(cursor);
          } while (cursor);
          return { name, connected: toolCount > 0 || !counts.get(name), toolCount };
        }
        catch { return { name, connected: false, toolCount: 0, error: "unreachable" }; }
      }));
    },
    async callTool(server: string, tool: string, args: Record<string, unknown>, timeoutMs = 30_000): Promise<ToolResult> {
      const handle = byName.get(server);
      if (!handle) return { ok: false, content: `mcp server not running: ${server}` };
      return callToolOn(handle.client, server, tool, args, timeoutMs);
    },
    async close(): Promise<void> {
      for (const h of handles) {
        if (isReaServer(h.name)) audit?.append({ name: "rea.mcp.disconnect", outcome: "completed" });
        if (isCuaDriverServer(h.name)) cuaAudit?.append({ name: "cua.driver.disconnect", outcome: "completed" });
        try {
          await h.client.close();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
