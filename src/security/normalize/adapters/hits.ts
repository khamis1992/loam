/**
 * Generic adapter: scanner ReconHit[] (the audit scanner channel's in-process hits)
 * → unified RawFinding[]. Engine routing via ENGINE_BY_TOOL; deterministic hits
 * carry their scanner severity; intel payloads pass through as properties.
 */
import type { ReconHit } from "../../audit/types.js";
import { engineForTool } from "../types.js";
import type { RawFinding } from "../types.js";

export const hitsNormalizer = {
  adapt(raw: unknown): RawFinding[] {
    if (!Array.isArray(raw)) return [];
    const out: RawFinding[] = [];
    for (const item of raw) {
      const h = item as ReconHit;
      if (!h || typeof h.tool !== "string" || !h.ruleId) continue;
      const sev = h.severity === "informational" ? "info" : h.severity;
      out.push({
        engine: engineForTool(h.tool),
        ruleId: h.ruleId,
        severity: sev,
        target: `${h.file}:${h.line}`,
        title: `${h.tool}: ${h.ruleId}`,
        detail: h.message,
        properties: { tool: h.tool, cls: h.cls, raw: h.raw },
      });
    }
    return out;
  },
};
