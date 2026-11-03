/**
 * Adapter: the source-audit engine (src/security/audit). FindingRecord[] → RawFinding[].
 * Rejected records are dropped (they are not findings); needs_validation survives with
 * its verdict in properties so the report can label it. The originating tool is
 * recovered from the evidence vector (`tool:ruleId`) and mapped to a unified engine.
 */
import type { FindingRecord } from "../../audit/types.js";
import { engineForTool } from "../types.js";
import type { Normalizer, RawFinding } from "../types.js";

const severityOf = (r: FindingRecord): RawFinding["severity"] => {
  const s = r.verdict === "confirmed" ? r.severity.overall_severity : "medium";
  return s === "informational" ? "info" : s;
};

const targetOf = (r: FindingRecord): string => {
  const t = r.trace[r.trace.length - 1] ?? r.trace[0];
  return t ? `${t.file}:${t.line}` : "unknown";
};

export const auditNormalizer: Normalizer = {
  adapt(raw: unknown): RawFinding[] {
    if (!Array.isArray(raw)) return [];
    const out: RawFinding[] = [];
    for (const item of raw) {
      const r = item as FindingRecord;
      if (!r || typeof r.verdict !== "string" || r.verdict === "rejected") continue;
      const ref = r.evidence_vector[0]?.ref ?? "";
      const tool = ref.includes(":") ? ref.slice(0, ref.indexOf(":")) : "";
      out.push({
        engine: engineForTool(tool),
        ruleId: r.fingerprint,
        severity: severityOf(r),
        target: targetOf(r),
        title: r.title,
        detail: r.verdict === "confirmed" ? r.description : r.description,
        ...(r.verdict === "confirmed" && r.remediation.strategy ? { remediation: r.remediation.strategy } : {}),
        properties: {
          verdict: r.verdict,
          ...(r.verdict === "confirmed" && r.intel ? { intel: r.intel } : {}),
          ...(r.verdict === "needs_validation" ? { blockers: r.blockers } : {}),
        },
      });
    }
    return out;
  },
};
