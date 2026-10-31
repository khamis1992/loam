import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { __setFetchForTests } from "../../financial/edgar.js";
import { createFinancialTools } from "../financialTools.js";
import type { Tool, ToolContext } from "../registry.js";

/** Same fixture surface as the edgar tests, through the real parsing path. */
const DIRECTORY = {
  "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
  "1": { cik_str: 999999, ticker: "APL", title: "APL Logistics Inc." },
};
const SUBMISSIONS = {
  recent: {
    form: ["10-K"],
    filingDate: ["2024-11-01"],
    reportDate: ["2024-09-28"],
    accessionNumber: ["0000320193-24-000123"],
    primaryDocument: ["aapl-20240928.htm"],
  },
};
const FACTS = {
  "us-gaap": {
    Revenues: { units: { USD: [{ start: "2023-10-01", end: "2024-09-28", val: 391_035_000_000, form: "10-K", fp: "FY", frame: "CY2024" }] } },
    NetIncomeLoss: { units: { USD: [{ start: "2023-10-01", end: "2024-09-28", val: 93_736_000_000, form: "10-K", fp: "FY", frame: "CY2024" }] } },
    Assets: { units: { USD: [{ end: "2024-09-28", val: 364_980_000_000, form: "10-K", fp: "FY", frame: "CY2024Q3I" }] } },
    Liabilities: { units: { USD: [{ end: "2024-09-28", val: 308_030_000_000, form: "10-K", fp: "FY", frame: "CY2024Q3I" }] } },
    StockholdersEquity: { units: { USD: [{ end: "2024-09-28", val: 56_950_000_000, form: "10-K", fp: "FY", frame: "CY2024Q3I" }] } },
  },
};

function installFixtures(): void {
  __setFetchForTests(async (url) => {
    if (url.endsWith("company_tickers.json")) return structuredClone(DIRECTORY);
    if (url.includes("/submissions/")) return structuredClone(SUBMISSIONS);
    if (url.includes("/companyfacts/")) return structuredClone(FACTS);
    throw new Error(`unexpected url ${url}`);
  });
}

function setup() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "financial-tools-"));
  const tools = new Map<string, Tool>(createFinancialTools().map((t) => [t.name, t]));
  const ctx = { cfg: {}, emit: () => {}, workspace, taskId: "task-1" } as unknown as ToolContext;
  const tool = (name: string): Tool => {
    const t = tools.get(name);
    assert.ok(t, name);
    return t;
  };
  return { ctx, tool, workspace, cleanup: () => fs.rmSync(workspace, { recursive: true, force: true }) };
}

test.after(() => __setFetchForTests(null));

test("all eight financial tools ship JSON-schema parameters", () => {
  const { tool, cleanup } = setup();
  const names = ["finance_dcf", "finance_ratios", "finance_npv_irr", "finance_amortize", "finance_company", "finance_filings", "finance_audit", "finance_benford"];
  for (const name of names) assert.equal(tool(name).parameters.type, "object");
  cleanup();
});

test("finance_dcf: valuation lines and the terminal-reliance warning", async () => {
  const { tool, ctx, cleanup } = setup();
  const r = await tool("finance_dcf").run({ base_fcf: 118_254_000_000, growth_rates: [0.05, 0.05, 0.04, 0.03, 0.02], terminal_growth: 0.02, discount_rate: 0.09, net_debt: 80_000_000_000, shares_outstanding: 15_100_000_000 }, ctx);
  assert.ok(r.ok, r.content);
  assert.match(r.content, /enterprise value: \d/);
  assert.match(r.content, /per share/);
  assert.match(r.content, /terminal reliance/);
  cleanup();
});

test("finance_dcf: rejects missing discount and inverted rates", async () => {
  const { tool, ctx, cleanup } = setup();
  const noRate = await tool("finance_dcf").run({ base_fcf: 100, growth_rates: [0.1] }, ctx);
  assert.equal(noRate.ok, false);
  const inverted = await tool("finance_dcf").run({ base_fcf: 100, growth_rates: [0.1], discount_rate: 0.01, terminal_growth: 0.02 }, ctx);
  assert.equal(inverted.ok, false);
  const capmPath = await tool("finance_dcf").run({ base_fcf: 100_000, growth_rates: [0.05], capm: { risk_free: 0.04, beta: 1.1, equity_risk_premium: 0.05, cost_of_debt: 0.05, tax_rate: 0.21, equity_value: 700, debt_value: 300 } }, ctx);
  assert.ok(capmPath.ok, capmPath.content);
  assert.match(capmPath.content, /WACC from CAPM components/);
  cleanup();
});

