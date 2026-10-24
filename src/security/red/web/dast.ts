/**
 * DAST capability (RED_TEAM_BUILD_SPEC §6.3) — OWASP ZAP quick-scan via the
 * red-zap bridge. Alerts are parsed from ZAP's quick-scan report and mapped to
 * evidence-gated findings (Apache-2.0 engine; external process only).
 */
import type { PentestFinding } from "../../../tools/pentest.js";
import type { Evidence } from "../../orchestrator.js";
import { nextEvidenceId } from "../../orchestrator.js";
import type { RedCapability, RedCapabilityContext, RedHypothesis, RedValidation } from "../orchestrator/redOrchestrator.js";

export interface ZapAlert {
  pluginid: string;
  name: string;
  riskcode: string;
  uri: string;
  description?: string;
  solution?: string;
}

const riskToSeverity = (riskcode: string): PentestFinding["severity"] => {
  switch (riskcode) {
    case "3":
      return "high";
    case "2":
      return "medium";
    case "1":
      return "low";
    default:
      return "info";
  }
};

/** Parse ZAP quickscan JSON (v2) or XML alert items; tolerant to both shapes. */
export function parseZapAlerts(raw: string): ZapAlert[] {
  const alerts: ZapAlert[] = [];
  // JSON shape: { site: { alerts: [ { ...pluginid/name/riskcode/uri... } ] } } or a bare array.
  try {
    const doc = JSON.parse(raw) as unknown;
    const list = Array.isArray(doc)
      ? doc
      : ((doc as { site?: { alerts?: unknown[] } }).site?.alerts ?? (doc as { alerts?: unknown[] }).alerts ?? []);
    if (Array.isArray(list)) {
      for (const a of list) {
        const o = a as Record<string, unknown>;
        if (typeof o.name === "string" && typeof o.riskcode === "string") {
          alerts.push({
            pluginid: String(o.pluginid ?? ""),
            name: o.name,
            riskcode: o.riskcode,
            uri: String(o.uri ?? ""),
            ...(typeof o.description === "string" ? { description: o.description } : {}),
            ...(typeof o.solution === "string" ? { solution: o.solution } : {}),
          });
        }
      }
      if (alerts.length) return alerts;
    }
  } catch {
    /* fall through to XML */
  }
  for (const item of raw.match(/<alertitem>[\s\S]*?<\/alertitem>/g) ?? []) {
    const pick = (tag: string): string => (new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(item)?.[1] ?? "").trim();
    const name = pick("name");
    const riskcode = pick("riskcode");
    if (!name || !riskcode) continue;
    alerts.push({ pluginid: pick("pluginid"), name, riskcode, uri: pick("uri"), description: pick("desc"), solution: pick("solution") });
  }
  return alerts;
}

export function dastCapability(): RedCapability {
  return {
    id: "red.dast",
    applicable: (target) => /^https?:/i.test(target),
    hunt: async (target): Promise<RedHypothesis[]> => [
      { id: `HYP-DAST-${target.length}`, capability: "red.dast", target, claim: "Active DAST scan findings", rationale: "ZAP quick-scan pass" },
    ],
    validate: async (hyp: RedHypothesis, ctx: RedCapabilityContext): Promise<RedValidation> => {
      const envelope = await ctx.bridge("red-zap", "quickscan", { target: hyp.target, out: "red-zap-report.json" });
      if (!envelope.ok) {
        return { hypothesisId: hyp.id, status: "inconclusive", claim: hyp.claim, detail: `ZAP unavailable: ${envelope.error?.message ?? "no output"}`, evidence: [] };
      }
      // The quickscan report lands in the workspace out file; the envelope text
      // may carry it too. Parse whichever we can see.
      const raw = `${envelope.text ?? ""}`;
      const data = typeof envelope.data === "string" ? envelope.data : raw;
      const alerts = parseZapAlerts(data || raw);
      if (!alerts.length) {
        return { hypothesisId: hyp.id, status: "refuted", claim: hyp.claim, detail: "ZAP quick-scan reported no alerts", evidence: [] };
      }
      const evidence: Evidence[] = alerts.map((a) => ({
        id: nextEvidenceId(),
        kind: "poc",
        at: new Date().toISOString(),
        poc: `zap -quickurl ${hyp.target} (plugin ${a.pluginid || "?"})`,
        observed: `${a.name} at ${a.uri || hyp.target} (risk ${a.riskcode})`,
      }));
      const grouped = alerts
        .map((a, i) => ({
          check: "red_zap_dast",
          verdict: "finding" as const,
          severity: riskToSeverity(a.riskcode),
          title: a.name,
          target: a.uri || hyp.target,
          detail: evidence[i]!.observed!,
          ...(a.solution ? { remediation: a.solution } : {}),
        }))
        .sort((x, y) => x.title.localeCompare(y.title));
      // One validation may only carry one finding skeleton; the most severe
      // alert represents the claim and the rest ride along as detail evidence.
      const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;
      const top = [...grouped].sort((a, b) => order[a.severity] - order[b.severity])[0]!;
      return {
        hypothesisId: hyp.id,
        status: "confirmed",
        claim: hyp.claim,
        detail: `${alerts.length} ZAP alert(s): ${alerts.map((a) => a.name).slice(0, 5).join(", ")}${alerts.length > 5 ? " …" : ""}`,
        evidence,
        finding: { ...top, detail: `${alerts.map((a) => `${a.name} (${a.riskcode})`).join("; ")}` },
      };
    },
  };
}
