/**
 * Vuln-template capability (RED_TEAM_BUILD_SPEC §6.6) — nuclei via the
 * red-nuclei bridge. Every template hit becomes a PoC-backed finding. Template
 * selection from recon leads (AutoPWN graft) is data for the caller; v1 runs
 * the engine's default template set at the requested minimum severity.
 */
import type { PentestFinding } from "../../tools/pentest.js";
import type { Evidence } from "../orchestrator.js";
import { nextEvidenceId } from "../orchestrator.js";
import type { RedCapability, RedCapabilityContext, RedHypothesis, RedValidation } from "./orchestrator/redOrchestrator.js";
import type { CveLead } from "./recon/recon.js";

export interface NucleiHit {
  templateId: string;
  matchedAt: string;
  severity: string;
  name?: string;
}

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"];

/** Parse nuclei -jsonl output: one JSON object per line. */
export function parseNuclei(raw: string): NucleiHit[] {
  const hits: NucleiHit[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      const templateId = typeof o["template-id"] === "string" ? o["template-id"] : typeof o.templateId === "string" ? o.templateId : "";
      const matchedAt = typeof o["matched-at"] === "string" ? o["matched-at"] : typeof o.matchedAt === "string" ? o.matchedAt : "";
      const severity = typeof o.severity === "string" ? o.severity : "unknown";
      if (!templateId || !matchedAt) continue;
      hits.push({ templateId, matchedAt, severity, ...(typeof o.name === "string" ? { name: o.name } : {}) });
    } catch {
      /* skip malformed line */
    }
  }
  return hits;
}

const toSeverity = (s: string): PentestFinding["severity"] =>
  (["critical", "high", "medium", "low", "info"] as const).includes(s.toLowerCase() as never)
    ? (s.toLowerCase() as PentestFinding["severity"])
    : "medium";

export function templatesCapability(opts: { severity?: string; tags?: string } = {}): RedCapability {
  const severity = opts.severity ?? "medium";
  return {
    id: "red.templates",
    applicable: (target) => /^https?:/i.test(target),
    hunt: async (target, _recon): Promise<RedHypothesis[]> => [
      { id: `HYP-NUCLEI-${target.length}`, capability: "red.templates", target, claim: "Known-CVE/misconfig template matches", rationale: `nuclei template scan (>= ${severity})` },
    ],
    validate: async (hyp: RedHypothesis, ctx: RedCapabilityContext): Promise<RedValidation> => {
      const envelope = await ctx.bridge("red-nuclei", "scan", { target: hyp.target, severity, rate: 10, ...(opts.tags ? { tags: opts.tags } : {}) });
      if (!envelope.ok) {
        return { hypothesisId: hyp.id, status: "inconclusive", claim: hyp.claim, detail: `nuclei unavailable: ${envelope.error?.message ?? "no output"}`, evidence: [] };
      }
      const raw = typeof envelope.data === "string" ? envelope.data : `${envelope.text ?? ""}`;
      const hits = parseNuclei(raw).filter((h) => SEVERITY_ORDER.indexOf(h.severity.toLowerCase()) <= SEVERITY_ORDER.indexOf(severity));
      if (!hits.length) {
        return { hypothesisId: hyp.id, status: "refuted", claim: hyp.claim, detail: `no template matched at >= ${severity}`, evidence: [] };
      }
      const evidence: Evidence[] = hits.map((h) => ({
        id: nextEvidenceId(),
        kind: "poc",
        at: new Date().toISOString(),
        poc: `nuclei -u ${hyp.target} (template ${h.templateId})`,
        observed: `${h.name ?? h.templateId} matched at ${h.matchedAt} (${h.severity})`,
      }));
      const top = [...hits].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity.toLowerCase()) - SEVERITY_ORDER.indexOf(b.severity.toLowerCase()))[0]!;
      const finding: Omit<PentestFinding, "id"> = {
        check: "red_nuclei_template",
        verdict: "finding",
        severity: toSeverity(top.severity),
        title: top.name ?? `Template match: ${top.templateId}`,
        target: hyp.target,
        detail: hits.map((h) => `${h.templateId} @ ${h.matchedAt} (${h.severity})`).slice(0, 20).join("; "),
        remediation: "Patch the affected component to a fixed version; verify with the template's reference.",
      };
      return { hypothesisId: hyp.id, status: "confirmed", claim: hyp.claim, detail: finding.detail, evidence, finding };
    },
  };
}

/** Narrow a nuclei run to templates suggested by recon CVE leads (data-only). */
export function selectTemplateTags(leads: CveLead[]): string[] {
  return [...new Set(leads.map((l) => l.cveId.toLowerCase()))].slice(0, 10);
}