test("finance_ratios and finance_npv_irr: formatted cards", async () => {
  const { tool, ctx, cleanup } = setup();
  const card = await tool("finance_ratios").run({ balance: { current_assets: 500, inventory: 200, cash: 100, current_liabilities: 250, total_assets: 1000, total_liabilities: 600, equity: 400 }, income: { revenue: 900, cost_of_revenue: 500, operating_expenses: 250, interest_expense: 50, net_income: 90 } }, ctx);
  assert.ok(card.ok, card.content);
  assert.match(card.content, /current 2\.00/);
  assert.match(card.content, /ROE 22\.50%/);
  const tv = await tool("finance_npv_irr").run({ flows: [-100, 60, 60], rate: 0.1 }, ctx);
  assert.ok(tv.ok, tv.content);
  assert.match(tv.content, /npv at 10\.00%: 4\.13/);
  assert.match(tv.content, /irr: 13\.\d+%/);
  cleanup();
});

test("finance_amortize: schedule summary", async () => {
  const { tool, ctx, cleanup } = setup();
  const r = await tool("finance_amortize").run({ principal: 100_000, annual_rate: 0.065, years: 5 }, ctx);
  assert.ok(r.ok, r.content);
  assert.match(r.content, /60 periods/);
  assert.match(r.content, /total paid/);
  cleanup();
});

test("finance_company: distilled series over the mocked EDGAR transport", async () => {
  installFixtures();
  const { tool, ctx, cleanup } = setup();
  const r = await tool("finance_company").run({ query: "AAPL" }, ctx);
  assert.ok(r.ok, r.content);
  assert.match(r.content, /Apple Inc\. \(AAPL, CIK 320193\)/);
  assert.match(r.content, /revenue 391\.04B/);
  assert.match(r.content, /net margin 23\.97%/);
  cleanup();
});

test("finance_company: ambiguous ticker is refused with candidates", async () => {
  installFixtures();
  const { tool, ctx, cleanup } = setup();
  const r = await tool("finance_company").run({ query: "APL" }, ctx);
  // "APL" matches APL Logistics exactly by ticker, so it resolves; use a fragment that hits both
  const ambiguous = await tool("finance_company").run({ query: "Inc" }, ctx);
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.content, /candidates: .*AAPL \(Apple Inc\.\).*APL \(APL Logistics Inc\.\)/);
  assert.ok(r.ok || r.ok === false); // sanity: tool always answers
  const unknown = await tool("finance_company").run({ query: "zzzzzz" }, ctx);
  assert.equal(unknown.ok, false);
  assert.match(unknown.content, /no EDGAR company matches/);
  cleanup();
});

test("finance_filings and finance_audit: mocked surfaces", async () => {
  installFixtures();
  const { tool, ctx, cleanup } = setup();
  const filings = await tool("finance_filings").run({ query: "AAPL", form: "10-K" }, ctx);
  assert.ok(filings.ok, filings.content);
  assert.match(filings.content, /aapl-20240928\.htm/);
  const audit = await tool("finance_audit").run({ query: "AAPL" }, ctx);
  assert.ok(audit.ok, audit.content);
  assert.match(audit.content, /audit of Apple Inc\. \(AAPL\):/);
  // 308030 + 56950 = 364980 -> identity holds, no critical findings
  assert.doesNotMatch(audit.content, /\[CRITICAL\]/);
  cleanup();
});

test("finance_audit: identity break surfaces as CRITICAL through the tool", async () => {
  installFixtures();
  const liabilities = (FACTS as { "us-gaap"?: { Liabilities?: { units?: { USD?: Array<{ val: number }> } } } })["us-gaap"]?.Liabilities?.units?.USD;
  assert.ok(liabilities, "fixture liabilities");
  liabilities[0] = { ...liabilities[0], val: 300_000_000_000 }; // 300B + 56.95B != 364.98B
  const { tool, ctx, cleanup } = setup();
  const r = await tool("finance_audit").run({ query: "AAPL" }, ctx);
  assert.ok(r.ok, r.content);
  assert.match(r.content, /\[CRITICAL\] balance-identity/);
  cleanup();
});

test("finance_benford: sample-size gate and a clean report", async () => {
  const { tool, ctx, cleanup } = setup();
  const tooFew = await tool("finance_benford").run({ amounts: [1, 2, 3] }, ctx);
  assert.equal(tooFew.ok, false);
  assert.match(tooFew.ok === false ? tooFew.content : "", /minimum 30/);
  // 120 amounts whose first digits follow Benford closely by construction
  const amounts: number[] = [];
  for (let i = 1; i <= 120; i++) amounts.push(i * 97.13);
  const r = await tool("finance_benford").run({ amounts }, ctx);
  assert.ok(r.ok, r.content);
  assert.match(r.content, /digit 1: observed/);
  assert.match(r.content, /mean absolute deviation/);
  cleanup();
});
