/**
 * SEC EDGAR reader (blueprint gap 3) — public, key-less company data.
 *
 * Three endpoints, all free and rate-limited to ~10 req/s by the SEC:
 *  - company_tickers.json    -> ticker/CIK directory (search substrate)
 *  - submissions/CIK....json -> recent filings (10-K/10-Q/...) with links
 *  - companyfacts/CIK....json-> every XBRL fact, distilled here into a compact
 *                               multi-year statement series
 *
 * Responses are cached in memory (tickers 24h, facts/submissions 15min) and
 * requests go through a politeness queue. `fetchJson` is injectable for tests.
 * The SEC asks for a declared contact in the User-Agent; override with
 * LOAM_EDGAR_CONTACT="you@example.com".
 */

export type Json = Record<string, unknown>;

/** Injectable fetch seam (tests swap it; prod uses global fetch). */
export type FetchJson = (url: string) => Promise<Json>;
const defaultFetchJson: FetchJson = async (url) => {
  // The SEC WAF 403s generic browser UAs and some mail domains (verified live:
  // users.noreply.github.com is blocked, a plain contact@ works). Override the
  // contact with LOAM_EDGAR_CONTACT="you@yourdomain.com".
  const contact = process.env.LOAM_EDGAR_CONTACT?.trim() || "contact@example.com";
  const res = await fetch(url, {
    headers: { "User-Agent": `Loam local agent research (${contact})`, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`EDGAR ${res.status} for ${url}`);
  return (await res.json()) as Json;
};
let fetchJson: FetchJson = defaultFetchJson;

/** Test seam: replace the transport (and clear the caches). */
export function __setFetchForTests(replacement: FetchJson | null): void {
  fetchJson = replacement ?? defaultFetchJson;
  tickerCache = undefined;
  directory = undefined;
  documentCache.clear();
}

const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const SUBMISSIONS_URL = "https://data.sec.gov/submissions/";
const FACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts/";

/** data.sec.gov paths need the zero-padded 10-digit CIK (CIK0000320193). */
function cikFile(cik: number): string {
  return `CIK${String(cik).padStart(10, "0")}.json`;
}

interface CacheEntry {
  at: number;
  value: Json;
}
const documentCache = new Map<string, CacheEntry>();
let tickerCache: CacheEntry | undefined;

/** Serialize host access so we stay well under the SEC's 10 req/s ceiling. */
let queue: Promise<unknown> = Promise.resolve();
function politely<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function cached(url: string, ttlMs: number): Promise<Json> {
  const hit = documentCache.get(url);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await politely(() => fetchJson(url));
  documentCache.set(url, { at: Date.now(), value });
  return value;
}

export interface CompanyDirectoryEntry {
  cik: number;
  ticker: string;
  title: string;
}

let directory: CompanyDirectoryEntry[] | undefined;

/** The whole ticker/CIK directory, fetched once per process (24h TTL). */
async function getDirectory(): Promise<CompanyDirectoryEntry[]> {
  if (directory) return directory;
  const cachedTickers = tickerCache;
  const hit = cachedTickers !== undefined && Date.now() - cachedTickers.at < 24 * 3600_000;
  const raw = hit && cachedTickers ? cachedTickers.value : await cached(TICKERS_URL, 24 * 3600_000);
  const out: CompanyDirectoryEntry[] = [];
  for (const entry of Object.values(raw)) {
    const item = entry as Record<string, unknown>;
    if (typeof item.cik_str === "number" && typeof item.ticker === "string" && typeof item.title === "string") {
      out.push({ cik: item.cik_str, ticker: item.ticker, title: item.title });
    }
  }
  directory = out;
  return out;
}

/** Resolve a ticker or a name fragment to directory entries (exact ticker first). */
export async function findCompanies(query: string, limit = 8): Promise<CompanyDirectoryEntry[]> {
  const dir = await getDirectory();
  const needle = query.trim().toUpperCase();
  if (needle === "") return [];
  const byTicker = dir.filter((entry) => entry.ticker.toUpperCase() === needle);
  if (byTicker.length > 0) return byTicker.slice(0, limit);
  const words = needle.split(/\s+/);
  const matches = dir.filter((entry) => {
    const title = entry.title.toUpperCase();
    return words.every((word) => title.includes(word));
  });
  return matches.slice(0, limit);
}

export interface FilingRef {
  form: string;
  filingDate: string;
  reportDate: string;
  accessionNumber: string;
  primaryDocument: string;
  link: string;
}

/** Recent filings for a CIK, newest first. */
export async function edgarFilings(cik: number, form?: string, limit = 15): Promise<FilingRef[]> {
  const raw = await cached(`${SUBMISSIONS_URL}${cikFile(cik)}`, 15 * 60_000);
  // submissions docs nest the arrays under `filings.recent` (older history
  // lives in `filings.files`, out of scope here); accept a flat doc too.
  const container = (raw.filings ?? raw) as Json;
  const recent = container.recent as Record<string, unknown[]> | undefined;
  if (!recent || !Array.isArray(recent.form)) return [];
  const out: FilingRef[] = [];
  // The arrays are parallel and newest-first.
  for (let i = 0; i < recent.form.length && out.length < limit; i++) {
    const entryForm = String(recent.form[i]);
    if (form && entryForm.toUpperCase() !== form.toUpperCase()) continue;
    const accessionNumber = String(recent.accessionNumber?.[i] ?? "");
    const primaryDocument = String(recent.primaryDocument?.[i] ?? "");
    out.push({
      form: entryForm,
      filingDate: String(recent.filingDate?.[i] ?? ""),
      reportDate: String(recent.reportDate?.[i] ?? ""),
      accessionNumber,
      primaryDocument,
      link: `https://www.sec.gov/Archives/edgar/data/${cik}/${accessionNumber.replace(/-/g, "")}/${primaryDocument}`,
    });
  }
  return out;
}

export interface YearFinancials {
  /** Period end (instant tags) or fiscal year end (duration tags), ISO date. */
  end: string;
  revenue?: number;
  operatingIncome?: number;
  netIncome?: number;
  operatingCashFlow?: number;
  assets?: number;
  liabilities?: number;
  equity?: number;
  cash?: number;
  research?: number;
  longTermDebt?: number;
  sharesOutstanding?: number;
}

export interface CompanyFinancials {
  cik: number;
  ticker: string;
  title: string;
  /** Newest fiscal year first, capped at 6 years. */
  years: YearFinancials[];
}

interface FactPoint {
  end: string;
  val: number;
  form?: string;
  fy?: number;
  fp?: string;
  frame?: string;
}

function factPoints(namespace: Json | undefined, tag: string): FactPoint[] {
  const node = namespace?.[tag] as Json | undefined;
  const units = node?.units as Json | undefined;
  const usd = units?.USD as unknown[] | undefined;
  if (!Array.isArray(usd)) return [];
  const out: FactPoint[] = [];
  for (const raw of usd) {
    const point = raw as Record<string, unknown>;
    if (typeof point.end !== "string" || typeof point.val !== "number") continue;
    out.push({
      end: point.end,
      val: point.val,
      form: typeof point.form === "string" ? point.form : undefined,
      fy: typeof point.fy === "number" ? point.fy : undefined,
      fp: typeof point.fp === "string" ? point.fp : undefined,
      frame: typeof point.frame === "string" ? point.frame : undefined,
    });
  }
  return out;
}

/** Prefer frame-tagged (SEC-standardized) points, then 10-K annual points.
 *  Interim (10-Q-only) snapshots are dropped: the series is annual statements. */
function annualByEnd(points: FactPoint[], kind: "duration" | "instant"): Map<string, number> {
  const best = new Map<string, { rank: number; val: number }>();
  for (const point of points) {
    const isAnnualForm = point.form === "10-K";
    // Annual-only series: quarterly snapshots (10-Q form, CY....Q#I frames) are dropped.
    const isAnnualFrame = point.frame !== undefined && !point.frame.includes("Q");
    if (!isAnnualForm && !isAnnualFrame) continue;
    const year = Number.parseInt(point.end.slice(0, 4), 10);
    if (!Number.isFinite(year)) continue;
    if (kind === "duration" && point.fp && point.fp !== "FY" && !point.frame) continue;
    const yearEnd = point.end.slice(5, 10) === "12-31";
    let rank = 0;
    if (point.frame && yearEnd) rank = 3;
    else if (isAnnualForm && yearEnd) rank = 2;
    else rank = 1;
    const previous = best.get(point.end);
    if (!previous || rank > previous.rank) best.set(point.end, { rank, val: point.val });
  }
  const out = new Map<string, number>();
  for (const [end, choice] of best) out.set(end, choice.val);
  return out;
}

/** One point per calendar year (the latest end wins), keyed by the end date. */
function collapseToYearly(byEnd: Map<string, number>, maxYears: number): Map<string, number> {
  const latestEndPerYear = new Map<number, string>();
  for (const end of byEnd.keys()) {
    const year = Number.parseInt(end.slice(0, 4), 10);
    const current = latestEndPerYear.get(year);
    if (!current || end > current) latestEndPerYear.set(year, end);
  }
  const years = [...latestEndPerYear.keys()].sort((a, b) => b - a).slice(0, maxYears);
  const out = new Map<string, number>();
  for (const year of years) {
    const end = latestEndPerYear.get(year);
    if (end !== undefined) out.set(end, byEnd.get(end) as number);
  }
  return out;
}

function mergeYears(statementMaps: Array<Map<string, number>>, attachMaps: Array<Map<string, number>>, maxYears: number): YearFinancials[] {
  // The statement year grid comes from the balance-sheet (instant) dates — a
  // cover-date fact (e.g. dei shares outstanding) must never fabricate a year.
  const gridEnds = new Set<string>();
  for (const map of statementMaps) for (const end of map.keys()) gridEnds.add(end);
  if (gridEnds.size === 0) for (const map of attachMaps) for (const end of map.keys()) gridEnds.add(end);
  const sortedEnds = [...gridEnds].sort((a, b) => b.localeCompare(a)).slice(0, maxYears);
  const pick = (map: Map<string, number>, end: string): number | undefined => {
    if (map.has(end)) return map.get(end);
    const year = end.slice(0, 4);
    for (const [candidate, val] of map) if (candidate.slice(0, 4) === year) return val;
    return undefined;
  };
  // Array destructuring keeps the indexed access strict-safe.
  const [revenue, operatingIncome, netIncome, operatingCashFlow, assets, liabilities, equity, cash, research, longTermDebt, shares] = attachMaps;
  return sortedEnds.map((end) => ({
    end,
    revenue: revenue ? pick(revenue, end) : undefined,
    operatingIncome: operatingIncome ? pick(operatingIncome, end) : undefined,
    netIncome: netIncome ? pick(netIncome, end) : undefined,
    operatingCashFlow: operatingCashFlow ? pick(operatingCashFlow, end) : undefined,
    assets: assets ? pick(assets, end) : undefined,
    liabilities: liabilities ? pick(liabilities, end) : undefined,
    equity: equity ? pick(equity, end) : undefined,
    cash: cash ? pick(cash, end) : undefined,
    research: research ? pick(research, end) : undefined,
    longTermDebt: longTermDebt ? pick(longTermDebt, end) : undefined,
    sharesOutstanding: shares ? pick(shares, end) : undefined,
  }));
}

/** Distilled multi-year financials for a directory entry. */
export async function edgarCompanyFinancials(entry: CompanyDirectoryEntry): Promise<CompanyFinancials> {
  const raw = await cached(`${FACTS_URL}${cikFile(entry.cik)}`, 15 * 60_000);
  // companyfacts wraps the taxonomies under `facts` (us-gaap, dei, ifrs-full).
  const facts = (raw.facts ?? raw) as Json;
  const usGaap = facts["us-gaap"] as Json | undefined;
  const pickTag = (tags: string[], kind: "duration" | "instant"): Map<string, number> => {
    // Companies rename tags over the years (Revenues -> RevenueFromContract...):
    // pick the tag whose annual series reaches the newest period, not the first
    // tag that merely has any history.
    let best: Map<string, number> | undefined;
    let bestNewest = "";
    for (const tag of tags) {
      const map = collapseToYearly(annualByEnd(factPoints(usGaap, tag), kind), 6);
      if (map.size === 0) continue;
      const newest = [...map.keys()].sort().at(-1) ?? "";
      if (!best || newest > bestNewest) {
        best = map;
        bestNewest = newest;
      }
    }
    return best ?? new Map();
  };
  const revenue = pickTag(["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet"], "duration");
  const operatingIncome = pickTag(["OperatingIncomeLoss"], "duration");
  const netIncome = pickTag(["NetIncomeLoss"], "duration");
  const operatingCashFlow = pickTag(["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingContinuingOperations"], "duration");
  const assets = pickTag(["Assets"], "instant");
  const liabilities = pickTag(["Liabilities"], "instant");
  const equity = pickTag(["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"], "instant");
  const cash = pickTag(["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"], "instant");
  const research = pickTag(["ResearchAndDevelopmentExpense"], "duration");
  const longTermDebt = pickTag(["LongTermDebtNoncurrent", "LongTermDebt"], "instant");
  const deiNamespace = facts.dei as Json | undefined;
  const shares = collapseToYearly(annualByEnd(factPoints(deiNamespace, "EntityCommonStockSharesOutstanding"), "instant"), 6);
  const years = mergeYears(
    [assets, liabilities, equity, cash],
    [revenue, operatingIncome, netIncome, operatingCashFlow, assets, liabilities, equity, cash, research, longTermDebt, shares],
    6,
  );
  return { cik: entry.cik, ticker: entry.ticker, title: entry.title, years };
}
