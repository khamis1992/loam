/**
 * OSV matching through the server's querybatch endpoint. `fetchFn` is injectable so tests need no network.
 * Hits are enriched with real-world signals (CISA KEV membership, EPSS probability, composite risk score —
 * the cve-intel model) and escalate severity when the real world is worse than CVSS alone.
 */
import fs from "node:fs";
import path from "node:path";
import type { ReconHit, Score } from "../../audit/types.js";
import { scoreRank } from "../../audit/types.js";
import { enrichCves, primaryCve } from "../intel/index.js";
import type { IntelCache } from "../intel/index.js";
import { riskLabelToScore, scoreCve } from "../intel/risk.js";
import type { RiskScore } from "../intel/risk.js";
import { discover } from "./lockfiles.js";
import type { Pkg } from "./lockfiles.js";
import { smallestFixAbove, maxOf } from "./versions.js";

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const BATCH = 1000;
const URL_BATCH = "https://api.osv.dev/v1/querybatch";
const URL_VULN = "https://api.osv.dev/v1/vulns/";

export interface Vuln {
  id: string; summary: string; severity: Score; aliases: string[];
  /** CVE-shaped aliases (plus a CVE-shaped id), deduped — the join key for KEV/EPSS. */
  cves: string[];
  published?: string;
  cvssVector?: string;
  cvssScore?: number;
  /** All `fixed` events of ECOSYSTEM ranges, unfiltered. */
  fixedEvents?: string[];
}

/** Base score from a CVSS v3 vector, computed locally; null when the vector is not v3. */
export function cvss3Score(vector: string): number | null {
  if (!vector.startsWith("CVSS:3")) return null;
  const m = Object.fromEntries(vector.split("/").slice(1).map((p) => p.split(":") as [string, string]));
  const AV = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }[m.AV ?? ""];
  const AC = { L: 0.77, H: 0.44 }[m.AC ?? ""];
  const UI = { N: 0.85, R: 0.62 }[m.UI ?? ""];
  const changed = m.S === "C";
  const PR = (changed ? { N: 0.85, L: 0.68, H: 0.5 } : { N: 0.85, L: 0.62, H: 0.27 })[m.PR ?? ""];
  const cia = (k: string): number | undefined => ({ H: 0.56, L: 0.22, N: 0 })[m[k] ?? ""];
  const [C, I, A] = [cia("C"), cia("I"), cia("A")];
  if ([AV, AC, UI, PR, C, I, A].some((x) => x === undefined)) return null;
  const iss = 1 - (1 - C!) * (1 - I!) * (1 - A!);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  if (impact <= 0) return 0;
  const expl = 8.22 * AV! * AC! * PR! * UI!;
  const raw = changed ? Math.min(1.08 * (impact + expl), 10) : Math.min(impact + expl, 10);
  return Math.ceil(raw * 10) / 10;
}

export const scoreToSeverity = (s: number): Score => (s >= 9 ? "critical" : s >= 7 ? "high" : s >= 4 ? "medium" : s > 0 ? "low" : "informational");

/** Representative CVSS number for a severity label, so the risk model always has a numeric input. */
export const severityToCvss = (s: Score): number => (s === "critical" ? 9.5 : s === "high" ? 8 : s === "medium" ? 5.5 : s === "low" ? 3 : 0);

function parseDetail(j: Record<string, unknown>): Vuln {
  let severity: Score = "medium";
  let cvssVector: string | undefined;
  const sev = Array.isArray(j.severity) ? (j.severity as { score?: string }[]) : [];
  for (const s of sev) {
    const n = typeof s.score === "string" ? cvss3Score(s.score) : null;
    if (n !== null) { severity = scoreToSeverity(n); cvssVector = s.score; break; }
  }
  if (!cvssVector) {
    const db = (j.database_specific as { severity?: string } | undefined)?.severity?.toLowerCase();
    if (db === "critical" || db === "high" || db === "medium" || db === "low") severity = db;
    else if (db === "moderate") severity = "medium";
  }
  const aliases = Array.isArray(j.aliases) ? (j.aliases as string[]) : [];
  const cves = [...aliases, j.id as string].filter((a): a is string => typeof a === "string" && /^CVE-\d{4}-\d+$/i.test(a));
  const fixedEvents: string[] = [];
  for (const aff of Array.isArray(j.affected) ? (j.affected as Record<string, unknown>[]) : []) {
    for (const range of Array.isArray(aff.ranges) ? (aff.ranges as { type?: string; events?: { fixed?: string }[] }[]) : []) {
      if (range.type !== "ECOSYSTEM") continue;
      for (const e of range.events ?? []) if (typeof e.fixed === "string" && e.fixed) fixedEvents.push(e.fixed);
    }
  }
  return {
    id: String(j.id ?? ""), summary: typeof j.summary === "string" ? j.summary.slice(0, 200) : "", severity, aliases: aliases.slice(0, 20),
    cves: [...new Set(cves.map((c) => c.toUpperCase()))],
    published: typeof j.published === "string" ? j.published : undefined,
    cvssVector, cvssScore: cvssVector && cvss3Score(cvssVector) !== null ? cvss3Score(cvssVector)! : undefined,
    fixedEvents: fixedEvents.length ? [...new Set(fixedEvents)] : undefined,
  };
}

