/**
 * Composite real-world risk score: CVSS severity is only 20% of the story —
 * exploitation probability (EPSS), confirmed exploitation (CISA KEV, hard
 * override: never below CRITICAL/76) and public exploit evidence carry the
 * rest. Pure functions, deterministic, no network.
 * Port of cve-intel risk.rs + exploits.rs::confidence, scoring version 1.1
 * (MIT/Apache-2.0, Fazmin/cve-intel).
 */
import type { Score } from "../../audit/types.js";
import type { KevEntry } from "./kev.js";

export const SCORING_VERSION = "1.1";

export type PocConfidence = "WEAPONIZED" | "PUBLIC_EXPLOIT_REMOTE" | "PUBLIC_EXPLOIT" | "PUBLIC_POC_HIGH_QUALITY" | "PUBLIC_POC_LOW_QUALITY" | "NONE";
export type RiskLabel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export function pocPoints(confidence: PocConfidence): number {
  switch (confidence) {
    case "WEAPONIZED": return 15;
    case "PUBLIC_EXPLOIT_REMOTE": return 12;
    case "PUBLIC_EXPLOIT": return 10;
    case "PUBLIC_POC_HIGH_QUALITY": return 7;
    case "PUBLIC_POC_LOW_QUALITY": return 3;
    default: return 0;
  }
}

/** Strongest-first evidence ladder over the exploit sources we may someday feed in. */
export function pocConfidenceFromSources(s: {
  metasploitExploits?: unknown[]; exploitDbRemote?: boolean; anyExploitDb?: boolean; xdbInitialAccess?: boolean;
  nucleiTemplates?: unknown[]; strongGithubRepos?: boolean; anyGithubRepo?: boolean;
}): PocConfidence {
  if ((s.metasploitExploits?.length ?? 0) > 0) return "WEAPONIZED";
  if (s.exploitDbRemote || s.xdbInitialAccess) return "PUBLIC_EXPLOIT_REMOTE";
  if (s.anyExploitDb || s.xdbInitialAccess || (s.metasploitExploits?.length ?? 0) > 0 || s.strongGithubRepos) return "PUBLIC_EXPLOIT";
  if ((s.nucleiTemplates?.length ?? 0) > 0 || s.strongGithubRepos) return "PUBLIC_POC_HIGH_QUALITY";
  if (s.anyGithubRepo) return "PUBLIC_POC_LOW_QUALITY";
  return "NONE";
}

/** Days between `published` (RFC3339 / ISO / bare date) and `now`; null when unparseable. */
export function daysSince(published: string, now: Date = new Date()): number | null {
  if (!published) return null;
  const t = Date.parse(published.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(published) ? published : `${published}Z`);
  if (!Number.isFinite(t)) return null;
  return Math.floor((now.getTime() - t) / 86_400_000);
}

export interface RiskComponents {
  cvss_score: number; epss_probability: number; in_kev: boolean; poc_confidence: PocConfidence;
  cvss_contribution: number; epss_contribution: number; kev_contribution: number; poc_contribution: number;
}

export interface RiskScore {
  cve_id: string; scoring_version: string;
  risk_score: number; risk_label: RiskLabel;
  urgency: string; recommendation: string;
  components: RiskComponents;
  boosters_applied: string[];
  days_since_published: number | null;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

export function scoreCve(input: {
  cveId: string; cvssScore: number; published?: string; epssProbability?: number;
  kev?: Pick<KevEntry, "cve" | "dateAdded" | "dueDate" | "ransomware"> | null;
  pocConfidence?: PocConfidence; now?: Date;
}): RiskScore {
  const inKev = input.kev != null;
  const pocConfidence = input.pocConfidence ?? "NONE";
  const epss = input.epssProbability ?? 0;
  const cvss = input.cvssScore;
  const cvssContribution = (cvss / 10) * 20;
  const epssContribution = epss * 100 * 0.35;
  const kevContribution = inKev ? 30 : 0;
  const pocContribution = pocPoints(pocConfidence);
  const base = cvssContribution + epssContribution + kevContribution + pocContribution;

  let multiplier = 1;
  const boosters: string[] = [];
  if (inKev && pocConfidence !== "NONE") { multiplier *= 1.15; boosters.push("KEV+PoC"); }
  if (cvss >= 9 && epss > 0.7) { multiplier *= 1.10; boosters.push("CVSS>=9+EPSS>0.7"); }
  const days = daysSince(input.published ?? "", input.now);
  if (days !== null && days <= 7) { multiplier *= 1.05; boosters.push("Published<7days"); }

  let riskScore = Math.min(100, round2(base * multiplier));
  let riskLabel: RiskLabel = riskScore <= 25 ? "LOW" : riskScore <= 50 ? "MEDIUM" : riskScore <= 75 ? "HIGH" : "CRITICAL";
  // KEV hard override: confirmed exploitation can never be below CRITICAL/76.
  if (inKev) { riskLabel = "CRITICAL"; riskScore = Math.max(riskScore, 76); }

  const urgency = inKev && epss > 0.5 ? "PATCH IMMEDIATELY"
    : inKev ? "PATCH WITHIN 24 HOURS"
    : epss > 0.5 ? "PATCH WITHIN 72 HOURS"
    : cvss >= 9 ? "PATCH THIS WEEK"
    : cvss >= 7 ? "PATCH THIS MONTH"
    : "SCHEDULE FOR NEXT CYCLE";
  const recommendation = urgency === "PATCH IMMEDIATELY"
    ? `${input.cveId} is actively exploited and in the CISA KEV catalog with high exploitation probability; apply vendor patches immediately.`
    : urgency === "PATCH WITHIN 24 HOURS"
    ? `${input.cveId} is listed in the CISA KEV catalog; apply available patches within 24 hours.`
    : urgency === "PATCH WITHIN 72 HOURS"
    ? `${input.cveId} has a high exploitation probability (EPSS ${(epss * 100).toFixed(1)}%); prioritize patching within 72 hours.`
    : urgency === "PATCH THIS WEEK"
    ? `${input.cveId} has a critical CVSS score of ${cvss}; schedule patching this week.`
    : urgency === "PATCH THIS MONTH"
    ? `${input.cveId} has a high CVSS score of ${cvss}; include in the next monthly patch cycle.`
    : `${input.cveId} poses lower immediate risk; schedule remediation for the next maintenance cycle.`;

  return {
    cve_id: input.cveId, scoring_version: SCORING_VERSION,
    risk_score: riskScore, risk_label: riskLabel, urgency, recommendation,
    components: {
      cvss_score: cvss, epss_probability: epss, in_kev: inKev, poc_confidence: pocConfidence,
      cvss_contribution: round2(cvssContribution), epss_contribution: round2(epssContribution),
      kev_contribution: kevContribution, poc_contribution: pocContribution,
    },
    boosters_applied: boosters, days_since_published: days,
  };
}

/** Map a risk label onto the audit's five-point Score scale (never lowers; caller keeps the original). */
export function riskLabelToScore(label: RiskLabel): Score {
  return label === "CRITICAL" ? "critical" : label === "HIGH" ? "high" : label === "MEDIUM" ? "medium" : "low";
}
