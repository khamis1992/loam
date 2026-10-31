/** Financial & data analytics engine (blueprint §7.5), Loam-local: pure
 *  computation over user-supplied data (no market feeds — those are BYOK).
 *  Three capabilities: DCF valuation, comparable multiples, and the mechanical
 *  accounting audit (date contradictions, duplicate payments, invoice↔contract
 *  amount mismatches) that pairs with the legal matter audit trail. */

export interface DcfInput {
  /** Free cash flows per year, in order (year 1..n), positive numbers. */
  cashFlows: number[];
  /** Annual discount rate, e.g. 0.10 for 10%. */
  discountRate: number;
  /** Perpetual growth for the terminal value, e.g. 0.02. Must be < discountRate. */
  terminalGrowth: number;
  /** Net cash/debt adjustment added to the enterprise value (positive = cash). */
  netCash?: number;
}

export interface DcfResult {
  discountedFlows: Array<{ year: number; flow: number; presentValue: number }>;
  terminalValue: number;
  terminalPresentValue: number;
  enterpriseValue: number;
  equityValue: number;
}

export function computeDcf(input: DcfInput): DcfResult {
  const { cashFlows, discountRate, terminalGrowth } = input;
  if (!Array.isArray(cashFlows) || cashFlows.length === 0 || cashFlows.length > 50) throw new Error("cashFlows must be 1..50 values");
  if (!Number.isFinite(discountRate) || discountRate <= 0) throw new Error("discountRate must be > 0");
  if (!Number.isFinite(terminalGrowth) || terminalGrowth < 0 || terminalGrowth >= discountRate) throw new Error("terminalGrowth must be >= 0 and < discountRate");
  if (cashFlows.some((f) => !Number.isFinite(f))) throw new Error("cashFlows must be finite numbers");

  const discountedFlows = cashFlows.map((flow, i) => ({
    year: i + 1,
    flow,
    presentValue: flow / Math.pow(1 + discountRate, i + 1),
  }));
  const last = cashFlows[cashFlows.length - 1]!;
  const terminalValue = (last * (1 + terminalGrowth)) / (discountRate - terminalGrowth);
  const terminalPresentValue = terminalValue / Math.pow(1 + discountRate, cashFlows.length);
  const enterpriseValue = discountedFlows.reduce((sum, row) => sum + row.presentValue, 0) + terminalPresentValue;
  const equityValue = enterpriseValue + (input.netCash ?? 0);
  return { discountedFlows, terminalValue, terminalPresentValue, enterpriseValue, equityValue };
}

export interface MultiplesEntry { name: string; pe?: number; evEbitda?: number; revenueGrowth?: number }
export interface MultiplesResult { medianPe: number | null; medianEvEbitda: number | null; table: MultiplesEntry[] }

/** Median multiples across a comparable set — deliberately simple: medians are
 *  robust to a single crazy comp, and anything fancier implies data we do not
 *  fetch locally. */
export function compareMultiples(entries: MultiplesEntry[]): MultiplesResult {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 200) throw new Error("entries must be 1..200");
  const median = (values: number[]): number | null => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  };
  const pes = entries.map((e) => e.pe).filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);
  const evEbitdas = entries.map((e) => e.evEbitda).filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);
  return { medianPe: median(pes), medianEvEbitda: median(evEbitdas), table: entries };
}

export type AuditSeverity = "high" | "medium";

export interface LedgerEntry {
  id: string;
  kind: "invoice" | "payment" | "contract";
  /** Counterparty name (vendor/client). */
  party: string;
  amount: number;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  /** Optional contract reference linking invoices/payments to a contract. */
  contractId?: string;
}

export interface AuditFinding {
  severity: AuditSeverity;
  code: "duplicate-payment" | "date-contradiction" | "amount-mismatch";
  message: string;
  entryIds: string[];
}

const DAY_MS = 86_400_000;

function parseDate(iso: string): number | null {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? time : null;
}

/** Mechanical audit over user ledger rows — deterministic, explainable rules. */
export function auditLedger(entries: LedgerEntry[], duplicateWindowDays = 7): AuditFinding[] {
  if (!Array.isArray(entries) || entries.length > 5000) throw new Error("entries must be <= 5000");
  const findings: AuditFinding[] = [];

  // 1) Duplicate payments: same party + same amount within the window.
  const payments = entries.filter((e) => e.kind === "payment" && Number.isFinite(e.amount));
  for (let i = 0; i < payments.length; i += 1) {
    for (let j = i + 1; j < payments.length; j += 1) {
      const a = payments[i]!, b = payments[j]!;
      const ta = parseDate(a.date), tb = parseDate(b.date);
      if (ta === null || tb === null) continue;
      if (a.party === b.party && Math.abs(a.amount - b.amount) < 0.005 && Math.abs(ta - tb) <= duplicateWindowDays * DAY_MS) {
        findings.push({
          severity: "high",
          code: "duplicate-payment",
          message: `دفعتان متطابقتان لـ«${a.party}» بمبلغ ${a.amount} خلال ${duplicateWindowDays} أيام`,
          entryIds: [a.id, b.id],
        });
      }
    }
  }

  // 2) Date contradictions: payment recorded BEFORE its invoice date.
  const invoices = new Map(entries.filter((e) => e.kind === "invoice").map((e) => [e.id, e]));
  for (const payment of payments) {
    for (const invoice of invoices.values()) {
      if (invoice.party !== payment.party) continue;
      const tp = parseDate(payment.date), ti = parseDate(invoice.date);
      if (tp === null || ti === null) continue;
      if (tp < ti) {
        findings.push({
          severity: "medium",
          code: "date-contradiction",
          message: `دفعة لـ«${payment.party}» بتاريخ ${payment.date} تسبق الفاتورة المؤرخة ${invoice.date}`,
          entryIds: [payment.id, invoice.id],
        });
      }
    }
  }

  // 3) Invoice↔contract amount mismatch: invoice exceeds its contract amount.
  const contracts = new Map(entries.filter((e) => e.kind === "contract").map((e) => [e.id, e]));
  for (const invoice of invoices.values()) {
    if (!invoice.contractId) continue;
    const contract = contracts.get(invoice.contractId);
    if (!contract) continue;
    if (invoice.amount > contract.amount + 0.005) {
      findings.push({
        severity: "high",
        code: "amount-mismatch",
        message: `فاتورة «${invoice.party}» بمبلغ ${invoice.amount} تتجاوز سقف العقد ${contract.amount}`,
        entryIds: [invoice.id, contract.id],
      });
    }
  }

  return findings;
}

export interface StatementYear {
  year: number;
  revenue: number;
  netIncome: number;
  currentAssets: number;
  currentLiabilities: number;
}

export interface RatiosResult {
  rows: Array<{ year: number; netMargin: number; currentRatio: number; revenueGrowth: number | null }>;
}

/** Basic ratio analysis over 1..N historical years (most recent last). */
export function analyzeStatements(years: StatementYear[]): RatiosResult {
  if (!Array.isArray(years) || years.length === 0 || years.length > 20) throw new Error("years must be 1..20");
  const rows = years.map((year, i) => {
    if (!Number.isFinite(year.revenue) || year.revenue <= 0) throw new Error(`revenue for ${year.year} must be > 0`);
    const prior = i > 0 ? years[i - 1]! : null;
    return {
      year: year.year,
      netMargin: year.netIncome / year.revenue,
      currentRatio: year.currentLiabilities === 0 ? 0 : year.currentAssets / year.currentLiabilities,
      revenueGrowth: prior && prior.revenue > 0 ? year.revenue / prior.revenue - 1 : null,
    };
  });
  return { rows };
}
