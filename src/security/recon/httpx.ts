import type { RawFinding } from "../normalize/types.js";
import { assertAuthorizedScope, ScopeError } from "./scope.js";

export interface HttpxProbe {
  url: string;
  status?: number;
  title?: string;
  tech?: string[];
}

/** Convert httpx-like probe rows into RawFinding[]. Scope-gated. */
export function httpxToFindings(probes: HttpxProbe[]): RawFinding[] {
  const out: RawFinding[] = [];
  for (const p of probes) {
    try { assertAuthorizedScope(p.url); } catch (e) { if (e instanceof ScopeError) continue; throw e; }
    if (p.status && p.status >= 500) {
      out.push({
        engine: "recon",
        ruleId: "recon.http-5xx",
        severity: "low",
        target: p.url,
        title: `HTTP ${p.status} on in-scope host`,
        detail: p.title ?? "",
        properties: { tech: p.tech ?? [] },
      });
    }
    if ((p.tech ?? []).some((t) => /phpmyadmin|wordpress|jenkins/i.test(t))) {
      out.push({
        engine: "recon",
        ruleId: "recon.interesting-tech",
        severity: "info",
        target: p.url,
        title: `Interesting technology fingerprint: ${(p.tech ?? []).join(", ")}`,
        detail: "Fingerprint only — not a vulnerability.",
      });
    }
  }
  return out;
}
