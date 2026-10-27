import fs from "node:fs";
import path from "node:path";
import { toSarif } from "../normalize/funnel.js";
import { redactText } from "../red/audit.js";
import type { MobileEngagement } from "./engagement.js";
import { MASVS_CONTROLS, masvsSummary } from "./masvs.js";

export function buildMobileReport(state: MobileEngagement, outDir: string): { markdownPath: string; sarifPath: string } {
  fs.mkdirSync(outDir, { recursive: true });
  const summary = masvsSummary(state.coverage);
  const lines = [
    `# Mobile security engagement — ${state.id}`,
    "",
    `- Tenant: ${state.tenantId}`,
    `- Stage: ${state.stage}`,
    `- Findings: ${state.findings.length}`,
    `- MASVS reviewed coverage: ${summary.coveragePercent}% (${summary.covered}/${summary.applicable} applicable controls)`,
    `- Partial: ${summary.partial}; not tested: ${summary.notTested}; not applicable: ${summary.notApplicable}`,
    "",
    "## Artifacts and execution",
    "",
  ];
  for (const artifact of state.artifacts) {
    const scan = state.scans.find((item) => item.artifact.sha256 === artifact.sha256);
    lines.push(`- ${artifact.relativePath} (${artifact.kind}, ${artifact.bytes} bytes)`);
    lines.push(`  - SHA-256: ${artifact.sha256}`);
    lines.push(`  - Engine: ${scan?.engineVersion ?? "not run"}; status: ${scan?.status ?? "not-tested"}${scan?.detail ? ` — ${redactText(scan.detail)}` : ""}`);
    if (scan?.reportSha256) lines.push(`  - Report SHA-256: ${scan.reportSha256}`);
  }
  lines.push("", "## MASVS coverage", "");
  for (const control of MASVS_CONTROLS) {
    const coverage = state.coverage.find((entry) => entry.controlId === control.id)!;
    lines.push(`- ${control.id} — ${control.title}: **${coverage.status}**; ${redactText(coverage.reason)}${coverage.reviewerId ? ` (reviewer: ${coverage.reviewerId})` : ""}`);
  }
  lines.push("", "## Findings", "");
  if (!state.findings.length) lines.push("No findings were produced by the completed scanners. This does not replace manual testing or prove absence of vulnerabilities.");
  state.findings.forEach((finding, index) => {
    lines.push(`### ${index + 1}. [${finding.severity.toUpperCase()}] ${finding.title}`);
    lines.push(`- Rule: ${finding.ruleId}; target: ${finding.target}`);
    lines.push(`- ${redactText(finding.detail)}`);
    lines.push(`- Human review: ${finding.reviewerId ?? "pending"}; retest: ${finding.retest?.status ?? "not run"}`, "");
  });
  lines.push("## Engagement history", "");
  for (const event of state.events) lines.push(`- ${event.at}: ${event.from} → ${event.to} by ${event.actorId}`);
  const markdownPath = path.join(outDir, "mobile-report.md");
  const sarifPath = path.join(outDir, "mobile.sarif.json");
  fs.writeFileSync(markdownPath, lines.join("\n"), "utf8");
  fs.writeFileSync(sarifPath, JSON.stringify(toSarif(state.findings), null, 2), "utf8");
  return { markdownPath, sarifPath };
}
