import type { ReAllowlistEntry } from "./types.js";
import { reToolEffect } from "./allowlist.js";

/** Map REA effects to Loam risk-tier path labels (Design decision Cap B §7). */
export type LoamRiskPath = "read" | "write-workspace-data" | "workspace-write" | "network-external" | "destructive" | "secret";

export function effectToRiskPath(effect: ReAllowlistEntry["effect"]): LoamRiskPath {
  switch (effect) {
    case "read": return "read";
    case "write_workspace": return "write-workspace-data";
    case "exec_script": return "workspace-write";
    case "external": return "network-external";
  }
}

export function classifyReToolCall(toolName: string): LoamRiskPath | "denied" {
  const effect = reToolEffect(toolName);
  if (!effect) return "denied";
  return effectToRiskPath(effect);
}
