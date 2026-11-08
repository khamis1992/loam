import http from "node:http";
import type { McpServerConfig } from "../../config.js";
import type { McpToolset } from "../../tools/mcp.js";
import { readMcpServers } from "../mcpConfig.js";
import { installServicePack, SERVICE_PACKS } from "../servicePacks.js";

interface ServicePackContext {
  mcp: McpToolset | null;
  reloadMcp?: (servers: Record<string, McpServerConfig>) => Promise<McpToolset | null>;
  readBody(req: http.IncomingMessage, maxBytes?: number): Promise<unknown>;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

export async function handleServicePackRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  ctx: ServicePackContext,
): Promise<boolean> {
  if (p !== "/api/service-packs") return false;
  if (req.method === "GET") {
    const configs = readMcpServers();
    const runtime = ctx.mcp ? await ctx.mcp.status() : [];
    sendJson(res, 200, {
      platform: process.platform,
      packs: SERVICE_PACKS.map((pack) => ({
        ...pack,
        installed: Object.entries(configs).filter(([, config]) => config.servicePackId === pack.id).map(([name]) => ({
          name,
          runtime: runtime.find((row) => row.name === name) ?? { connected: false, toolCount: 0 },
        })),
      })),
    });
    return true;
  }
  if (req.method === "POST") {
    try {
      const body = await ctx.readBody(req, 128_000) as { id?: unknown; name?: unknown; config?: unknown };
      if (typeof body.id !== "string" || typeof body.name !== "string") return sendJson(res, 400, { error: "id and name are required" }), true;
      const config = installServicePack(body.id, body.name, body.config);
      if (!ctx.reloadMcp) return sendJson(res, 503, { error: "MCP reload is unavailable" }), true;
      ctx.mcp = await ctx.reloadMcp(readMcpServers());
      const runtime = ctx.mcp ? (await ctx.mcp.status()).find((row) => row.name === body.name) : undefined;
      sendJson(res, 201, { server: { name: body.name, servicePackId: config.servicePackId, runtime } });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  sendJson(res, 405, { error: "method not allowed" });
  return true;
}
