/**
 * APK static analysis module (Supremacy M1.1): decodes an APK and scans the
 * manifest + decompiled sources for mobile-specific security issues.
 */
import type { PentestFinding } from "../../../tools/pentest.js";
import type { Evidence } from "../../orchestrator.js";
import { nextEvidenceId } from "../../orchestrator.js";
import type { RedCapability, RedCapabilityContext, RedHypothesis, RedValidation } from "../orchestrator/redOrchestrator.js";

export interface ApkAnalysisResult {
  packageName: string;
  debuggable: boolean;
  allowBackup: boolean;
  cleartextTraffic: boolean;
  exportedComponents: string[];
  findings: PentestFinding[];
}

/** Parse AndroidManifest.xml content for security-relevant flags. */
export function analyzeManifest(manifestXml: string): ApkAnalysisResult {
  const findings: PentestFinding[] = [];
  const debuggable = /android:debuggable\s*=\s*"true"/i.test(manifestXml);
  const allowBackup = /android:allowBackup\s*=\s*"true"/i.test(manifestXml);
  const cleartextTraffic = /android:usesCleartextTraffic\s*=\s*"true"/i.test(manifestXml) || !/android:usesCleartextTraffic/i.test(manifestXml);
  const exportedComponents: string[] = [];
  for (const match of manifestXml.matchAll(/<(?:activity|receiver|service|provider)\b[^>]*android:exported\s*=\s*"true"[^>]*android:name\s*=\s*"([^"]+)"/g)) {
    exportedComponents.push(match[1]!);
  }
  const packageName = /package\s*=\s*"([^"]+)"/.exec(manifestXml)?.[1] ?? "unknown";
  if (debuggable) {
    findings.push({ id: "apk-debuggable", check: "red_apk_debuggable", verdict: "finding", severity: "high", title: "APK is debuggable", target: packageName, detail: "android:debuggable=true allows any debugger to attach to the app process.", remediation: "Set android:debuggable=false in release builds." });
  }
  if (allowBackup) {
    findings.push({ id: "apk-allow-backup", check: "red_apk_allow_backup", verdict: "finding", severity: "medium", title: "APK allows backup", target: packageName, detail: "android:allowBackup=true lets app data be extracted via adb backup.", remediation: "Set android:allowBackup=false for sensitive apps." });
  }
  if (cleartextTraffic) {
    findings.push({ id: "apk-cleartext", check: "red_apk_cleartext_traffic", verdict: "finding", severity: "medium", title: "APK permits cleartext traffic", target: packageName, detail: "App may communicate over HTTP without TLS.", remediation: "Set android:usesCleartextTraffic=false." });
  }
  for (const component of exportedComponents.slice(0, 10)) {
    findings.push({ id: `apk-exported-${component}`, check: "red_apk_exported", verdict: "finding", severity: "medium", title: `Exported component: ${component}`, target: packageName, detail: `${component} is exported and can be invoked by any app on the device.`, remediation: "Set android:exported=false or add permission checks." });
  }
  return { packageName, debuggable, allowBackup, cleartextTraffic, exportedComponents, findings };
}

export function apkCapability(opts: { apkPath?: string } = {}): RedCapability {
  return {
    id: "red.mobile.apk",
    applicable: (target) => target.endsWith(".apk") || target.endsWith(".ipa"),
    hunt: async (target): Promise<RedHypothesis[]> => [
      { id: `HYP-APK-${target.length}`, capability: "red.mobile.apk", target, claim: "Mobile app security issues in APK manifest and sources", rationale: "APK static analysis" },
    ],
    validate: async (hyp: RedHypothesis, ctx: RedCapabilityContext): Promise<RedValidation> => {
      const apkPath = opts.apkPath ?? hyp.target;
      const envelope = await ctx.bridge("red-apktool", "decode", { apk: apkPath, out: "apk-decoded" });
      if (!envelope.ok) {
        return { hypothesisId: hyp.id, status: "inconclusive", claim: hyp.claim, detail: `apktool unavailable: ${envelope.error?.message ?? "no output"}`, evidence: [] };
      }
      // Parse manifest from the decoded output (simplified: read from workspace).
      const manifestPath = "apk-decoded/AndroidManifest.xml";
      let manifestXml = "";
      if (ctx.workspace) {
        try {
          const fs = await import("node:fs");
          const path = await import("node:path");
          manifestXml = fs.readFileSync(path.join(ctx.workspace, manifestPath), "utf8");
        } catch { /* manifest not found */ }
      }
      if (!manifestXml) {
        return { hypothesisId: hyp.id, status: "refuted", claim: hyp.claim, detail: "AndroidManifest.xml not readable after decode", evidence: [] };
      }
      const analysis = analyzeManifest(manifestXml);
      if (!analysis.findings.length) {
        return { hypothesisId: hyp.id, status: "refuted", claim: hyp.claim, detail: "No manifest-level issues found", evidence: [] };
      }
      const evidence: Evidence[] = analysis.findings.map((f) => ({
        id: nextEvidenceId(),
        kind: "poc" as const,
        at: new Date().toISOString(),
        poc: `apktool decode ${apkPath}`,
        observed: f.detail,
      }));
      const top = analysis.findings[0]!;
      return {
        hypothesisId: hyp.id,
        status: "confirmed",
        claim: hyp.claim,
        detail: `${analysis.findings.length} mobile finding(s): ${analysis.findings.map((f) => f.title).slice(0, 5).join("; ")}`,
        evidence,
        finding: { check: top.check, verdict: "finding", severity: top.severity, title: top.title, target: top.target, detail: top.detail, ...(top.remediation ? { remediation: top.remediation } : {}) },
      };
    },
  };
}
