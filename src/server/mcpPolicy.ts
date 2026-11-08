import type { McpServerConfig } from "../config.js";
import type { ToolContext } from "../tools/registry.js";
import type { AgentRecord } from "./agents.js";

let resolveMcpAgent: (ctx: ToolContext) => AgentRecord | undefined = () => undefined;

export function setMcpAgentResolver(resolver: (ctx: ToolContext) => AgentRecord | undefined): void {
  resolveMcpAgent = resolver;
}

function agentFor(ctx: ToolContext): AgentRecord | undefined {
  return resolveMcpAgent(ctx);
}

export function hasExplicitMcpGrant(ctx: ToolContext, server: string): boolean {
  const agent = agentFor(ctx);
  if (!agent || agent.archivedAt) return false;
  return (agent.connectorGrants ?? []).some((grant) => grant.connectorId === server && grant.permissions.length > 0);
}

export function isMcpExecutionAllowed(ctx: ToolContext, server: string): boolean {
  const agent = agentFor(ctx);
  if (!agent) return true;
  if (agent.archivedAt) return false;
  if (agent.workMode === "own_device") {
    const config = ctx.cfg.mcpServers[server];
    if (config?.transport !== "http" && !config?.url) return false;
  }
  if (agent.connectorGrants === undefined) return true;
  return hasExplicitMcpGrant(ctx, server);
}

export function filterMcpToolsForWorkMode(
  tools: string[],
  workMode: string | undefined,
  servers: Record<string, McpServerConfig>,
): string[] {
  if (workMode !== "own_device") return tools;
  return tools.filter((name) => {
    if (name === "mcp_call_tool") return false;
    const match = /^mcp__(.+)__[^_]+$/.exec(name);
    if (!match) return true;
    const config = servers[match[1]!];
    return config?.transport === "http" || Boolean(config?.url);
  });
}
