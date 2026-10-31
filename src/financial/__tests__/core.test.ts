import assert from "node:assert/strict";
import test from "node:test";
import { amortize, benfordFirstDigits, BENFORD_EXPECTED, capmCostOfEquity, dcf, irr, npv, ratios, wacc } from "../core.js";

const close = (actual: number, expected: number, epsilon = 1e-6): void => {
  assert.ok(Math.abs(actual - expected) < epsilon, `expected ${actual} ~= ${expected}`);
};

test("npv: hand-computed two-period example", () => {
  // -100 + 60/1.1 + 60/1.21 = 4.132231...
  close(npv(0.1, [-100, 60, 60]), 4.132231405, 1e-6);
});

test("irr: solves to a genuine NPV zero", () => {
  const rate = irr([-100, 60, 60]);
  assert.ok(rate !== null, "irr found");
  close(npv(rate as number, [-100, 60, 60]), 0, 1e-6);
  assert.equal(irr([100, 60, 60]), null, "no crossover -> null");
});

test("capm and wacc: hand-computed", () => {
  close(capmCostOfEquity(0.03, 1.2, 0.05), 0.09);
  close(wacc({ costOfEquity: 0.09, costOfDebt: 0.05, taxRate: 0.25, equityValue: 600, debtValue: 400 }), 0.069);
});

test("dcf: one explicit year with Gordon terminal, fully hand-computed", () => {
  const result = dcf({ baseFreeCashFlow: 100, growthRates: [0.1], terminalGrowth: 0.02, discountRate: 0.1, netDebt: 75, sharesOutstanding: 50 });
  close(result.projectedFlows[0] as number, 110);
  close(result.presentValues[0] as number, 100); // 110 / 1.1
  close(result.terminalValue, 1402.5); // 110*1.02 / 0.08
  close(result.pvTerminal, 1275); // 1402.5 / 1.1
  close(result.enterpriseValue, 1375);
  close(result.equityValue, 1300); // 1375 - 75 net debt
  close(result.terminalShare, 1275 / 1375, 1e-9);
  close(result.valuePerShare as number, 26);
  close(result.impliedExitMultiple, 1402.5 / 110);
});

test("dcf: rejects nonsense inputs", () => {
  assert.throws(() => dcf({ baseFreeCashFlow: 100, growthRates: [], terminalGrowth: 0.02, discountRate: 0.1 }));
  assert.throws(() => dcf({ baseFreeCashFlow: 100, growthRates: [0.1], terminalGrowth: 0.12, discountRate: 0.1 }));
});

test("ratios: full card on a small hand-checked company", () => {
  const card = ratios(
    { currentAssets: 500, inventory: 200, cash: 100, currentLiabilities: 250, totalAssets: 1000, totalLiabilities: 600, shareholdersEquity: 400 },
    { revenue: 900, costOfRevenue: 500, operatingExpenses: 250, interestExpense: 50, netIncome: 90 },
  );
  close(card.currentRatio, 2);
  close(card.quickRatio, 1.2);
  close(card.cashRatio, 0.4);
  close(card.workingCapital, 250);
  close(card.debtToEquity, 1.5);
  close(card.debtToAssets, 0.6);
  close(card.interestCoverage, 3); // op income 150 / 50
  close(card.grossMargin, 400 / 900, 1e-9);
  close(card.operatingMargin, 150 / 900, 1e-9);
  close(card.netMargin, 0.1);
  close(card.roe, 90 / 400, 1e-9);
  close(card.roa, 0.09);
  close(card.assetTurnover, 0.9);
  // division by zero yields NaN, not a crash
  const empty = ratios(
    { currentAssets: 0, inventory: 0, cash: 0, currentLiabilities: 0, totalAssets: 0, totalLiabilities: 0, shareholdersEquity: 0 },
    { revenue: 0, costOfRevenue: 0, operatingExpenses: 0, interestExpense: 0, netIncome: 0 },
  );
  assert.ok(Number.isNaN(empty.currentRatio));
  assert.ok(Number.isNaN(empty.netMargin));
});

test("amortize: 12% annual over 1 year monthly, hand-checked", () => {
  const schedule = amortize(1000, 0.12, 1, 12);
  assert.equal(schedule.rows.length, 12);
  const first = schedule.rows[0];
  const last = schedule.rows[11];
  assert.ok(first && last, "rows present");
  close(first.interest, 10); // 1% of 1000
  close(first.payment, 88.848789, 1e-4);
  close(schedule.totalPaid, 1066.185, 1e-2);
  close(last.balance, 0);
  const principalSum = schedule.rows.reduce((acc, row) => acc + row.principal, 0);
  close(principalSum, 1000, 1e-6);
  // zero-rate loan divides evenly
  const flat = amortize(1200, 0, 1, 12);
  const flatFirst = flat.rows[0];
  assert.ok(flatFirst, "flat rows present");
  close(flatFirst.payment, 100);
  close(flat.totalInterest, 0);
});

test("benford: first significant digits and expected law", () => {
  const observed = benfordFirstDigits([123, 0.4, 56.7, 8, 90, -5, NaN]);
  const expected1 = BENFORD_EXPECTED[0];
  assert.ok(expected1 !== undefined, "expected[0]");
  // -5 and NaN are skipped; the five usable amounts start with 1,4,5,8,9
  close(observed[0] as number, 0.2, 1e-9);
  close(observed[3] as number, 0.2, 1e-9);
  close(observed[8] as number, 0.2, 1e-9);
  close(observed[1] as number, 0, 1e-9);
  close(expected1, Math.log10(2), 1e-12); // digit 1 ~= 30.1%
  assert.deepEqual(benfordFirstDigits([]), new Array(9).fill(0));
});
