import http from "node:http";
import type { McpServerConfig } from "../../config.js";
import type { McpToolset } from "../../tools/mcp.js";
import { publicMcpServerConfig, readMcpServers, removeMcpServer, upsertMcpServer } from "../mcpConfig.js";

interface McpRouteContext {
  mcp: McpToolset | null;
  reloadMcp?: (servers: Record<string, McpServerConfig>) => Promise<McpToolset | null>;
  readBody(req: http.IncomingMessage, maxBytes?: number): Promise<unknown>;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

export async function handleMcpServerRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  ctx: McpRouteContext,
): Promise<boolean> {
  if (!p.startsWith("/api/mcp/servers")) return false;
  const refresh = async (): Promise<McpToolset | null> => {
    if (!ctx.reloadMcp) throw new Error("MCP reload is unavailable");
    return ctx.reloadMcp(readMcpServers());
  };
  const status = async (name: string) => {
    const rows = ctx.mcp ? await ctx.mcp.status() : [];
    return rows.find((row) => row.name === name) ?? { name, connected: false, toolCount: 0 };
  };

  if (p === "/api/mcp/servers" && req.method === "GET") {
    const configs = readMcpServers();
    const runtime = ctx.mcp ? await ctx.mcp.status() : [];
    sendJson(res, 200, {
      servers: Object.entries(configs).map(([name, config]) => ({
        ...publicMcpServerConfig(config),
        name,
        accountName: config.accountName ?? name,
        runtime: runtime.find((row) => row.name === name) ?? { connected: false, toolCount: 0 },
      })),
    });
    return true;
  }

  if (p === "/api/mcp/servers" && req.method === "POST") {
    try {
      const body = await ctx.readBody(req, 128_000) as { name?: unknown; config?: unknown };
      if (typeof body.name !== "string" || !body.name.trim()) return sendJson(res, 400, { error: "name is required" }), true;
      if (readMcpServers()[body.name]) return sendJson(res, 409, { error: "MCP server already exists" }), true;
      const config = upsertMcpServer(body.name.trim(), body.config);
      ctx.mcp = await refresh();
      sendJson(res, 201, { server: { ...publicMcpServerConfig(config), name: body.name.trim(), runtime: await status(body.name.trim()) } });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  const match = /^\/api\/mcp\/servers\/([^/]+)(?:\/(tools|call))?$/.exec(p);
  if (!match) return false;
  const name = decodeURIComponent(match[1]!);
  const action = match[2];
  const existing = readMcpServers()[name];
  if (!existing) {
    sendJson(res, 404, { error: "MCP server not found" });
    return true;
  }

  if (!action && req.method === "PUT") {
    try {
      const body = await ctx.readBody(req, 128_000) as { config?: unknown };
      const input = body.config && typeof body.config === "object" && !Array.isArray(body.config)
        ? { ...existing, ...body.config as Record<string, unknown> }
        : body.config;
      const config = upsertMcpServer(name, input);
      ctx.mcp = await refresh();
      sendJson(res, 200, { server: { ...publicMcpServerConfig(config), name, runtime: await status(name) } });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (!action && req.method === "DELETE") {
    removeMcpServer(name);
    ctx.mcp = await refresh();
    sendJson(res, 200, { deleted: true });
    return true;
  }

  if (action === "tools" && req.method === "GET") {
    const tools = ctx.mcp ? await ctx.mcp.listTools(name) : [];
    sendJson(res, 200, { tools, disabledTools: existing.disabledTools ?? [] });
    return true;
  }

  if (action === "tools" && req.method === "PUT") {
    try {
      const body = await ctx.readBody(req, 64_000) as { disabledTools?: unknown };
      if (!Array.isArray(body.disabledTools) || body.disabledTools.some((item) => typeof item !== "string")) {
        sendJson(res, 400, { error: "disabledTools must be a string array" });
        return true;
      }
      const config = upsertMcpServer(name, { ...existing, disabledTools: body.disabledTools });
      ctx.mcp = await refresh();
      sendJson(res, 200, { disabledTools: config.disabledTools ?? [] });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (action === "call" && req.method === "POST") {
    if (!ctx.mcp) {
      sendJson(res, 503, { error: "MCP is unavailable" });
      return true;
    }
    const body = await ctx.readBody(req, 128_000) as { tool?: unknown; args?: unknown };
    if (typeof body.tool !== "string" || !body.tool.trim()) {
      sendJson(res, 400, { error: "tool is required" });
      return true;
    }
    const args = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args as Record<string, unknown> : {};
    const result = await ctx.mcp.callTool(name, body.tool, args);
    sendJson(res, result.ok ? 200 : 502, { result });
    return true;
  }

  sendJson(res, 405, { error: "method not allowed" });
  return true;
}
