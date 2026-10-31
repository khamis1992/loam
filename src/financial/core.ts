/**
 * Financial analytics core (blueprint gap 3) — pure functions, no I/O.
 *
 * Deterministic money math for the agent: time value, valuation (DCF with
 * CAPM-derived WACC), statement ratios and amortization schedules. Every
 * function returns numbers or plain records so results can be embedded in
 * reports directly. Rounding is left to the presentation layer.
 */

/** Net present value of cash flows at a periodic rate. flows[0] is t=0 (usually negative). */
export function npv(rate: number, flows: number[]): number {
  return flows.reduce((acc, flow, t) => acc + flow / Math.pow(1 + rate, t), 0);
}

/** Internal rate of return via bisection on NPV (null when no sign change in [-0.9999, 10]). */
export function irr(flows: number[]): number | null {
  let low = -0.9999;
  let high = 10;
  const f = (rate: number): number => npv(rate, flows);
  let fLow = f(low);
  let fHigh = f(high);
  if (fLow * fHigh > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (low + high) / 2;
    const fMid = f(mid);
    if (Math.abs(fMid) < 1e-9) return mid;
    if (fLow * fMid < 0) {
      high = mid;
      fHigh = fMid;
    } else {
      low = mid;
      fLow = fMid;
    }
  }
  return (low + high) / 2;
}

/** CAPM cost of equity: rf + beta * (equityRiskPremium). */
export function capmCostOfEquity(riskFreeRate: number, beta: number, equityRiskPremium: number): number {
  return riskFreeRate + beta * equityRiskPremium;
}

export interface WaccInput {
  costOfEquity: number;
  costOfDebt: number;
  taxRate: number;
  equityValue: number;
  debtValue: number;
}

/** After-tax WACC from capital-structure weights. Weights derived from values, not percentages. */
export function wacc(input: WaccInput): number {
  const total = input.equityValue + input.debtValue;
  if (total <= 0) return NaN;
  const weightEquity = input.equityValue / total;
  const weightDebt = input.debtValue / total;
  return weightEquity * input.costOfEquity + weightDebt * input.costOfDebt * (1 - input.taxRate);
}

export interface DcfInput {
  /** Historical or projected free cash flows already realized; the projection grows from the last one. */
  baseFreeCashFlow: number;
  /** Explicit yearly growth rates for the projection window (e.g. [0.15, 0.12, 0.09, 0.06, 0.04]). */
  growthRates: number[];
  /** Perpetuity growth beyond the window (typical 1.5%–2.5%). */
  terminalGrowth: number;
  /** Discount rate, usually WACC. */
  discountRate: number;
  /** Net cash (+) or debt (-) position to adjust enterprise value into equity value. */
  netDebt?: number;
  /** Diluted shares outstanding, for per-share value. */
  sharesOutstanding?: number;
}

export interface DcfResult {
  /** Projected free cash flow per year of the explicit window. */
  projectedFlows: number[];
  /** Discount factor per year (1 / (1+r)^t). */
  discountFactors: number[];
  /** Present value of each projected year. */
  presentValues: number[];
  pvExplicit: number;
  terminalValue: number;
  pvTerminal: number;
  enterpriseValue: number;
  equityValue: number;
  /** Proportion of EV coming from the terminal value — the classic over-reliance flag. */
  terminalShare: number;
  valuePerShare: number | null;
  /** Implied multiples against the base year, for sanity checks. */
  impliedExitMultiple: number;
}

/** Discounted cash flow valuation with a Gordon-growth terminal value. */
export function dcf(input: DcfInput): DcfResult {
  const { baseFreeCashFlow, growthRates, terminalGrowth, discountRate } = input;
  if (discountRate <= terminalGrowth) throw new Error("discount rate must exceed terminal growth");
  if (growthRates.length === 0) throw new Error("at least one growth year is required");
  const projectedFlows: number[] = [];
  const presentValues: number[] = [];
  const discountFactors: number[] = [];
  let previous = baseFreeCashFlow;
  let pvExplicit = 0;
  let year = 0;
  for (const growth of growthRates) {
    year += 1;
    previous = previous * (1 + growth);
    projectedFlows.push(previous);
    const factor = 1 / Math.pow(1 + discountRate, year);
    discountFactors.push(factor);
    const pv = previous * factor;
    presentValues.push(pv);
    pvExplicit += pv;
  }
  const finalYearFlow = projectedFlows.at(-1);
  const finalFactor = discountFactors.at(-1);
  if (finalYearFlow === undefined || finalFactor === undefined) throw new Error("projection window is empty");
  const terminalValue = (finalYearFlow * (1 + terminalGrowth)) / (discountRate - terminalGrowth);
  const pvTerminal = terminalValue * finalFactor;
  const enterpriseValue = pvExplicit + pvTerminal;
  const equityValue = enterpriseValue - (input.netDebt ?? 0);
  return {
    projectedFlows,
    discountFactors,
    presentValues,
    pvExplicit,
    terminalValue,
    pvTerminal,
    enterpriseValue,
    equityValue,
    terminalShare: pvTerminal / enterpriseValue,
    valuePerShare: input.sharesOutstanding && input.sharesOutstanding > 0 ? equityValue / input.sharesOutstanding : null,
    impliedExitMultiple: terminalValue / finalYearFlow,
  };
}

