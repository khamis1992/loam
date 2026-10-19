import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ROOT, type McpServerConfig } from "../config.js";
import { log } from "../log.js";
import type { ToolRegistry, ToolResult } from "./registry.js";

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

/** Expand ${ROOT} and ${WORKSPACE} placeholders so config.json can point at local node_modules. */
function expand(value: string, workspace: string): string {
  return value.replace(/\$\{ROOT\}/g, ROOT).replace(/\$\{WORKSPACE\}/g, workspace);
}

function toResult(res: { content?: Array<{ type?: string; text?: string }>; isError?: boolean }): ToolResult {
  const text = (res.content ?? [])
    .map((c) => (c.type === "text" ? (c.text ?? "") : JSON.stringify(c)))
    .join("\n")
    .trim();
  return { ok: res.isError !== true, content: text || "(no content)" };
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

  const callToolOn = async (
    client: Client,
    server: string,
    tool: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<ToolResult> => {
    try {
      const res = (await client.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutMs })) as {
        content?: Array<{ type?: string; text?: string }>;
        isError?: boolean;
      };
      return toResult(res);
    } catch (err) {
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
      const toolNames = tools.map((tool) => `mcp__${name}__${tool.name}`);
      if (new Set(toolNames).size !== toolNames.length || toolNames.some((toolName) => registry.get(toolName))) {
        throw new Error("MCP returned duplicate tool names");
      }
      for (const tool of tools) {
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
      counts.set(name, tools.length);
      log.info(`MCP server "${name}": ${tools.length} tools registered`);
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
        try {
          await h.client.close();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
