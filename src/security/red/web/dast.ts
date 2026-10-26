/**
 * DAST capability (RED_TEAM_BUILD_SPEC §6.3).
 *
 * OWASP ZAP quick-scan is kept as a compatibility fallback for callers that
 * already have a daemon or report file, but the supported headless path is
 * ZAP daemon + REST API (quickscan's GUI bootstrap is not supported headless).
 */
import fs from "node:fs";
import path from "node:path";
import type { PentestFinding } from "../../../tools/pentest.js";
import type { Evidence } from "../../orchestrator.js";
import { nextEvidenceId } from "../../orchestrator.js";
import type { RedCapability, RedCapabilityContext, RedHypothesis, RedValidation } from "../orchestrator/redOrchestrator.js";
import { zapJarPath } from "../engines.js";
import { scanZapWithDaemon } from "./zapApi.js";

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
  // JSON shape: { site: { alerts: [...] } } or a bare array.
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

function validateZapAlerts(hyp: RedHypothesis, alerts: ZapAlert[]): RedValidation {
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
}

export function dastCapability(opts: { zapJar?: string | null; daemon?: boolean; zapPort?: number } = {}): RedCapability {
  return {
    id: "red.dast",
    applicable: (target) => /^https?:/i.test(target),
    hunt: async (target): Promise<RedHypothesis[]> => [
      { id: `HYP-DAST-${target.length}`, capability: "red.dast", target, claim: "Active DAST scan findings", rationale: "ZAP quick-scan pass" },
    ],
    validate: async (hyp: RedHypothesis, ctx: RedCapabilityContext): Promise<RedValidation> => {
      const jar = opts.zapJar !== undefined ? opts.zapJar : zapJarPath();
      if (!jar) {
        return { hypothesisId: hyp.id, status: "inconclusive", claim: hyp.claim, detail: "ZAP not installed (run npm run red:engines)", evidence: [] };
      }
      if (opts.daemon && ctx.bridgeDaemon) {
        try {
          const alerts = await scanZapWithDaemon(jar, opts.zapPort ?? 8090, hyp.target, ctx);
          return validateZapAlerts(hyp, alerts);
        } catch (err) {
          return { hypothesisId: hyp.id, status: "inconclusive", claim: hyp.claim, detail: `ZAP daemon scan failed: ${(err as Error).message}`, evidence: [] };
        }
      }

      // Compatibility path for existing report producers/tests: ZAP quickscan.
      const out = "red-zap-report.json";
      const envelope = await ctx.bridge("red-zap", "quickscan", { jar, target: hyp.target, out });
      if (!envelope.ok) {
        return { hypothesisId: hyp.id, status: "inconclusive", claim: hyp.claim, detail: `ZAP unavailable: ${envelope.error?.message ?? "no output"}`, evidence: [] };
      }
      // The quickscan report lands in the workspace out file; stdout carries
      // only the progress log. Read the report, with stdout as a fallback for
      // callers that do not supply a bridge workspace.
      let raw = `${envelope.text ?? ""}`;
      const data = typeof envelope.data === "string" ? envelope.data : raw;
      if (ctx.workspace) {
        try {
          const file = path.join(ctx.workspace, out);
          if (fs.existsSync(file)) raw = fs.readFileSync(file, "utf8");
        } catch {
          /* fall back to stdout text */
        }
      }
      const alerts = parseZapAlerts(data || raw);
      return validateZapAlerts(hyp, alerts);
    },
  };
}
