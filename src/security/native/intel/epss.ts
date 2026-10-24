/**
 * EPSS probabilities from FIRST (api.first.org). Chunks of 100, one retry per
 * failed chunk, a chunk that still fails never sinks the batch; negative
 * markers are cached so CVEs EPSS simply has no score for are not re-asked.
 * Port of cve-intel clients.rs get_epss_lenient (MIT/Apache-2.0, Fazmin/cve-intel).
 */
import type { IntelCache } from "./cache.js";
import type { FetchFn } from "./kev.js";

export const EPSS_URL = "https://api.first.org/data/v1/epss";
const CHUNK = 100;
const TTL_EPSS = 3600;

export interface EpssScore { cve: string; epss: number; percentile: number }

export interface EpssResult { scores: Map<string, EpssScore>; missing: number; unreachable: boolean }

const realFetch: FetchFn = (url, init) => fetch(url, init) as ReturnType<FetchFn>;

/** Collect one response body into `out`; returns the scores it contributed. */
function keep(data: unknown, out: Map<string, EpssScore>): EpssScore[] {
  const rows = (data as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(rows)) return [];
  const added: EpssScore[] = [];
  for (const r of rows) {
    const o = r as Record<string, unknown>;
    if (typeof o.cve !== "string") continue;
    const epss = Number.parseFloat(String(o.epss ?? ""));
    const pct = Number.parseFloat(String(o.percentile ?? ""));
    if (!Number.isFinite(epss)) continue;
    const s: EpssScore = { cve: o.cve.toUpperCase(), epss, percentile: Number.isFinite(pct) ? pct : 0 };
    out.set(s.cve, s);
    added.push(s);
  }
  return added;
}

export async function epssFor(
  cveIds: string[],
  opts: { fetchFn?: FetchFn; cache?: IntelCache; sleep?: (ms: number) => Promise<void> } = {},
): Promise<EpssResult> {
  const fetchFn = opts.fetchFn ?? realFetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const out = new Map<string, EpssScore>();
  const toFetch: string[] = [];
  const seen = new Set<string>();
  for (const raw of cveIds) {
    const id = raw.toUpperCase();
    if (!/^CVE-\d{4}-\d+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const cached = opts.cache?.get<EpssScore | { available: false }>(`epss:${id}`);
    if (cached && "epss" in cached) out.set(id, cached);
    else if (!cached) toFetch.push(id); // absent -> fetch; negative marker -> skip
  }
  let answered = 0;
  let unreachable = false;
  for (let i = 0; i < toFetch.length; i += CHUNK) {
    const chunk = toFetch.slice(i, i + CHUNK);
    let data: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetchFn(`${EPSS_URL}?cve=${encodeURIComponent(chunk.join(","))}&limit=${chunk.length}`, { method: "GET", headers: { accept: "application/json" }, body: "" });
        if (r.ok) { data = await r.json(); break; }
      } catch { /* retry once */ }
      if (attempt === 0) await sleep(2000);
    }
    if (data === null) { unreachable = true; continue; }
    // The chunk was answered; CVEs EPSS has no score for get a negative marker.
    answered += chunk.length;
    const found = new Set(keep(data, out).map((s) => s.cve));
    for (const s of out.values()) if (found.has(s.cve)) opts.cache?.set(`epss:${s.cve}`, s, TTL_EPSS);
    for (const id of chunk) if (!found.has(id)) opts.cache?.set(`epss:${id}`, { available: false }, TTL_EPSS);
  }
  return { scores: out, missing: toFetch.length - answered, unreachable };
}
