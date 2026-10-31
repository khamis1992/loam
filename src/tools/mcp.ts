import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { DATA_DIR, ROOT, type McpServerConfig } from "../config.js";
import { log } from "../log.js";
import { num, str } from "./registry.js";
import type { ToolContext, ToolRegistry, ToolResult } from "./registry.js";
import { REA_MCP_SERVER, isReaAllowedTool, reaToolTimeoutMs } from "./reaAllowlist.js";
import { isAllowedReTool } from "../re/allowlist.js";
import { applyReaBudget } from "./reaBudget.js";
import { ReaAuditLog, reaAuditPath } from "./reaAudit.js";
import { CUA_DRIVER_MCP_SERVER, isCuaDriverAllowedTool, cuaDriverTimeoutMs } from "./cuaDriverAllowlist.js";
import { CuaAuditLog, cuaAuditPath, cuaAuditScopes } from "./cuaAudit.js";
import { wrapMcpCommandForSandbox } from "../sandbox/srt/mcpWrap.js";

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

/** What a `before` hook decides: refuse with a result, replace the arguments, or let the call through. */
export type McpBeforeDecision = { block: ToolResult } | { args: Record<string, unknown> } | undefined;

/** Per-server policy hooks (api-anything §6.3). `before` may refuse or rewrite the
 *  call; `after` may rewrite the result. Hooks run on the registry path only. */
export interface McpServerHooks {
  before?(tool: string, args: Record<string, unknown>, ctx: ToolContext): Promise<McpBeforeDecision> | McpBeforeDecision;
  after?(tool: string, args: Record<string, unknown>, result: ToolResult, ctx: ToolContext, ms: number): Promise<ToolResult> | ToolResult;
}

/** Environment a "minimal" stdio server receives (names compared case-insensitively). */
export const MINIMAL_ENV_KEYS: readonly string[] = [
  // Windows
  "SystemRoot", "windir", "SystemDrive", "PATH", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE",
  "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "ProgramW6432", "ProgramData",
  "USERNAME", "USERDOMAIN", "COMPUTERNAME", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "ComSpec",
  // POSIX development hosts
  "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "XDG_RUNTIME_DIR", "DISPLAY", "WAYLAND_DISPLAY",
  // Packaged Loam: process.execPath is Electron; this makes it behave as Node
  // (set by electron/server-host.cjs).
  "ELECTRON_RUN_AS_NODE",
];

/** Build the child environment: full inheritance by default, or the fixed allowlist
 *  above when `envMode: "minimal"` (api-anything §6.3), then cfg.env layered on top. */
function childEnv(cfg: McpServerConfig, workspace: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (cfg.envMode === "minimal") {
    const allow = new Set(MINIMAL_ENV_KEYS.map((k) => k.toUpperCase()));
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && allow.has(k.toUpperCase())) env[k] = v;
  } else {
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  }
  for (const [k, v] of Object.entries(cfg.env ?? {})) env[k] = expand(v, workspace);
  return env;
}

