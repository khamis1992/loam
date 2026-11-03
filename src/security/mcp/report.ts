import type { RawFinding } from "../normalize/types.js";
import { toSecurityFindings } from "../normalize/funnel.js";
import type { SecurityFinding } from "../findings.js";

export interface McpScanReport {
  findings: SecurityFinding[];
  summary: { critical: number; high: number; medium: number; low: number; info: number };
  dropped: number;
}

export function buildMcpReport(raw: RawFinding[]): McpScanReport {
  const findings = toSecurityFindings(raw);
  const summary: McpScanReport["summary"] = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const hit of findings) {
    const sev = (hit.severity ?? "medium") as keyof McpScanReport["summary"];
    if (sev in summary) summary[sev]++;
  }
  return { findings, summary, dropped: 0 };
}
