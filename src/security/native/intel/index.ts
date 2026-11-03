/**
 * One entry point: KEV membership + EPSS probability for a set of CVEs, in
 * parallel, with the degradation surfaced instead of hidden — a run without
 * KEV must be able to say so in its report.
 */
import type { IntelCache } from "./cache.js";
import { defaultCache } from "./cache.js";
import { epssFor } from "./epss.js";
import type { EpssScore } from "./epss.js";
import { loadKev } from "./kev.js";
import type { FetchFn, KevEntry, KevResult } from "./kev.js";

export { IntelCache, defaultCache } from "./cache.js";
export { epssFor, EPSS_URL } from "./epss.js";
export type { EpssScore, EpssResult } from "./epss.js";
export { KEV_URL, KEV_FALLBACK_URL, loadKev, resetKevMemo } from "./kev.js";
export type { FetchFn, KevEntry, KevResult } from "./kev.js";
export { daysSince, pocConfidenceFromSources, pocPoints, riskLabelToScore, scoreCve, SCORING_VERSION } from "./risk.js";
export type { PocConfidence, RiskComponents, RiskLabel, RiskScore } from "./risk.js";

export interface Enrichment {
  kev: Map<string, KevEntry> | null;
  epss: Map<string, EpssScore>;
  /** Populated when a source was down — callers must surface this, not swallow it. */
  notes: string[];
}

export async function enrichCves(
  cveIds: string[],
  opts: { fetchFn?: FetchFn; cache?: IntelCache } = {},
): Promise<Enrichment> {
  const cache = opts.cache ?? defaultCache();
  const [kevRes, epssRes] = await Promise.all([
    loadKev({ fetchFn: opts.fetchFn, cache }),
    epssFor(cveIds, { fetchFn: opts.fetchFn, cache }),
  ]);
  const notes: string[] = [];
  if (kevRes.status === "unavailable") notes.push(`kev_unavailable: ${kevRes.reason}`);
  if (epssRes.unreachable) notes.push("epss_unreachable: FIRST EPSS API could not be reached");
  return { kev: kevRes.status === "ok" ? kevRes.entries : null, epss: epssRes.scores, notes };
}

/** Primary CVE id for a vulnerability: prefer a CVE alias, else the OSV/GHSA id itself. */
export function primaryCve(cves: string[], fallback: string): string {
  return cves.find((c) => /^CVE-\d{4}-\d+$/i.test(c))?.toUpperCase() ?? fallback;
}
