/**
 * RawFinding[] → PentestFinding → enrichFinding() → SecurityFinding[] → sarif().
 * The one funnel every scanner lands in (ALL_SERVICES §3.3): ruleId is namespaced
 * `${engine}:${ruleId}` so distinct engines never collide in the SARIF rules table.
 */
import { enrichFinding, sarif } from "../findings.js";
import type { SecurityFinding } from "../findings.js";
import type { RawFinding } from "./types.js";

const toPentestFinding = (r: RawFinding) => ({
  id: "",
  check: `${r.engine}:${r.ruleId}`,
  verdict: r.severity === "info" ? ("info" as const) : ("finding" as const),
  severity: r.severity,
  title: r.title,
  target: r.target,
  detail: r.detail,
  ...(r.remediation ? { remediation: r.remediation } : {}),
});

export function toSecurityFindings(raws: RawFinding[]): SecurityFinding[] {
  return raws.map((r) => enrichFinding(toPentestFinding(r), []));
}

export function toSarif(raws: RawFinding[]): ReturnType<typeof sarif> {
  return sarif(toSecurityFindings(raws));
}
