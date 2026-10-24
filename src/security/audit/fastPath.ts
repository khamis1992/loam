/**
 * Phase 0 fast path: deterministic scanner hits become records without an LLM.
 * Evidence quotes locations only, never a secret value.
 * loam-sca records carry the real-world enrichment (KEV/EPSS/composite risk) from the
 * scanner's raw payload, and shadow the overlapping external osv-scanner record.
 */
import type { Confirmed, FindingIntel, NeedsValidation, ReconHit } from "./types.js";
import { scoreRank } from "./types.js";
import type { ScaRaw } from "../native/sca/osvClient.js";
import { riskLabelToScore } from "../native/intel/risk.js";

const NON_LIVE = /(example|sample|dummy|placeholder|fake|test|mock|changeme)/i;
const NON_SOURCE = /(^|\/)(tests?|__tests__|fixtures?|docs?|examples?|samples?|testdata)(\/|$)|\.(md|txt|lock)$/i;

export function fingerprintOf(h: Pick<ReconHit, "tool" | "ruleId" | "file" | "line">): string {
  const raw = `${h.tool}:${h.ruleId}:${h.file}:${h.line}`.replace(/[^A-Za-z0-9._:/@+-]/g, "_");
  return /^[A-Za-z0-9]/.test(raw) ? raw : `x${raw}`;
}

/** Live-shaped = the rule and path give no hint it is a placeholder, and it sits in tracked source. */
export function liveShaped(h: ReconHit): boolean {
  return !NON_LIVE.test(h.ruleId) && !NON_SOURCE.test(h.file);
}

function loc(h: ReconHit) {
  return { file: h.file, line: h.line, description: `${h.tool} rule ${h.ruleId} reported here` };
}

function confirmed(h: ReconHit, title: string, description: string, strategy: string): Confirmed {
  return {
    verdict: "confirmed", fingerprint: fingerprintOf(h), title, description,
    root_cause: description, intended_behavior: "Source and dependencies contain no known-bad or secret material.",
    trace: [{ kind: "sink", file: h.file, line: h.line, scope: h.cls, description: `${h.tool}: ${h.ruleId}` }],
    evidence: [loc(h)], conditions: [],
    execution: { attacker_perspective: "Anyone with read access to the repository or its published artifacts.", payloads: [], instructions: [], observed_result: `Deterministic scanner match (${h.tool}).` },
    remediation: { strategy },
    severity: {
      likelihood: { score: "medium", reason: "Deterministic scanner match." },
      impact: { score: h.severity, reason: `Scanner severity for ${h.ruleId}.` },
      overall_severity: h.severity,
    },
    confidence: { score: "high", reason: "Deterministic rule." },
    evidence_vector: [{ source: "rule", state: "confirmed", ref: `${h.tool}:${h.ruleId}` }],
    evidence_assurance: "source-only",
  };
}

function needsValidation(h: ReconHit, title: string, description: string, blocker: string): NeedsValidation {
  return {
    verdict: "needs_validation", fingerprint: fingerprintOf(h), title, description,
    claimed_root_cause: description, trace: [{ kind: "sink", file: h.file, line: h.line, scope: h.cls, description: `${h.tool}: ${h.ruleId}` }],
    evidence: [loc(h)], blockers: [blocker],
    validation_plan: { local: `Inspect ${h.file}:${h.line} and decide whether the match is real.` },
    evidence_vector: [{ source: "rule", state: "unknown", ref: `${h.tool}:${h.ruleId}` }],
    evidence_assurance: "source-only",
  };
}

