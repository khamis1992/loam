import type { Normalizer, RawFinding } from "../types.js";

/** MCP surface-scan findings re-tagged for the funnel. */
export const mcpAdapter: Normalizer = {
  adapt(raw: unknown): RawFinding[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter(isRaw).map((r) => ({ ...r, engine: "mcp" as const }));
  },
};

function isRaw(x: unknown): x is RawFinding {
  return !!x && typeof x === "object" && typeof (x as RawFinding).ruleId === "string";
}