export interface BalanceSheetInput {
  currentAssets: number;
  inventory: number;
  cash: number;
  currentLiabilities: number;
  totalAssets: number;
  totalLiabilities: number;
  shareholdersEquity: number;
}

export interface IncomeStatementInput {
  revenue: number;
  costOfRevenue: number;
  operatingExpenses: number;
  interestExpense: number;
  netIncome: number;
}

export interface RatioCard {
  /** Liquidity */
  currentRatio: number;
  quickRatio: number;
  cashRatio: number;
  workingCapital: number;
  /** Leverage */
  debtToEquity: number;
  debtToAssets: number;
  interestCoverage: number;
  /** Profitability */
  grossMargin: number;
  operatingMargin: number;
  netMargin: number;
  roe: number;
  roa: number;
  /** Efficiency */
  assetTurnover: number;
}

/** The standard ratio card from one balance sheet + one income statement. */
export function ratios(balance: BalanceSheetInput, income: IncomeStatementInput): RatioCard {
  const operatingIncome = income.revenue - income.costOfRevenue - income.operatingExpenses;
  const safeDiv = (a: number, b: number): number => (b === 0 ? NaN : a / b);
  return {
    currentRatio: safeDiv(balance.currentAssets, balance.currentLiabilities),
    quickRatio: safeDiv(balance.currentAssets - balance.inventory, balance.currentLiabilities),
    cashRatio: safeDiv(balance.cash, balance.currentLiabilities),
    workingCapital: balance.currentAssets - balance.currentLiabilities,
    debtToEquity: safeDiv(balance.totalLiabilities, balance.shareholdersEquity),
    debtToAssets: safeDiv(balance.totalLiabilities, balance.totalAssets),
    interestCoverage: safeDiv(operatingIncome, income.interestExpense),
    grossMargin: safeDiv(income.revenue - income.costOfRevenue, income.revenue),
    operatingMargin: safeDiv(operatingIncome, income.revenue),
    netMargin: safeDiv(income.netIncome, income.revenue),
    roe: safeDiv(income.netIncome, balance.shareholdersEquity),
    roa: safeDiv(income.netIncome, balance.totalAssets),
    assetTurnover: safeDiv(income.revenue, balance.totalAssets),
  };
}

export interface AmortizationRow {
  period: number;
  payment: number;
  interest: number;
  principal: number;
  balance: number;
}

export interface AmortizationResult {
  rows: AmortizationRow[];
  totalInterest: number;
  totalPaid: number;
}

/** Level-payment loan schedule. rate and paymentRate are per-period (annual/12 for monthly). */
export function amortize(principal: number, annualRate: number, years: number, paymentsPerYear: number): AmortizationResult {
  if (principal <= 0 || years <= 0 || paymentsPerYear <= 0) throw new Error("principal, years and paymentsPerYear must be positive");
  const periods = Math.round(years * paymentsPerYear);
  const ratePerPeriod = annualRate / paymentsPerYear;
  const payment =
    ratePerPeriod === 0
      ? principal / periods
      : (principal * ratePerPeriod) / (1 - Math.pow(1 + ratePerPeriod, -periods));
  const rows: AmortizationRow[] = [];
  let balance = principal;
  let totalInterest = 0;
  for (let period = 1; period <= periods; period++) {
    const interest = balance * ratePerPeriod;
    let principalPart = payment - interest;
    if (period === periods) principalPart = balance; // absorb rounding on the final row
    balance = Math.max(0, balance - principalPart);
    totalInterest += interest;
    rows.push({ period, payment: principalPart + interest, interest, principal: principalPart, balance });
  }
  return { rows, totalInterest, totalPaid: principal + totalInterest };
}

/** Benford first-digit distribution of a series of positive amounts (fractions per digit 1-9). */
export function benfordFirstDigits(amounts: number[]): number[] {
  const counts = new Array<number>(9).fill(0);
  let total = 0;
  for (const amount of amounts) {
    if (!Number.isFinite(amount) || amount <= 0) continue;
    // The first significant digit is the first 1-9 anywhere in the decimal string
    // (0.0042 -> 4, 123.45 -> 1); negatives are skipped above.
    const match = String(amount).match(/[1-9]/);
    if (!match) continue;
    const first = Number.parseInt(match[0], 10);
    counts[first - 1] = (counts[first - 1] ?? 0) + 1;
    total += 1;
  }
  return counts.map((count) => (total === 0 ? 0 : count / total));
}

/** Benford's expected first-digit frequencies (log10(1 + 1/d)). */
export const BENFORD_EXPECTED = Array.from({ length: 9 }, (_, index) => Math.log10(1 + 1 / (index + 1)));
