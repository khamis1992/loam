import { score, type BenchRow, type BenchScore } from "./score.js";
import { mobsfReportToIssues } from "../mobile/mobsfBridge.js";

export function runMobileParserBenchmark(): BenchScore {
  const cases: Array<{ id: string; report: unknown; expected: BenchRow["expected"]; cwe?: string; fpTrap?: boolean }> = [
    { id: "mob-benign-network-config", expected: "benign", report: { network_security: { summary: "TLS 1.3 enforced; no exported debug endpoint" } }, fpTrap: true },
    { id: "mob-cleartext-traffic", expected: "vulnerable", cwe: "CWE-319", report: { network_security: { findings: [{ title: "Cleartext traffic permitted", severity: "high", description: "HTTP endpoint accepted" }] } } },
    { id: "mob-benign-empty-backup-rule", expected: "benign", report: { manifest: { backup_rules: [{ name: "allowBackup", status: "false" }] } }, fpTrap: true },
    { id: "mob-sensitive-log", expected: "vulnerable", cwe: "CWE-532", report: { code_analysis: { entries: [{ name: "Sensitive data in logs", level: "medium", detail: "Session identifier logged" }] } } },
  ];
  const rows = cases.map((item) => ({ id: item.id, expected: item.expected, actual: mobsfReportToIssues(item.report).length ? "finding" as const : "clean" as const, ...(item.cwe ? { cwe: item.cwe } : {}), ...(item.fpTrap ? { fpTrap: true } : {}) }));
  return score("mobile-independent-parser-fixtures", rows);
}
