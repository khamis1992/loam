import type { MobileEngagement } from "./engagement.js";
import { masvsSummary } from "./masvs.js";

export type ReportAudience = "executive" | "developer" | "audit";
export type ReportLanguage = "ar" | "en";

export function renderRoleReport(state: MobileEngagement, audience: ReportAudience, language: ReportLanguage): string {
  const summary = masvsSummary(state.coverage);
  const critical = state.findings.filter((finding) => ["critical", "high"].includes(finding.severity));
  if (language === "ar") {
    if (audience === "executive") return `# الملخص التنفيذي — ${state.id}\n\n- الحالة: ${state.stage}\n- النتائج: ${state.findings.length} (${critical.length} حرجة/عالية)\n- تغطية MASVS المراجعة: ${summary.coveragePercent}%\n- لا تُعد النتائج دليلًا على غياب الثغرات عند نقص التغطية.`;
    if (audience === "developer") return `# دليل المطور — ${state.id}\n\n${state.findings.map((finding) => `## ${finding.title}\n- الهدف: ${finding.target}\n- التفاصيل: ${finding.detail}\n- الإصلاح: ${finding.remediation}\n- إعادة الاختبار: ${finding.retest?.status ?? "لم تنفذ"}`).join("\n\n") || "لا نتائج ضمن التغطية المكتملة."}`;
    return `# سجل التدقيق — ${state.id}\n\n${state.events.map((event) => `- ${event.at}: ${event.from} → ${event.to} بواسطة ${event.actorId}`).join("\n")}\n\nالتغطية: ${summary.covered}/${summary.applicable}؛ جزئي: ${summary.partial}؛ غير مختبر: ${summary.notTested}`;
  }
  if (audience === "executive") return `# Executive summary — ${state.id}\n\n- Stage: ${state.stage}\n- Findings: ${state.findings.length} (${critical.length} critical/high)\n- Reviewed MASVS coverage: ${summary.coveragePercent}%\n- Incomplete coverage is not evidence that the application is clean.`;
  if (audience === "developer") return `# Developer guide — ${state.id}\n\n${state.findings.map((finding) => `## ${finding.title}\n- Target: ${finding.target}\n- Detail: ${finding.detail}\n- Remediation: ${finding.remediation}\n- Retest: ${finding.retest?.status ?? "not run"}`).join("\n\n") || "No findings within completed coverage."}`;
  return `# Audit record — ${state.id}\n\n${state.events.map((event) => `- ${event.at}: ${event.from} → ${event.to} by ${event.actorId}`).join("\n")}\n\nCoverage: ${summary.covered}/${summary.applicable}; partial: ${summary.partial}; not tested: ${summary.notTested}`;
}
