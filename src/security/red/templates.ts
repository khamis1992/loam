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
import { mapKnownVulnsWithKev, type CveLead } from "./recon/recon.js";

export interface NucleiHit {
  templateId: string;
  matchedAt: string;
  severity: string;
  name?: string;
}

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"];
/** Unknown severities are conservatively treated as medium, never as a free pass. */
const severityRank = (value: string): number => {
  const rank = SEVERITY_ORDER.indexOf(value.toLowerCase());
  return rank === -1 ? SEVERITY_ORDER.indexOf("medium") : rank;
};

/** Parse nuclei -jsonl output: one JSON object per line. */
export function parseNuclei(raw: string): NucleiHit[] {
  const hits: NucleiHit[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      const templateId = typeof o["template-id"] === "string" ? o["template-id"] : typeof o.templateId === "string" ? o.templateId : "";
      const matchedAt = typeof o["matched-at"] === "string" ? o["matched-at"] : typeof o.matchedAt === "string" ? o.matchedAt : "";
      const info = o.info && typeof o.info === "object" ? o.info as Record<string, unknown> : {};
      const severity = typeof o.severity === "string" ? o.severity : typeof info.severity === "string" ? info.severity : "unknown";
      if (!templateId || !matchedAt) continue;
      const name = typeof o.name === "string" ? o.name : typeof info.name === "string" ? info.name : undefined;
      hits.push({ templateId, matchedAt, severity, ...(name ? { name } : {}) });
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

/** Normalize one nuclei JSON object from the jsonl bridge envelope. */
function hitFromObject(o: Record<string, unknown>): NucleiHit | null {
  const templateId = typeof o["template-id"] === "string" ? o["template-id"] : typeof o.templateId === "string" ? o.templateId : "";
  const matchedAt = typeof o["matched-at"] === "string" ? o["matched-at"] : typeof o.matchedAt === "string" ? o.matchedAt : "";
  const info = o.info && typeof o.info === "object" ? o.info as Record<string, unknown> : {};
  const severity = typeof o.severity === "string" ? o.severity : typeof info.severity === "string" ? info.severity : "unknown";
  if (!templateId || !matchedAt) return null;
  const name = typeof o.name === "string" ? o.name : typeof info.name === "string" ? info.name : undefined;
  return { templateId, matchedAt, severity, ...(name ? { name } : {}) };
}

export function templatesCapability(opts: { severity?: string; tags?: string; templatesPath?: string } = {}): RedCapability {
  const severity = opts.severity ?? "medium";
  return {
    id: "red.templates",
    applicable: (target) => /^https?:/i.test(target),
    hunt: async (target, recon): Promise<RedHypothesis[]> => {
      const leads = await mapKnownVulnsWithKev(recon);
      const ids = selectTemplateIds(leads).join(",");
      return [
        {
          id: `HYP-NUCLEI-${target.length}`,
          capability: "red.templates",
          target,
          claim: "Known-CVE/misconfig template matches",
          rationale: `nuclei template scan (>= ${severity})`,
          ...(ids ? { params: { ids } } : {}),
        },
      ];
    },
    validate: async (hyp: RedHypothesis, ctx: RedCapabilityContext): Promise<RedValidation> => {
      const envelope = await ctx.bridge("red-nuclei", "scan", {
        target: hyp.target,
        severity,
        rate: 10,
        ...(opts.tags ? { tags: opts.tags } : {}),
        ...(opts.templatesPath ? { templates: opts.templatesPath } : {}),
        ...(hyp.params?.ids ? { ids: hyp.params.ids } : {}),
      });
      if (!envelope.ok) {
        return { hypothesisId: hyp.id, status: "inconclusive", claim: hyp.claim, detail: `nuclei unavailable: ${envelope.error?.message ?? "no output"}`, evidence: [] };
      }
      const raw = typeof envelope.data === "string" ? envelope.data : `${envelope.text ?? ""}`;
      const hits = (Array.isArray(envelope.data)
        ? envelope.data.map((item) => hitFromObject(item as Record<string, unknown>)).filter((h): h is NucleiHit => h !== null)
        : parseNuclei(raw)
      ).filter((h) => severityRank(h.severity) <= severityRank(severity));
      if (!hits.length) {
        return { hypothesisId: hyp.id, status: "refuted", claim: hyp.claim, detail: `no template matched at >= ${severity}: ${raw.slice(0, 500) || "(no engine output)"}`, evidence: [] };
      }
      const evidence: Evidence[] = hits.map((h) => ({
        id: nextEvidenceId(),
        kind: "poc",
        at: new Date().toISOString(),
        poc: `nuclei -u ${hyp.target} (template ${h.templateId})`,
        observed: `${h.name ?? h.templateId} matched at ${h.matchedAt} (${h.severity})`,
      }));
      const top = [...hits].sort((a, b) => severityRank(a.severity) - severityRank(b.severity))[0]!;
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

/** Exact nuclei template ids suggested by recon CVE leads (uses -id). */
export function selectTemplateIds(leads: CveLead[]): string[] {
  return [...new Set(leads.map((l) => l.cveId.toLowerCase()))].slice(0, 10);
}

/** Backward-compatible alias; new callers should use selectTemplateIds. */
export function selectTemplateTags(leads: CveLead[]): string[] {
  return selectTemplateIds(leads);
}
