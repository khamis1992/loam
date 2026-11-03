import type { Normalizer, RawFinding } from "../types.js";

/** Adapt opengrep SARIF-like or Loam taint RawFinding[] into the funnel. */
export const sastAdapter: Normalizer = {
  adapt(raw: unknown): RawFinding[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter(isRaw).map((r) => ({ ...r, engine: "sast" as const }));
  },
};

function isRaw(x: unknown): x is RawFinding {
  return !!x && typeof x === "object" && typeof (x as RawFinding).ruleId === "string";
}
