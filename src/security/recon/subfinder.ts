import type { RawFinding } from "../normalize/types.js";
import { assertAuthorizedScope, ScopeError } from "./scope.js";

/** Passive subdomain list → findings only for in-scope names. */
export function subfinderToFindings(names: string[]): RawFinding[] {
  return names.flatMap((name) => {
    try { assertAuthorizedScope(name.includes("://") ? name : `https://${name}`); } catch (e) { if (e instanceof ScopeError) return []; throw e; }
    return [{
      engine: "recon" as const,
      ruleId: "recon.subdomain",
      severity: "info" as const,
      target: name,
      title: `In-scope hostname discovered: ${name}`,
      detail: "Passive discovery; no probe performed by this adapter.",
    }];
  });
}