/** `[[IgnoredVulns]] id = "GHSA-..."` from osv-scanner.toml. */
export function loadOsvIgnores(root: string): Set<string> {
  const out = new Set<string>();
  try {
    for (const m of fs.readFileSync(path.join(root, "osv-scanner.toml"), "utf8").matchAll(/\[\[IgnoredVulns\]\][^[]*?id\s*=\s*"([^"]+)"/g)) out.add(m[1]!);
  } catch { /* absent */ }
  return out;
}

async function post(fetchFn: FetchFn, body: unknown): Promise<{ results?: { vulns?: { id: string }[] }[] } | null> {
  try {
    const r = await fetchFn(URL_BATCH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return r.ok ? (await r.json()) as { results?: { vulns?: { id: string }[] }[] } : null;
  } catch { return null; }
}

export interface ScaRaw {
  ecosystem: string; package: string; version: string;
  cves?: string[]; fixedIn?: string; upgradeTo?: string;
  baseSeverity?: Score;
  cvss?: { vector: string; score: number };
  risk?: RiskScore;
  kev?: { dateAdded: string; dueDate: string; ransomware: boolean };
  epss?: { epss: number; percentile: number };
}
export interface ScaResult { hits: ReconHit[]; packages: number; error?: string; notes?: string[] }

export async function scanPackages(pkgs: Pkg[], opts: { fetchFn?: FetchFn; ignore?: Set<string>; cache?: IntelCache; enrich?: boolean } = {}): Promise<ScaResult> {
  const fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init) as ReturnType<FetchFn>);
  const unique = [...new Map(pkgs.map((p) => [`${p.ecosystem}:${p.name}@${p.version}`, p])).values()];
  const hits: ReconHit[] = [];
  const details = new Map<string, Vuln>();
  const notes: string[] = [];
  for (let i = 0; i < unique.length; i += BATCH) {
    const slice = unique.slice(i, i + BATCH);
    const res = await post(fetchFn, { queries: slice.map((p) => ({ package: { name: p.name, ecosystem: p.ecosystem }, version: p.version })) });
    if (!res?.results) return { hits, packages: unique.length, error: "osv.dev unreachable or returned an error" };
    for (let k = 0; k < slice.length; k++) {
      for (const v of res.results[k]?.vulns ?? []) {
        if (opts.ignore?.has(v.id)) continue;
        let d = details.get(v.id);
        if (!d) {
          d = { id: v.id, summary: "", severity: "medium", aliases: [], cves: /^CVE-\d{4}-\d+$/i.test(v.id) ? [v.id.toUpperCase()] : [] };
          try {
            const r = await fetchFn(URL_VULN + encodeURIComponent(v.id), { method: "GET", headers: {}, body: "" });
            if (r.ok) d = parseDetail(await r.json() as Record<string, unknown>);
          } catch { /* keep the default */ }
          details.set(v.id, d);
        }
        const p = slice[k]!;
        hits.push({
          tool: "loam-sca", ruleId: v.id, file: p.file, line: 1, cls: "known-vulnerability", severity: d.severity, deterministic: true,
          message: `${p.name}@${p.version}: ${d.summary || v.id}${d.aliases.length ? ` (${d.aliases.join(", ")})` : ""}`,
          raw: {
            ecosystem: p.ecosystem, package: p.name, version: p.version, cves: d.cves,
            fixedIn: d.fixedEvents ? smallestFixAbove(d.fixedEvents, p.version) ?? undefined : undefined,
            baseSeverity: d.severity,
            ...(d.cvssVector && d.cvssScore !== undefined ? { cvss: { vector: d.cvssVector, score: d.cvssScore } } : {}),
          },
        });
      }
    }
  }

  // Package-level upgrade target: the highest fix that resolves every advisory hit for that package.
  const byPackage = new Map<string, string[]>();
  for (const h of hits) {
    const r = h.raw as ScaRaw;
    if (!r.fixedIn) continue;
    const key = `${r.ecosystem}:${r.package}`;
    byPackage.set(key, [...(byPackage.get(key) ?? []), r.fixedIn]);
  }
  for (const h of hits) {
    const r = h.raw as ScaRaw;
    const best = byPackage.get(`${r.ecosystem}:${r.package}`);
    if (best?.length) r.upgradeTo = maxOf(best) ?? undefined;
  }

  if (hits.length > 0 && opts.enrich !== false) {
    const ids = [...new Set(hits.flatMap((h) => (h.raw as ScaRaw).cves ?? []))];
    try {
      const e = await enrichCves(ids, { fetchFn, cache: opts.cache });
      notes.push(...e.notes);
      for (const h of hits) {
        const r = h.raw as ScaRaw;
        const cve = primaryCve(r.cves ?? [], h.ruleId);
        const kev = e.kev?.get(cve) ?? null;
        const epss = e.epss.get(cve);
        // A composite score needs at least one real-world signal; CVSS alone is the scanner's own severity.
        if (!kev && !epss) continue;
        const v = details.get(h.ruleId);
        const cvssScore = v?.cvssScore ?? severityToCvss(h.severity);
        const risk = scoreCve({ cveId: cve, cvssScore, published: v?.published, epssProbability: epss?.epss, kev, pocConfidence: "NONE" });
        r.risk = risk;
        if (kev) r.kev = { dateAdded: kev.dateAdded, dueDate: kev.dueDate, ransomware: kev.ransomware };
        if (epss) r.epss = { epss: epss.epss, percentile: epss.percentile };
        // Real-world signals may raise severity; they never lower the scanner's own assessment.
        const escalated = riskLabelToScore(risk.risk_label);
        if (scoreRank(escalated) > scoreRank(h.severity)) h.severity = escalated;
      }
    } catch {
      notes.push("enrichment_failed: KEV/EPSS enrichment threw; hits keep scanner severity");
    }
  }
  return { hits, packages: unique.length, ...(notes.length ? { notes } : {}) };
}

