import type { ToolRegistry } from "../tools/registry.js";
import { getPackManifest, PACK_BASE_TOOLS } from "./registry.js";
import type { PackId } from "./types.js";

export interface PackLoadOptions {
  includeWrapped?: boolean;
}

export function packToolNames(id: PackId, allowedTools: readonly string[], options: PackLoadOptions = {}): string[] {
  const manifest = getPackManifest(id);
  const allowed = new Set(allowedTools);
  const shared = id === "loam-schedule" ? [...allowed] : PACK_BASE_TOOLS.filter((name) => allowed.has(name));
  const includeWrapped = options.includeWrapped ?? manifest.ownedTools.length === 0;
  const wrapped = includeWrapped ? manifest.wrappedTools.filter((name) => allowed.has(name)) : [];
  return [...new Set([...shared, ...manifest.ownedTools, ...wrapped])];
}

export function toolsForPack(tools: ToolRegistry, id: PackId, allowedTools: readonly string[], options: PackLoadOptions = {}): ToolRegistry {
  return tools.forAllowlist(packToolNames(id, allowedTools, options));
}
