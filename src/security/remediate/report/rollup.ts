/** Markdown rollup — REMEDIATE_INTO_LOAM §7.4 report layer. Deterministic
 *  template over the persisted run (no prose generation): one section per repo
 *  with verdicts, hashes and closure states, so a human reviews exactly what the
 *  gates bound. Arabic headings mirror the Security panel. */
import type { RemediationRun } from "../types.js";

const STATES: Record<string, string> = {
  inventory: "جرد", awaiting_scope_approval: "بانتظار موافقة النطاق", scope_approved: "نطاق مُوافق",
  working: "تنفيذ", awaiting_commit_approval: "بانتظار موافقة الالتزام", awaiting_pr_approval: "بانتظار موافقة الدفع",
  complete: "اكتمل", cancelled: "أُلغي",
};
const VERDICTS: Record<string, string> = {
  verified_fixed: "إصلاح مُتحقَّق", patched_unverified: "مرقّع غير مُتحقَّق (بلا Docker)", regression: "انحدار", blocked: "محجوب", vendor_update_required: "يتطلب تحديث المورّد",
};

export function remediationRollup(run: RemediationRun): string {
  const L: string[] = [];
  L.push(`# تقرير الإصلاح المُتحقَّق — ${run.id}`);
  L.push("");
  L.push(`الحالة: ${STATES[run.state] ?? run.state} · بدء: ${run.createdAt}${run.finishedAt ? ` · انتهاء: ${run.finishedAt}` : ""} · منصّة: ${run.host.platform} · Docker: ${run.host.docker.available ? "متاح" : "غير متاح"}`);
  L.push("");
  L.push(`حزم الاستشارة: ${run.advisoryIds.map((id) => `${id} (${run.packHashes[id]?.slice(0, 12) ?? "?"})`).join("، ") || "—"}`);
  L.push("");
  L.push(`## الجرد (${run.inventory.length} صف)`);
  if (run.inventory.length === 0) L.push("_لا صفوف عرضة للخطر._");
  else {
    L.push("| الملف | السطر | الإشارة | الحالي | الهدف المقترح | التصنيف |");
    L.push("|---|---|---|---|---|---|");
    for (const r of run.inventory) L.push(`| ${r.hit.file} | ${r.hit.line} | \`${r.hit.signal}\` | ${r.hit.currentVersion ?? "—"} | ${r.proposedTarget ?? "—"} | ${r.status} |`);
  }
  L.push("");
  for (const plan of run.plans) {
    L.push(`## المستودع ${plan.repoId} — ${plan.phase}`);
    L.push("");
    L.push(`الفرع: \`${plan.branch}\` (من \`${plan.baseBranch}\`)${plan.commitSha ? ` · التزام: \`${plan.commitSha.slice(0, 12)}\`` : ""}${plan.pr ? ` · PR #${plan.pr.number} ${plan.pr.draft ? "(مسودة)" : ""}` : ""}`);
    if (plan.fixGate) L.push(`بوابة الإصلاح: ${VERDICTS[plan.fixGate.verdict] ?? plan.fixGate.verdict} — ${plan.fixGate.reason}`);
    if (plan.blockedReason) L.push(`سبب الحجب: ${plan.blockedReason}`);
    L.push("");
  }
  if (run.closures.length) {
    L.push("## الإغلاق");
    for (const c of run.closures) {
      L.push(`- ${c.vulnId}: ${c.state}${c.deployEvidence ? ` · دليل نشر: ${c.deployEvidence.observedVersion} (${c.deployEvidence.observedAt})` : ""}`);
    }
    L.push("");
  }
  L.push("---");
  L.push("الترقيع مشتق من CognitionAI/devin-vuln-fixes (MIT).");
  return L.join("\n") + "\n";
}