export async function runScaScan(root: string, opts: { fetchFn?: FetchFn; cache?: IntelCache } = {}): Promise<ScaResult> {
  const found = discover(root);
  const result = await scanPackages(found.pkgs, { ...opts, ignore: loadOsvIgnores(root) });
  const notes = [...(result.notes ?? [])];
  if (found.unsupported > 0) notes.push(`purl_skipped: ${found.unsupported} SBOM entries use purl types OSV cannot check (e.g. deb, github)`);
  return { ...result, ...(notes.length ? { notes } : {}) };
}

/** SARIF for the loam-sca scanner: security-severity, KEV tags and a dependency fingerprint per result. */
export function toSarif(hits: ReconHit[]): Record<string, unknown> {
  const rules = new Map<string, Record<string, unknown>>();
  const results: Record<string, unknown>[] = [];
  for (const h of hits) {
    const r = h.raw as ScaRaw;
    const inKev = !!r.kev;
    const rule = rules.get(h.ruleId) ?? {
      id: h.ruleId,
      shortDescription: { text: h.ruleId },
      properties: {
        "security-severity": String(r.risk?.components.cvss_score ?? 5.5),
        tags: ["security/vulnerability/dependency", ...(inKev || r.kev?.ransomware ? ["kev"] : []), ...(r.kev?.ransomware ? ["ransomware"] : [])],
      },
    };
    rules.set(h.ruleId, rule);
    results.push({
      ruleId: h.ruleId,
      level: inKev || r.risk?.risk_label === "CRITICAL" || r.risk?.risk_label === "HIGH" || h.severity === "critical" || h.severity === "high" ? "error" : h.severity === "medium" ? "warning" : "note",
      message: { text: h.message },
      locations: [{ physicalLocation: { artifactLocation: { uri: h.file }, region: { startLine: h.line } } }],
      partialFingerprints: { dependency: `${r.ecosystem}/${r.package}@${r.version}/${h.ruleId}` },
      properties: {
        ecosystem: r.ecosystem, package: r.package, version: r.version,
        ...(r.cves?.length ? { cves: r.cves } : {}),
        ...(r.fixedIn ? { fixedIn: r.fixedIn } : {}),
        ...(r.upgradeTo ? { upgradeTo: r.upgradeTo } : {}),
        ...(r.risk ? { risk: { score: r.risk.risk_score, label: r.risk.risk_label, urgency: r.risk.urgency } } : {}),
        ...(r.kev ? { kev: r.kev } : {}),
        ...(r.epss ? { epss: r.epss } : {}),
      },
    });
  }
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{ tool: { driver: { name: "loam-sca", informationUri: "https://osv.dev", rules: [...rules.values()] } }, results }],
  };
}
