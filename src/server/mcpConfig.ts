import fs from "node:fs";
import path from "node:path";
import { ROOT, type McpServerConfig } from "../config.js";

function configPath(): string {
  return process.env.LOAM_CONFIG ?? process.env.MANUS_LOCAL_CONFIG ?? path.join(ROOT, "config.json");
}

function readDocument(): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function writeDocument(document: Record<string, unknown>): void {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(document, null, 2), "utf8");
  fs.renameSync(temp, file);
}

export function readMcpServers(): Record<string, McpServerConfig> {
  const raw = readDocument().mcpServers;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, McpServerConfig> : {};
}

function stringList(value: unknown, cap = 200): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim().slice(0, 120)).slice(0, cap);
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 100);
  const out: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (typeof item === "string") out[key.slice(0, 120)] = item.slice(0, 8000);
  }
  return out;
}

export function sanitizeMcpServerConfig(input: unknown): McpServerConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("MCP config must be an object");
  const raw = input as Record<string, unknown>;
  const transport = raw.transport === "http" ? "http" : raw.transport === "stdio" ? "stdio" : undefined;
  const url = typeof raw.url === "string" && raw.url.trim() ? raw.url.trim() : undefined;
  const command = typeof raw.command === "string" && raw.command.trim() ? raw.command.trim() : undefined;
  if (transport === "http" || url) {
    if (!url) throw new Error("HTTP MCP requires url");
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("MCP URL must use HTTP(S)");
  } else if (!command) {
    throw new Error("stdio MCP requires command");
  }
  const timeout = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 600_000) : undefined;
  const config: McpServerConfig = {
    ...(transport ? { transport } : {}),
    ...(command ? { command } : {}),
    ...(url ? { url } : {}),
    ...(typeof raw.preset === "string" && raw.preset.trim() ? { preset: raw.preset.trim().slice(0, 80) } : {}),
    ...(stringList(raw.args) ? { args: stringList(raw.args) } : {}),
    ...(stringMap(raw.headers) ? { headers: stringMap(raw.headers) } : {}),
    ...(stringMap(raw.env) ? { env: stringMap(raw.env) } : {}),
    ...(stringList(raw.allowlist) ? { allowlist: stringList(raw.allowlist) } : {}),
    ...(stringList(raw.disabledTools) ? { disabledTools: stringList(raw.disabledTools) } : {}),
    ...(raw.envMode === "minimal" || raw.envMode === "inherit" ? { envMode: raw.envMode } : {}),
    ...(timeout(raw.defaultTimeoutMs) ? { defaultTimeoutMs: timeout(raw.defaultTimeoutMs) } : {}),
    ...(typeof raw.sandbox === "boolean" ? { sandbox: raw.sandbox } : {}),
    ...(typeof raw.lazy === "boolean" ? { lazy: raw.lazy } : {}),
    ...(typeof raw.accountName === "string" && raw.accountName.trim() ? { accountName: raw.accountName.trim().slice(0, 120) } : {}),
    ...(typeof raw.customInstructions === "string" && raw.customInstructions.trim() ? { customInstructions: raw.customInstructions.trim().slice(0, 8000) } : {}),
    ...(typeof raw.servicePackId === "string" && raw.servicePackId.trim() ? { servicePackId: raw.servicePackId.trim().slice(0, 80) } : {}),
  };
  if (raw.toolTimeouts && typeof raw.toolTimeouts === "object" && !Array.isArray(raw.toolTimeouts)) {
    const entries = Object.entries(raw.toolTimeouts as Record<string, unknown>).slice(0, 200);
    const timeouts: Record<string, number> = {};
    for (const [name, value] of entries) {
      const valid = timeout(value);
      if (valid) timeouts[name.slice(0, 120)] = valid;
    }
    if (Object.keys(timeouts).length > 0) config.toolTimeouts = timeouts;
  }
  return config;
}

export function publicMcpServerConfig(config: McpServerConfig): McpServerConfig & { headerNames: string[]; envNames: string[] } {
  const { headers, env, ...safe } = config;
  return {
    ...safe,
    headerNames: Object.keys(headers ?? {}),
    envNames: Object.keys(env ?? {}),
  };
}

export function upsertMcpServer(name: string, input: unknown): McpServerConfig {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(name)) throw new Error("Invalid MCP server name");
  const config = sanitizeMcpServerConfig(input);
  const document = readDocument();
  const servers = readMcpServers();
  servers[name] = config;
  document.mcpServers = servers;
  writeDocument(document);
  return config;
}

export function removeMcpServer(name: string): boolean {
  const document = readDocument();
  const servers = readMcpServers();
  if (!servers[name]) return false;
  delete servers[name];
  document.mcpServers = servers;
  writeDocument(document);
  return true;
}
