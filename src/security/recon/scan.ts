import type { RawFinding } from "../normalize/types.js";
import { toSecurityFindings } from "../normalize/funnel.js";
import type { SecurityFinding } from "../findings.js";
import { assertAuthorizedScope, ScopeError, type ScopeGrant } from "./scope.js";
import { httpxToFindings, type HttpxProbe } from "./httpx.js";
import { subfinderToFindings } from "./subfinder.js";

export interface ReconScanOptions {
  enabled: boolean;
  grants?: ScopeGrant[];
  probes?: HttpxProbe[];
  subdomains?: string[];
}

export interface ReconScanResult {
  findings: SecurityFinding[];
  refused: string[];
  dropped: number;
}

/** Scope-gated recon funnel over the live assertAuthorizedScope gate (loopback-only unless granted). */
export function reconScan(opt: ReconScanOptions): ReconScanResult {
  if (!opt.enabled) return { findings: [], refused: ["recon_disabled"], dropped: 0 };
  const refused: string[] = [];
  for (const p of opt.probes ?? []) {
    try { assertAuthorizedScope(p.url, opt.grants ?? []); } catch (e) { if (e instanceof ScopeError) { refused.push(p.url); continue; } throw e; }
  }
  const raw: RawFinding[] = [
    ...httpxToFindings(opt.probes ?? []),
    ...subfinderToFindings(opt.subdomains ?? []),
  ];
  return { findings: toSecurityFindings(raw), refused, dropped: 0 };
}

export { assertAuthorizedScope, ScopeError };
export type { ScopeGrant };
