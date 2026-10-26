import type { Normalizer, RawFinding } from "../types.js";

/** Recon probe rows already shaped as RawFinding[]; re-tag the engine. */
export const reconAdapter: Normalizer = {
  adapt(raw: unknown): RawFinding[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter(isRaw).map((r) => ({ ...r, engine: "recon" as const }));
  },
};

function isRaw(x: unknown): x is RawFinding {
  return !!x && typeof x === "object" && typeof (x as RawFinding).ruleId === "string";
}