function confirmedSca(h: ReconHit): Confirmed {
  const r = (h.raw ?? {}) as Partial<ScaRaw>;
  const pkg = `${r.package ?? "package"}@${r.version ?? "?"}`;
  const risk = r.risk;
  const kev = r.kev;
  const epss = r.epss;
  const intel: FindingIntel = {
    ...(r.cves?.length ? { cve: r.cves.find((c) => /^CVE-/.test(c)) ?? r.cves[0] } : {}),
    ...(risk ? { risk: { risk_score: risk.risk_score, risk_label: risk.risk_label, urgency: risk.urgency, recommendation: risk.recommendation, scoring_version: risk.scoring_version, boosters_applied: risk.boosters_applied } } : {}),
    ...(kev ? { kev } : {}),
    ...(epss ? { epss } : {}),
  };
  const signals = [
    kev ? `listed in CISA KEV${kev.ransomware ? " with known ransomware use" : ""}` : null,
    epss ? `EPSS ${(epss.epss * 100).toFixed(1)}%` : null,
    risk ? `composite risk ${risk.risk_score} ${risk.risk_label} (${risk.urgency})` : null,
  ].filter(Boolean).join("; ");
  const title = risk ? `Dependency with a known vulnerability (risk ${risk.risk_score} ${risk.risk_label})` : "Dependency with a known vulnerability";
  const desc = `${h.message}${signals ? `. Real-world signals: ${signals}` : ""}`;
  const strategy = r.upgradeTo || r.fixedIn
    ? `Upgrade ${pkg} to ${r.upgradeTo ?? r.fixedIn} or later.${risk ? ` ${risk.recommendation}` : ""}`
    : "Upgrade to a fixed version.";
  const escalated = !!risk && !!r.baseSeverity && scoreRank(riskLabelToScore(risk.risk_label)) > scoreRank(r.baseSeverity);
  return {
    verdict: "confirmed", fingerprint: fingerprintOf(h), title, description: desc.slice(0, 500),
    root_cause: desc.slice(0, 500),
    intended_behavior: "Dependencies are free of advisories with real-world exploitation evidence.",
    trace: [{ kind: "sink", file: h.file, line: h.line, scope: h.cls, description: `${h.tool}: ${h.ruleId}` }],
    evidence: [loc(h)],
    conditions: [{ kind: "third_party_dependency", description: `${pkg} (${r.ecosystem ?? "unknown ecosystem"}) is pinned in ${h.file}.` }],
    execution: {
      attacker_perspective: "Anyone who can trigger the vulnerable code path in the dependent package.",
      payloads: [], instructions: [],
      observed_result: `Deterministic OSV advisory match (${h.ruleId})${kev ? "; the CVE is listed in CISA KEV (actively exploited)" : ""}.`,
    },
    remediation: { strategy },
    severity: {
      likelihood: {
        score: epss && epss.epss > 0.5 ? "high" : kev ? "high" : "medium",
        reason: kev ? "Actively exploited (CISA KEV)." : epss ? `EPSS exploitation probability ${(epss.epss * 100).toFixed(1)}%.` : "Public advisory; exploitation probability unknown.",
      },
      impact: {
        score: h.severity,
        reason: escalated ? `Real-world signals raised the impact above the advisory's base severity (${r.baseSeverity}).` : `Scanner severity for ${h.ruleId}.`,
      },
      overall_severity: h.severity,
    },
    confidence: { score: "high", reason: "Deterministic OSV advisory match on a pinned version." },
    evidence_vector: [
      { source: "rule", state: "confirmed", ref: `${h.tool}:${h.ruleId}` },
      ...(kev ? [{ source: "rule" as const, state: "confirmed" as const, ref: `kev:${intel.cve ?? h.ruleId}`, note: "Listed in the CISA KEV catalog" }] : []),
    ],
    evidence_assurance: "source-only",
    ...(r.cvss ? { cvss: { vector: r.cvss.vector, score: r.cvss.score, severity: h.severity } } : {}),
    ...(Object.keys(intel).length ? { intel } : {}),
  };
}

/**
 * Opengrep and other non-deterministic hits are returned as hunter hints, not records.
 * A loam-sca record shadows the external osv-scanner hit for the same advisory in the
 * same file — the enriched record is strictly richer (risk, KEV, EPSS, fixed versions).
 */
export function fastPath(hits: ReconHit[]): { records: (Confirmed | NeedsValidation)[]; hints: ReconHit[] } {
  const records: (Confirmed | NeedsValidation)[] = [];
  const hints: ReconHit[] = [];
  const seen = new Set<string>();
  const scaAdvisories = new Set(hits.filter((h) => h.tool === "loam-sca").map((h) => `${h.file}\u0000${h.ruleId}`));
  for (const h of hits) {
    if (!h.deterministic) { hints.push(h); continue; }
    const fp = fingerprintOf(h);
    if (seen.has(fp)) continue;
    seen.add(fp);
    if (h.tool === "gitleaks") {
      const title = "Possible hard-coded secret";
      const desc = `Secret scanner rule ${h.ruleId} matched at ${h.file}:${h.line}. The value is not recorded.`;
      records.push(liveShaped(h)
        ? confirmed(h, title, desc, "Revoke the credential, remove it from history and load it from a secret store.")
        : needsValidation(h, title, desc, "The match looks like a placeholder or sits outside tracked source."));
    } else if (h.tool === "loam-sca") {
      records.push(confirmedSca(h));
    } else if (h.tool === "osv") {
      if (scaAdvisories.has(`${h.file}\u0000${h.ruleId}`)) continue; // shadowed by the enriched loam-sca record
      records.push(confirmed(h, "Dependency with a known vulnerability", `${h.message}`.slice(0, 500), "Upgrade to a fixed version."));
    } else if (h.tool === "guarddog") {
      records.push(confirmed(h, "Package flagged as malicious", `${h.message}`.slice(0, 500), "Remove the package and audit what it touched."));
    } else {
      hints.push(h);
    }
  }
  return { records, hints };
}
