/**
 * CISA KEV catalog: one JSON download, in-memory map, 6h TTL, GitHub-mirror
 * fallback. Never throws — an unavailable catalog is reported so callers can
 * say "risk scores are CVSS+EPSS only" instead of silently dropping KEV.
 * Port of cve-intel clients.rs kev_catalog (MIT/Apache-2.0, Fazmin/cve-intel).
 */
import type { IntelCache } from "./cache.js";

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export const KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";
export const KEV_FALLBACK_URL = "https://raw.githubusercontent.com/cisagov/kev-data/main/data/known_exploited_vulnerabilities.json";
const CACHE_KEY = "kev:catalog:v1";
const TTL_KEV = 6 * 3600;

export interface KevEntry { cve: string; dateAdded: string; dueDate: string; ransomware: boolean }
export type KevResult = { status: "ok"; entries: Map<string, KevEntry> } | { status: "unavailable"; reason: string };

let memo: KevResult | null = null;
let flight: Promise<KevResult> | null = null;
/** Test hook: drop the in-memory memo and single-flight slot. */
export function resetKevMemo(): void { memo = null; flight = null; }

function parseEntries(doc: unknown): KevEntry[] {
  const vulns = (doc as { vulnerabilities?: unknown[] } | null)?.vulnerabilities;
  if (!Array.isArray(vulns)) return [];
  const out: KevEntry[] = [];
  for (const v of vulns) {
    const o = v as Record<string, unknown>;
    const cve = typeof o.cveID === "string" ? o.cveID : "";
    if (!/^CVE-\d{4}-\d+$/i.test(cve)) continue;
    out.push({
      cve: cve.toUpperCase(),
      dateAdded: typeof o.dateAdded === "string" ? o.dateAdded : "",
      dueDate: typeof o.dueDate === "string" ? o.dueDate : "",
      ransomware: o.knownRansomwareCampaignUse === "Known" || o.knownRansomwareCampaignUse === true,
    });
  }
  return out;
}

const realFetch: FetchFn = (url, init) => fetch(url, init) as ReturnType<FetchFn>;

export async function loadKev(opts: { fetchFn?: FetchFn; cache?: IntelCache; force?: boolean } = {}): Promise<KevResult> {
  if (!opts.force && memo) return memo;
  if (flight) return flight;
  flight = (async (): Promise<KevResult> => {
    const fetchFn = opts.fetchFn ?? realFetch;
    const cache = opts.cache;
    if (!opts.force && cache) {
      const cached = cache.get<KevEntry[]>(CACHE_KEY);
      if (cached?.length) {
        memo = { status: "ok", entries: new Map(cached.map((e) => [e.cve, e])) };
        return memo;
      }
    }
    for (const url of [KEV_URL, KEV_FALLBACK_URL]) {
      try {
        const r = await fetchFn(url, { method: "GET", headers: { accept: "application/json" }, body: "" });
        if (!r.ok) continue;
        const entries = parseEntries(await r.json());
        if (entries.length > 0) {
          cache?.set(CACHE_KEY, entries, TTL_KEV);
          memo = { status: "ok", entries: new Map(entries.map((e) => [e.cve, e])) };
          return memo;
        }
      } catch { /* try the mirror */ }
    }
    memo = { status: "unavailable", reason: "KEV catalog unreachable (primary and mirror)" };
    return memo;
  })();
  try {
    return await flight;
  } finally {
    flight = null;
  }
}