/** Per-tool timeout: toolTimeouts[tool] beats defaultTimeoutMs beats the 30s default. */
function timeoutFor(cfg: McpServerConfig, tool: string): number {
  const own = cfg.toolTimeouts?.[tool];
  if (typeof own === "number" && Number.isFinite(own) && own > 0) return own;
  const def = cfg.defaultTimeoutMs;
  return typeof def === "number" && Number.isFinite(def) && def > 0 ? def : 30_000;
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
  hooks: Record<string, McpServerHooks> = {},
): Promise<McpToolset> {
  const handles: McpHandle[] = [];
  /** Catalogues of lazy servers, loaded once on first use (name -> tools). */
  const catalog = new Map<string, Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>>();
  const lazyServers = new Set<string>();
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
        : servers[server] ? timeoutFor(servers[server], tool) : timeoutMs;
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
      const env = childEnv(cfg, workspace);

      if (cfg.transport === "http" || cfg.url) {
        if (!cfg.url) throw new Error("HTTP MCP requires url");
        const url = new URL(expand(cfg.url, workspace));
        if (!["http:", "https:"].includes(url.protocol)) throw new Error("MCP URL must use HTTP(S)");
        transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: cfg.headers } });
      } else {
        if (!cfg.command) throw new Error("stdio MCP requires command");
        // Opt-in OS sandbox (SANDBOX_RUNTIME §7.2, appendix C4): servers configured
        // with `"sandbox": true` spawn as `node srt --settings … -- <original>` while
        // the command sandbox mode is on. Loopback-dependent servers stay unwrapped.
        const wrapped = wrapMcpCommandForSandbox({ command: cfg.command, args, sandbox: cfg.sandbox }, workspace);
        const stdioCommand = wrapped ? wrapped.command : (cfg.command === "node" ? process.execPath : expand(cfg.command, workspace));
        const stdioArgs = wrapped ? wrapped.args : args;
        transport = new StdioClientTransport({ command: stdioCommand, args: stdioArgs, env, stderr: "pipe" });
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
      // Cap B (MISSING §5): the rea server is also clamped to the 15 engine-free
      // names the reverse-engineer mode reads from src/re/allowlist.ts.
      if (isReaServer(name)) visible = visible.filter((t) => isAllowedReTool(t.name));
      if (isCuaDriverServer(name)) visible = visible.filter((t) => isCuaDriverAllowedTool(t.name));
      const toolNames = visible.map((tool) => `mcp__${name}__${tool.name}`);
      if (new Set(toolNames).size !== toolNames.length || toolNames.some((toolName) => registry.get(toolName))) {
        throw new Error("MCP returned duplicate tool names");
      }
      // Lazy server: keep the catalogue aside instead of putting ~N tool schemas
      // in every prompt. The four mcp_* bridge tools reach these by name.
      if (cfg.lazy) {
        catalog.set(name, visible.map((tool) => ({
          name: tool.name,
          description: tool.description ?? tool.name,
          inputSchema: (tool.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
        })));
        handles.push({ name, client, transport });
        counts.set(name, visible.length);
        lazyServers.add(name);
        log.info(`MCP server "${name}": ${visible.length} tools held lazily (no schemas registered)`);
        continue;
      }
      const serverHooks = hooks[name];
      for (const tool of visible) {
        const toolName = `mcp__${name}__${tool.name}`;
        const inputSchema = (tool.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>;
        const timeoutMs = timeoutFor(cfg, tool.name);
        registry.register({
          integration: true,
          name: toolName,
          description: `[MCP:${name}] ${tool.description ?? tool.name}`,
          parameters: inputSchema,
          async run(callArgs: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
            const decision = serverHooks?.before ? await serverHooks.before(tool.name, callArgs, ctx) : undefined;
            if (decision && "block" in decision) return decision.block;
            const sendArgs = decision && "args" in decision ? decision.args : callArgs;
            const started = Date.now();
            const result = await callToolOn(connectedClient, name, tool.name, sendArgs, timeoutMs);
            return serverHooks?.after ? serverHooks.after(tool.name, sendArgs, result, ctx, Date.now() - started) : result;
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

  /** Load a lazy server's catalogue on first use; `rea`/`cua` keep their allowlists. */
  const ensureCatalog = async (server: string): Promise<void> => {
    if (catalog.has(server)) return;
    const handle = byName.get(server);
    if (!handle) return;
    const listed: Array<{ name: string; description?: string; inputSchema?: unknown }> = [];
    let cursor: string | undefined;
    do {
      const page = await handle.client.listTools(cursor ? { cursor } : {}, { timeout: 15_000 });
      listed.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    const cfg = servers[server];
    let visible = listed;
    if (cfg?.allowlist) visible = visible.filter((t) => new Set(cfg.allowlist).has(t.name));
    if (isReaServer(server)) visible = visible.filter((t) => isReaAllowedTool(t.name) && isAllowedReTool(t.name));
    if (isCuaDriverServer(server)) visible = visible.filter((t) => isCuaDriverAllowedTool(t.name));
    catalog.set(server, visible.map((t) => ({
      name: t.name,
      description: t.description ?? t.name,
      inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
    })));
  };

  // Bridge tools are only useful when at least one server is lazy; registering
  // them otherwise would add schemas for no gain.
  if (lazyServers.size > 0) {
    registry.registerAll([
      {
        integration: true,
        name: "mcp_list_servers",
        description: "List the connected MCP servers, whether each is lazy (schemas held out of the prompt) and how many tools it exposes. Start here before mcp_search_tools.",
        parameters: { type: "object", properties: {} },
        async run(): Promise<ToolResult> {
          const rows = [...byName.keys()].map((name) => ({
            server: name,
            lazy: lazyServers.has(name),
            tools: lazyServers.has(name) ? catalog.get(name)?.length ?? "unloaded" : counts.get(name) ?? 0,
          }));
          return { ok: true, content: rows.length ? JSON.stringify(rows, null, 2) : "(no MCP servers connected)" };
        },
      },
      {
        integration: true,
        name: "mcp_search_tools",
        description: "Search the tools of connected MCP servers by name/description substring and return the matches (server + tool + summary). Catalogues load on first use, so the prompt only ever carries the tools you actually reach for.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Substring to match; empty lists everything." },
            server: { type: "string", description: "Limit to one server." },
            limit: { type: "number", description: "Max matches (default 25)." },
          },
        },
        async run(args: Record<string, unknown>): Promise<ToolResult> {
          const query = str(args, "query").toLowerCase();
          const only = str(args, "server");
          const limit = Math.min(50, Math.max(1, Math.floor(num(args, "limit", 25))));
          const targets = only ? [only] : [...byName.keys()];
          const hits: Array<{ server: string; tool: string; description: string }> = [];
          for (const server of targets) {
            await ensureCatalog(server);
            for (const tool of catalog.get(server) ?? []) {
              if (query && !`${tool.name} ${tool.description}`.toLowerCase().includes(query)) continue;
              hits.push({ server, tool: tool.name, description: tool.description.slice(0, 160) });
              if (hits.length >= limit) break;
            }
            if (hits.length >= limit) break;
          }
          return {
            ok: true,
            content: hits.length
              ? `${hits.length} matches (use mcp_tool_schema, then mcp_call_tool):\n${hits.map((h) => `${h.server}/${h.tool} — ${h.description}`).join("\n")}`
              : "(no matching MCP tools)",
          };
        },
      },
      {
        integration: true,
        name: "mcp_tool_schema",
        description: "Return the JSON input schema of one MCP tool before calling it.",
        parameters: {
          type: "object",
          properties: { server: { type: "string" }, tool: { type: "string" } },
          required: ["server", "tool"],
        },
        async run(args: Record<string, unknown>): Promise<ToolResult> {
          const server = str(args, "server");
          await ensureCatalog(server);
          const tool = (catalog.get(server) ?? []).find((t) => t.name === str(args, "tool"));
          if (!tool) return { ok: false, content: `no tool ${str(args, "tool")} on ${server}` };
          return { ok: true, content: JSON.stringify({ server, tool: tool.name, description: tool.description, inputSchema: tool.inputSchema }, null, 2) };
        },
      },
      {
        integration: true,
        name: "mcp_call_tool",
        description: "Call a tool on a connected MCP server by name (the lazy path: it works even when the tool's schema was never registered). Policy hooks and the rea/cua allowlists still apply.",
        parameters: {
          type: "object",
          properties: {
            server: { type: "string" },
            tool: { type: "string" },
            args: { type: "object", description: "Tool arguments matching mcp_tool_schema." },
          },
          required: ["server", "tool"],
        },
        async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
          const server = str(args, "server");
          const tool = str(args, "tool");
          const handle = byName.get(server);
          if (!handle) return { ok: false, content: `mcp server not running: ${server}` };
          const callArgs = args["args"] && typeof args["args"] === "object" ? args["args"] as Record<string, unknown> : {};
          const hooksForServer = hooks[server];
          const decision = hooksForServer?.before ? await hooksForServer.before(tool, callArgs, ctx) : undefined;
          if (decision && "block" in decision) return decision.block;
          const sendArgs = decision && "args" in decision ? decision.args : callArgs;
          const started = Date.now();
          const result = await callToolOn(handle.client, server, tool, sendArgs, 30_000);
          return hooksForServer?.after ? hooksForServer.after(tool, sendArgs, result, ctx, Date.now() - started) : result;
        },
      },
    ]);
  }

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
