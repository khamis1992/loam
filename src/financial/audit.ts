/**
 * Financial audit checks (blueprint gap 3).
 *
 * Structured red-flag review of the distilled EDGAR series: accounting
 * identity, solvency, earnings quality and trend anomalies. Findings are
 * facts with severity — the agent presents them, never silently drops one.
 */
import type { CompanyFinancials, YearFinancials } from "./edgar.js";

export interface AuditFinding {
  check: string;
  severity: "info" | "warning" | "critical";
  detail: string;
}

function defined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function fmt(amount: number | undefined): string {
  if (amount === undefined) return "n/a";
  if (Math.abs(amount) >= 1e9) return `${(amount / 1e9).toFixed(2)}B`;
  if (Math.abs(amount) >= 1e6) return `${(amount / 1e6).toFixed(1)}M`;
  return amount.toFixed(0);
}

function latestYear(financials: CompanyFinancials): YearFinancials | undefined {
  return financials.years.find((year) => defined(year.assets) && defined(year.liabilities));
}

/** Run every audit check over the company series; returns findings (may be empty). */
export function auditCompany(financials: CompanyFinancials): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const push = (check: string, severity: AuditFinding["severity"], detail: string): void => {
    findings.push({ check, severity, detail });
  };
  const now = latestYear(financials);
  if (!now) {
    push("data-coverage", "warning", "no complete balance sheet in the distilled series; audit depth is limited");
    return findings;
  }

  // 1. Accounting identity A = L + E on the latest year.
  if (defined(now.assets) && defined(now.liabilities) && defined(now.equity)) {
    const gap = now.assets - (now.liabilities + now.equity);
    const relative = Math.abs(gap) / now.assets;
    if (relative > 0.01) {
      push("balance-identity", "critical", `assets (${fmt(now.assets)}) != liabilities+equity (${fmt(now.liabilities + (now.equity ?? 0))}); gap ${fmt(gap)} (${(relative * 100).toFixed(1)}% of assets)`);
    }
  }

  // 2. Negative equity.
  if (defined(now.equity) && now.equity < 0) {
    push("negative-equity", "critical", `shareholders equity is negative (${fmt(now.equity)}) on the latest balance sheet`);
  }

  // 3. Liquidity.
  if (defined(now.cash) && defined(now.liabilities) && now.cash / now.liabilities < 0.05 && now.liabilities > 0) {
    push("cash-cushion", "warning", `cash covers only ${((now.cash / now.liabilities) * 100).toFixed(1)}% of total liabilities`);
  }

  // 4. Leverage trend.
  const withEquity = financials.years.filter((year) => defined(year.liabilities) && defined(year.equity) && year.equity !== 0);
  const newestEquityYear = withEquity[0];
  const oldestEquityYear = withEquity.at(-1);
  if (withEquity.length >= 3 && newestEquityYear && oldestEquityYear && defined(newestEquityYear.liabilities) && defined(oldestEquityYear.liabilities)) {
    const newest = newestEquityYear.liabilities / (newestEquityYear.equity as number);
    const oldest = oldestEquityYear.liabilities / (oldestEquityYear.equity as number);
    if (newest > 2.5 && newest > oldest * 1.5) {
      push("leverage-trend", "warning", `debt/equity rose from ${oldest.toFixed(2)} to ${newest.toFixed(2)} over the window`);
    }
  }

  // 5. Earnings quality: net income persistently above operating cash flow.
  const quality = financials.years.filter((year) => defined(year.netIncome) && defined(year.operatingCashFlow));
  const diverging = quality.filter((year) => (year.netIncome as number) > (year.operatingCashFlow as number));
  if (quality.length >= 3 && diverging.length === quality.length) {
    push("earnings-quality", "warning", `net income exceeded operating cash flow in all ${diverging.length} years — accrual-heavy earnings`);
  } else if (quality.length >= 3 && diverging.length >= quality.length - 1 && (diverging[0]?.netIncome ?? 0) > 0) {
    push("earnings-quality", "info", `net income exceeded operating cash flow in ${diverging.length}/${quality.length} years`);
  }

  // 6. Revenue trend vs margin stability.
  const revenueYears = financials.years.filter((year) => defined(year.revenue) && year.revenue !== 0);
  const newestRevenue = revenueYears[0]?.revenue;
  const oldestRevenue = revenueYears.at(-1)?.revenue;
  if (revenueYears.length >= 3 && defined(newestRevenue) && defined(oldestRevenue)) {
    const growth = (newestRevenue / oldestRevenue - 1) * 100;
    push("revenue-trend", "info", `revenue moved ${growth >= 0 ? "+" : ""}${growth.toFixed(1)}% across the ${revenueYears.length}-year window (${fmt(oldestRevenue)} -> ${fmt(newestRevenue)})`);
  }
  const marginYears = financials.years.filter((year) => defined(year.revenue) && year.revenue > 0 && defined(year.netIncome));
  if (marginYears.length >= 3) {
    const margins = marginYears.map((year) => ((year.netIncome as number) / (year.revenue as number)) * 100);
    const swing = Math.max(...margins) - Math.min(...margins);
    if (swing > 15) {
      push("margin-swing", "warning", `net margin swung ${(Math.max(...margins) - Math.min(...margins)).toFixed(1)}pp across the window (${Math.min(...margins).toFixed(1)}% to ${Math.max(...margins).toFixed(1)}%)`);
    }
  }

  // 7. R&D against revenue (info for context).
  const rdYear = financials.years.find((year) => defined(year.research) && defined(year.revenue) && year.revenue > 0);
  if (rdYear) {
    push("rd-intensity", "info", `R&D was ${(((rdYear.research as number) / (rdYear.revenue as number)) * 100).toFixed(1)}% of revenue in FY${rdYear.end.slice(0, 4)}`);
  }

  return findings;
}
