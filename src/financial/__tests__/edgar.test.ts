import assert from "node:assert/strict";
import test from "node:test";
import { edgarCompanyFinancials, edgarFilings, findCompanies, __setFetchForTests, type Json } from "../edgar.js";

/**
 * Fixture EDGAR: one directory (two companies so name-fragment matching is
 * real), one submissions doc and one companyfacts doc distilled through the
 * real parsing path — only the transport is fake.
 */
const DIRECTORY: Json = {
  "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
  "1": { cik_str: 789019, ticker: "MSFT", title: "MICROSOFT CORP" },
};

const SUBMISSIONS: Json = {
  recent: {
    form: ["10-Q", "10-K", "8-K", "10-K"],
    filingDate: ["2025-08-01", "2024-11-01", "2024-07-10", "2023-11-03"],
    reportDate: ["2025-06-28", "2024-09-28", "2024-06-29", "2023-09-30"],
    accessionNumber: ["0000320193-25-000079", "0000320193-24-000123", "0000320193-24-000056", "0000320193-23-000106"],
    primaryDocument: ["aapl-20250628.htm", "aapl-20240928.htm", "aapl-20240629.htm", "aapl-20230930.htm"],
  },
};

/** us-gaap points for two years, mixing frame-tagged and form-only entries. */
function points(entries: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return entries;
}

const FACTS: Json = {
  dei: {
    EntityCommonStockSharesOutstanding: {
      units: { USD: points([{ end: "2024-10-18", val: 15_115_823_000, form: "10-K" }]) },
    },
  },
  "us-gaap": {
    Revenues: {
      units: {
        USD: points([
          { start: "2023-10-01", end: "2024-09-28", val: 391_035_000_000, form: "10-K", fy: 2024, fp: "FY", frame: "CY2024" },
          { start: "2022-09-25", end: "2023-09-30", val: 383_285_000_000, form: "10-K", fy: 2023, fp: "FY", frame: "CY2023" },
          { start: "2023-10-01", end: "2024-06-29", val: 205_000_000_000, form: "10-Q", fy: 2024, fp: "Q3" },
        ]),
      },
    },
    NetIncomeLoss: {
      units: {
        USD: points([
          { start: "2023-10-01", end: "2024-09-28", val: 93_736_000_000, form: "10-K", fy: 2024, fp: "FY", frame: "CY2024" },
          { start: "2022-09-25", end: "2023-09-30", val: 96_995_000_000, form: "10-K", fy: 2023, fp: "FY", frame: "CY2023" },
        ]),
      },
    },
    OperatingIncomeLoss: {
      units: {
        USD: points([
          { start: "2023-10-01", end: "2024-09-28", val: 123_216_000_000, form: "10-K", fy: 2024, fp: "FY", frame: "CY2024" },
        ]),
      },
    },
    NetCashProvidedByUsedInOperatingActivities: {
      units: {
        USD: points([
          { start: "2023-10-01", end: "2024-09-28", val: 118_254_000_000, form: "10-K", fy: 2024, fp: "FY", frame: "CY2024" },
        ]),
      },
    },
    Assets: {
      units: {
        USD: points([
          { end: "2024-09-28", val: 364_980_000_000, form: "10-K", fy: 2024, fp: "FY", frame: "CY2024Q3I" },
          { end: "2023-09-30", val: 352_583_000_000, form: "10-K", fy: 2023, fp: "FY", frame: "CY2023Q3I" },
        ]),
      },
    },
    Liabilities: {
      units: {
        USD: points([
          { end: "2024-09-28", val: 308_030_000_000, form: "10-K", fy: 2024, fp: "FY", frame: "CY2024Q3I" },
          { end: "2023-09-30", val: 290_437_000_000, form: "10-K", fy: 2023, fp: "FY", frame: "CY2023Q3I" },
        ]),
      },
    },
    StockholdersEquity: {
      units: {
        USD: points([
          { end: "2024-09-28", val: 56_950_000_000, form: "10-K", fy: 2024, fp: "FY", frame: "CY2024Q3I" },
          { end: "2023-09-30", val: 62_146_000_000, form: "10-K", fy: 2023, fp: "FY", frame: "CY2023Q3I" },
        ]),
      },
    },
    CashAndCashEquivalentsAtCarryingValue: {
      units: {
        USD: points([{ end: "2024-09-28", val: 29_943_000_000, form: "10-K", fy: 2024, fp: "FY", frame: "CY2024Q3I" }]),
      },
    },
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

test.after(() => __setFetchForTests(null));

test("findCompanies: exact ticker wins, fragments match, garbage misses", async () => {
  installFixtures();
  const byTicker = await findCompanies("aapl");
  const tickerHit = byTicker[0];
  assert.equal(byTicker.length, 1);
  assert.ok(tickerHit, "ticker hit");
  assert.equal(tickerHit.cik, 320193);
  const byName = await findCompanies("Microsoft");
  const nameHit = byName[0];
  assert.equal(byName.length, 1);
  assert.ok(nameHit, "name hit");
  assert.equal(nameHit.ticker, "MSFT");
  assert.equal((await findCompanies("zzz")).length, 0);
});

test("edgarFilings: newest first, form filter, dash-less archive links", async () => {
  installFixtures();
  const all = await edgarFilings(320193);
  assert.equal(all.length, 4);
  const newest = all[0];
  assert.ok(newest, "newest filing");
  assert.equal(newest.form, "10-Q");
  const only10k = await edgarFilings(320193, "10-K");
  assert.equal(only10k.length, 2);
  const first10k = only10k[0];
  assert.ok(first10k, "first 10-K");
  assert.equal(first10k.filingDate, "2024-11-01");
  assert.equal(first10k.link, "https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/aapl-20240928.htm");
});

test("edgarCompanyFinancials: distills annual series, newest first, quarters excluded", async () => {
  installFixtures();
  const financials = await edgarCompanyFinancials({ cik: 320193, ticker: "AAPL", title: "Apple Inc." });
  assert.equal(financials.title, "Apple Inc.");
  assert.equal(financials.years.length, 2);
  const fy24 = financials.years[0];
  const fy23 = financials.years[1];
  assert.ok(fy24 && fy23, "two years distilled");
  assert.equal(fy24.end, "2024-09-28");
  assert.equal(fy24.revenue, 391_035_000_000);
  assert.equal(fy24.netIncome, 93_736_000_000);
  assert.equal(fy24.assets, 364_980_000_000);
  assert.equal(fy24.equity, 56_950_000_000);
  assert.equal(fy24.cash, 29_943_000_000);
  assert.equal(fy24.sharesOutstanding, 15_115_823_000);
  // the 10-Q revenue point must not leak into the annual series
  assert.ok(!financials.years.some((year) => year.revenue === 205_000_000_000));
  assert.equal(fy23.revenue, 383_285_000_000);
  assert.equal(fy23.assets, 352_583_000_000);
});

test("edgar: transport failure propagates as an error the tools can catch", async () => {
  __setFetchForTests(async () => {
    throw new Error("EDGAR 403");
  });
  await assert.rejects(() => findCompanies("aapl"), /EDGAR 403/);
});
