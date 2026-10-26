/**
 * Mobile security (ALL_SERVICES §13). Behind security.mobile.enabled=false (OD-M-A7).
 */
import type { RawFinding } from "../normalize/types.js";

export interface MobsfIssue {
  title: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  file?: string;
  description?: string;
  ruleId?: string;
}

export function mobsfToFindings(issues: MobsfIssue[], apk = "app.apk"): RawFinding[] {
  return issues.map((i) => ({
    engine: "mobile" as const,
    ruleId: i.ruleId ?? "mobsf.issue",
    severity: i.severity,
    target: i.file ? `${apk}:${i.file}` : apk,
    title: i.title,
    detail: i.description ?? "",
    remediation: "Review with the mobile security checklist before release.",
  }));
}

export interface MobileScanOptions {
  enabled: boolean;
  issues?: MobsfIssue[];
}

export function mobileScan(opt: MobileScanOptions): RawFinding[] {
  if (!opt.enabled) return [];
  return mobsfToFindings(opt.issues ?? []);
}
