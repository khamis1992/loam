/**
 * Financial analytics tools (blueprint gap 3).
 *
 * Local math tools (valuation, ratios, time value, amortization, Benford) plus
 * a key-less SEC EDGAR reader (company series, filings, structured audit
 * findings). The EDGAR tools are the only networked ones and go through
 * src/financial/edgar.ts with its cache + politeness queue; everything else is
 * pure computation.
 */
import { amortize, benfordFirstDigits, BENFORD_EXPECTED, capmCostOfEquity, dcf, irr, npv, ratios, wacc } from "../financial/core.js";
import { auditCompany, type AuditFinding } from "../financial/audit.js";
import { edgarCompanyFinancials, edgarFilings, findCompanies, type CompanyDirectoryEntry } from "../financial/edgar.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { num, str } from "./registry.js";

/** Read a numeric array argument (empty when absent/invalid). */
function nums(args: Record<string, unknown>, key: string): number[] {
  const raw = args[key];
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const item of raw) {
    const value = typeof item === "number" ? item : Number(item);
    if (Number.isFinite(value)) out.push(value);
  }
  return out;
}

function pct(value: number): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "n/a";
}

function money(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return "n/a";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(2)}`;
}

function ratioNum(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "n/a";
}

function formatFindings(findings: AuditFinding[]): string {
  if (findings.length === 0) return "no findings";
  const order: Record<AuditFinding["severity"], number> = { critical: 0, warning: 1, info: 2 };
  return [...findings]
    .sort((a, b) => order[a.severity] - order[b.severity])
    .map((finding) => `[${finding.severity.toUpperCase()}] ${finding.check}: ${finding.detail}`)
    .join("\n");
}

/** Resolve a ticker/name to exactly one company, or explain the ambiguity. */
async function resolveOne(query: string): Promise<{ ok: true; entry: CompanyDirectoryEntry } | { ok: false; message: string }> {
  const matches = await findCompanies(query, 6);
  const first = matches[0];
  if (matches.length === 0 || !first) return { ok: false, message: `no EDGAR company matches "${query}"` };
  if (matches.length > 1 && first.ticker.toUpperCase() !== query.trim().toUpperCase()) {
    return { ok: false, message: `ambiguous query "${query}" — candidates: ${matches.slice(0, 5).map((m) => `${m.ticker} (${m.title})`).join(", ")}` };
  }
  return { ok: true, entry: first };
}

export function createFinancialTools(): Tool[] {
  return [
    {
      name: "finance_dcf",
      description:
        "Discounted cash flow valuation. Give a base free cash flow, explicit yearly growth rates, terminal growth and a discount rate (or CAPM/WACC components). Returns per-year projections, present values, terminal value, enterprise/equity value, per-share value and the terminal-share reliance flag. Purely local math.",
      parameters: {
        type: "object",
        properties: {
          base_fcf: { type: "number", description: "Free cash flow of the base (last actual) year." },
          growth_rates: { type: "array", items: { type: "number" }, description: "Growth rate per explicit projection year, e.g. [0.15, 0.12, 0.09, 0.06, 0.04]." },
          terminal_growth: { type: "number", description: "Perpetuity growth after the window (typical 0.015-0.025). Default 0.02." },
          discount_rate: { type: "number", description: "Discount rate (WACC). Provide this OR the wacc components below." },
          capm: { type: "object", description: "WACC components: risk_free, beta, equity_risk_premium, cost_of_debt, tax_rate, equity_value, debt_value.", properties: {
            risk_free: { type: "number" }, beta: { type: "number" }, equity_risk_premium: { type: "number" },
            cost_of_debt: { type: "number" }, tax_rate: { type: "number" }, equity_value: { type: "number" }, debt_value: { type: "number" },
          } },
          net_debt: { type: "number", description: "Net debt subtracted from enterprise value to get equity value." },
          shares_outstanding: { type: "number", description: "Diluted shares, for per-share value." },
        },
        required: ["base_fcf", "growth_rates"],
      },
      async run(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
        const baseFcf = num(args, "base_fcf", 0);
        const growthRates = nums(args, "growth_rates");
        if (!(baseFcf > 0)) return { ok: false, content: "base_fcf must be positive" };
        if (growthRates.length === 0) return { ok: false, content: "growth_rates must list at least one year" };
        const terminalGrowth = num(args, "terminal_growth", 0.02);
        let discountRate = num(args, "discount_rate", 0);
        let waccNote = "provided discount rate";
        const capmRaw = args.capm;
        if (!discountRate && capmRaw && typeof capmRaw === "object" && !Array.isArray(capmRaw)) {
          const c = capmRaw as Record<string, unknown>;
          const costOfEquity = capmCostOfEquity(num(c, "risk_free", 0), num(c, "beta", 1), num(c, "equity_risk_premium", 0));
          discountRate = wacc({
            costOfEquity,
            costOfDebt: num(c, "cost_of_debt", 0),
            taxRate: num(c, "tax_rate", 0),
            equityValue: num(c, "equity_value", 0),
            debtValue: num(c, "debt_value", 0),
          });
          waccNote = `WACC from CAPM components (cost of equity ${pct(costOfEquity)})`;
        }
        if (!(discountRate > 0)) return { ok: false, content: "provide discount_rate or full capm components" };
        if (discountRate <= terminalGrowth) return { ok: false, content: `discount rate (${pct(discountRate)}) must exceed terminal growth (${pct(terminalGrowth)})` };
        let result;
        try {
          result = dcf({ baseFreeCashFlow: baseFcf, growthRates, terminalGrowth, discountRate, netDebt: num(args, "net_debt", 0), sharesOutstanding: args.shares_outstanding === undefined ? undefined : num(args, "shares_outstanding", 0) });
        } catch (err) {
          return { ok: false, content: err instanceof Error ? err.message : String(err) };
        }
        const lines = [
          `discount: ${waccNote} = ${pct(discountRate)}, terminal growth ${pct(terminalGrowth)}`,
          ...result.projectedFlows.map((flow, index) => `year ${index + 1}: fcf ${money(flow)} -> pv ${money(result.presentValues[index])} (growth ${pct(growthRates[index] ?? 0)})`),
          `pv of explicit window: ${money(result.pvExplicit)}`,
          `terminal value: ${money(result.terminalValue)} (pv ${money(result.pvTerminal)}, implied exit multiple ${result.impliedExitMultiple.toFixed(1)}x)`,
          `enterprise value: ${money(result.enterpriseValue)}`,
          `equity value: ${money(result.equityValue)}${result.valuePerShare !== null ? ` (${result.valuePerShare.toFixed(2)} per share)` : ""}`,
          `terminal reliance: ${pct(result.terminalShare)}${result.terminalShare > 0.75 ? " — WARNING: over 75% of value sits in the terminal value; widen the explicit window" : ""}`,
        ];
        return { ok: true, content: lines.join("\n") };
      },
    },
    {
      name: "finance_ratios",
      description:
        "Compute the standard ratio card (liquidity, leverage, profitability, efficiency) from one balance sheet and one income statement. Purely local math; NaN ratios are shown as n/a.",
      parameters: {
        type: "object",
        properties: {
          balance: { type: "object", description: "current_assets, inventory, cash, current_liabilities, total_assets, total_liabilities, equity.", properties: {
            current_assets: { type: "number" }, inventory: { type: "number" }, cash: { type: "number" },
            current_liabilities: { type: "number" }, total_assets: { type: "number" }, total_liabilities: { type: "number" }, equity: { type: "number" },
          }, required: ["current_assets", "current_liabilities", "total_assets", "total_liabilities", "equity"] },
          income: { type: "object", description: "revenue, cost_of_revenue, operating_expenses, interest_expense, net_income.", properties: {
            revenue: { type: "number" }, cost_of_revenue: { type: "number" }, operating_expenses: { type: "number" }, interest_expense: { type: "number" }, net_income: { type: "number" },
          }, required: ["revenue", "net_income"] },
        },
        required: ["balance", "income"],
      },
      async run(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
        const b = args.balance as Record<string, unknown> | undefined;
        const i = args.income as Record<string, unknown> | undefined;
        if (!b || !i) return { ok: false, content: "balance and income objects are required" };
        const card = ratios(
          {
            currentAssets: num(b, "current_assets", 0),
            inventory: num(b, "inventory", 0),
            cash: num(b, "cash", 0),
            currentLiabilities: num(b, "current_liabilities", 0),
            totalAssets: num(b, "total_assets", 0),
            totalLiabilities: num(b, "total_liabilities", 0),
            shareholdersEquity: num(b, "equity", 0),
          },
          {
            revenue: num(i, "revenue", 0),
            costOfRevenue: num(i, "cost_of_revenue", 0),
            operatingExpenses: num(i, "operating_expenses", 0),
            interestExpense: num(i, "interest_expense", 0),
            netIncome: num(i, "net_income", 0),
          },
        );
        const lines = [
          `liquidity: current ${ratioNum(card.currentRatio)}, quick ${ratioNum(card.quickRatio)}, cash ${ratioNum(card.cashRatio)}, working capital ${money(card.workingCapital)}`,
          `leverage: debt/equity ${ratioNum(card.debtToEquity)}, debt/assets ${ratioNum(card.debtToAssets)}, interest coverage ${ratioNum(card.interestCoverage)}x`,
          `profitability: gross ${pct(card.grossMargin)}, operating ${pct(card.operatingMargin)}, net ${pct(card.netMargin)}, ROE ${pct(card.roe)}, ROA ${pct(card.roa)}`,
          `efficiency: asset turnover ${ratioNum(card.assetTurnover)}x`,
        ];
        return { ok: true, content: lines.join("\n") };
      },
    },
    {
      name: "finance_npv_irr",
      description: "Net present value at a rate and internal rate of return for a cash-flow series (flows[0] is t=0). Purely local math.",
      parameters: {
        type: "object",
        properties: {
          flows: { type: "array", items: { type: "number" }, description: "Cash flows in order; flows[0] is today (usually negative)." },
          rate: { type: "number", description: "Discount rate per period for NPV (e.g. 0.08 annual). Default 0.1." },
        },
        required: ["flows"],
      },
      async run(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
        const flows = nums(args, "flows");
        if (flows.length < 2) return { ok: false, content: "flows needs at least two entries" };
        const rate = num(args, "rate", 0.1);
        const internal = irr(flows);
        const lines = [
          `npv at ${pct(rate)}: ${money(npv(rate, flows))}`,
          `irr: ${internal === null ? "no solution in [-99.99%, 1000%] (sign pattern has no crossover)" : pct(internal)}`,
        ];
        return { ok: true, content: lines.join("\n") };
      },
    },
    {
      name: "finance_amortize",
      description: "Level-payment loan amortization schedule with per-period breakdown and totals. Purely local math.",
      parameters: {
        type: "object",
        properties: {
          principal: { type: "number" }, annual_rate: { type: "number", description: "Nominal annual rate, e.g. 0.065." },
          years: { type: "number" }, payments_per_year: { type: "number", description: "12 for monthly. Default 12." },
        },
        required: ["principal", "annual_rate", "years"],
      },
      async run(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
        const principal = num(args, "principal", 0);
        const annualRate = num(args, "annual_rate", NaN);
        const years = num(args, "years", 0);
        const perYear = num(args, "payments_per_year", 12);
        if (!(principal > 0) || !(years > 0) || !(perYear > 0) || !Number.isFinite(annualRate) || annualRate < 0) {
          return { ok: false, content: "principal/years must be positive and annual_rate non-negative" };
        }
        const schedule = amortize(principal, annualRate, years, perYear);
        const firstRow = schedule.rows[0];
        const finalRow = schedule.rows.at(-1);
        if (!firstRow || !finalRow) return { ok: false, content: "amortization produced no rows" };
        const lines = [
          `payment: ${money(firstRow.payment)} every period, ${schedule.rows.length} periods`,
          `total paid: ${money(schedule.totalPaid)} (interest ${money(schedule.totalInterest)}, ${(schedule.totalInterest / principal * 100).toFixed(1)}% of principal)`,
          "first rows:",
          ...schedule.rows.slice(0, 6).map((row) => `  #${row.period}: interest ${money(row.interest)}, principal ${money(row.principal)}, balance ${money(row.balance)}`),
        ];
        if (schedule.rows.length > 6) lines.push(`  ... (${schedule.rows.length - 6} more, final balance ${money(finalRow.balance)})`);
        return { ok: true, content: lines.join("\n") };
      },
    },
    {
      name: "finance_company",
      description:
        "Public company financials from SEC EDGAR (no key needed): resolve a ticker or name, then return a compact multi-year series (revenue, operating income, net income, operating cash flow, assets, liabilities, equity, cash, R&D, debt, shares) plus a ratio card for the latest year. Cached; first call for a company takes a few seconds.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Ticker (AAPL) or company name fragment (Apple Inc)." } },
        required: ["query"],
      },
      async run(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
        const resolved = await resolveOne(str(args, "query"));
        if (!resolved.ok) return { ok: false, content: resolved.message };
        try {
          const financials = await edgarCompanyFinancials(resolved.entry);
          const lines = [`${financials.title} (${financials.ticker}, CIK ${financials.cik}) — newest year first`];
          for (const year of financials.years) {
            lines.push(`FY${year.end.slice(0, 4)} (end ${year.end}): revenue ${money(year.revenue)}, op income ${money(year.operatingIncome)}, net ${money(year.netIncome)}, ocf ${money(year.operatingCashFlow)}; assets ${money(year.assets)}, liab ${money(year.liabilities)}, equity ${money(year.equity)}, cash ${money(year.cash)}${year.research !== undefined ? `, r&d ${money(year.research)}` : ""}${year.sharesOutstanding !== undefined ? `, shares ${money(year.sharesOutstanding)}` : ""}`);
          }
          const latest = financials.years[0];
          if (latest && latest.assets && latest.liabilities && latest.equity && latest.revenue) {
            const card = ratios(
              { currentAssets: latest.cash ?? 0, inventory: 0, cash: latest.cash ?? 0, currentLiabilities: 0, totalAssets: latest.assets, totalLiabilities: latest.liabilities, shareholdersEquity: latest.equity },
              { revenue: latest.revenue, costOfRevenue: 0, operatingExpenses: latest.revenue - (latest.operatingIncome ?? 0), interestExpense: 0, netIncome: latest.netIncome ?? 0 },
            );
            lines.push(`latest-year ratios: net margin ${pct(card.netMargin)}, ROE ${pct(card.roe)}, ROA ${pct(card.roa)}, debt/equity ${ratioNum(card.debtToEquity)}, debt/assets ${ratioNum(card.debtToAssets)}`);
            lines.push("(current/quick ratios need current-liabilities detail — run finance_ratios with the 10-K figures for the full card)");
          }
          return { ok: true, content: lines.join("\n") };
        } catch (err) {
          return { ok: false, content: `EDGAR fetch failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      name: "finance_filings",
      description: "Recent SEC filings for a company (10-K, 10-Q, 8-K...) with direct document links. No key needed.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Ticker or company name fragment." },
          form: { type: "string", description: "Filter by form type, e.g. 10-K. Default: all forms." },
          limit: { type: "number", description: "Maximum filings. Default 10." },
        },
        required: ["query"],
      },
      async run(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
        const resolved = await resolveOne(str(args, "query"));
        if (!resolved.ok) return { ok: false, content: resolved.message };
        try {
          const filings = await edgarFilings(resolved.entry.cik, str(args, "form") || undefined, Math.min(Math.max(num(args, "limit", 10), 1), 40));
          if (filings.length === 0) return { ok: true, content: `no filings found${str(args, "form") ? ` for form ${str(args, "form")}` : ""}` };
          const lines = filings.map((f) => `${f.filingDate} ${f.form} (period ${f.reportDate}): ${f.link}`);
          return { ok: true, content: [`filings for ${resolved.entry.title} (${resolved.entry.ticker}):`, ...lines].join("\n") };
        } catch (err) {
          return { ok: false, content: `EDGAR fetch failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      name: "finance_audit",
      description:
        "Structured red-flag review of a public company's EDGAR series: accounting identity, negative equity, cash cushion, leverage trend, earnings quality (net income vs operating cash flow), margin swings. Returns findings ordered critical -> warning -> info.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Ticker or company name fragment." } },
        required: ["query"],
      },
      async run(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
        const resolved = await resolveOne(str(args, "query"));
        if (!resolved.ok) return { ok: false, content: resolved.message };
        try {
          const financials = await edgarCompanyFinancials(resolved.entry);
          return { ok: true, content: [`audit of ${financials.title} (${financials.ticker}):`, formatFindings(auditCompany(financials))].join("\n") };
        } catch (err) {
          return { ok: false, content: `EDGAR fetch failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      name: "finance_benford",
      description:
        "Benford first-digit analysis of a list of positive amounts (invoices, ledger entries): observed vs expected frequencies with the mean absolute deviation. A large deviation on many entries is a classic fabrication signal — treat it as a prompt to investigate, never as proof.",
      parameters: {
        type: "object",
        properties: { amounts: { type: "array", items: { type: "number" }, description: "Positive amounts; non-positive/invalid entries are ignored." } },
        required: ["amounts"],
      },
      async run(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
        const amounts = nums(args, "amounts");
        const usable = amounts.filter((value) => value > 0 && Number.isFinite(value));
        if (usable.length < 30) return { ok: false, content: `Benford needs a larger sample (got ${usable.length} usable amounts, minimum 30)` };
        const observed = benfordFirstDigits(usable);
        const deviation = observed.reduce((acc, value, index) => acc + Math.abs(value - (BENFORD_EXPECTED[index] ?? 0)), 0) / 9;
        const lines = [
          `sample: ${usable.length} amounts`,
          ...observed.map((value, index) => `digit ${index + 1}: observed ${pct(value)} vs expected ${pct(BENFORD_EXPECTED[index] ?? 0)}`),
          `mean absolute deviation: ${pct(deviation)}`,
          deviation > 0.05 ? "deviation above 5pp — investigate the outliers before trusting these figures" : "deviation within the usual band for genuine data of this size",
        ];
        return { ok: true, content: lines.join("\n") };
      },
    },
  ];
}
