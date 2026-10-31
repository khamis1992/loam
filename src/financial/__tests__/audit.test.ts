import assert from "node:assert/strict";
import test from "node:test";
import { auditCompany } from "../audit.js";
import type { CompanyFinancials } from "../edgar.js";

function base(): CompanyFinancials {
  return {
    cik: 1,
    ticker: "TST",
    title: "Test Co",
    years: [
      { end: "2024-12-31", revenue: 1000, operatingIncome: 120, netIncome: 80, operatingCashFlow: 150, assets: 1000, liabilities: 550, equity: 450, cash: 80 },
      { end: "2023-12-31", revenue: 900, operatingIncome: 100, netIncome: 70, operatingCashFlow: 140, assets: 950, liabilities: 520, equity: 430, cash: 70 },
      { end: "2022-12-31", revenue: 800, operatingIncome: 90, netIncome: 60, operatingCashFlow: 130, assets: 900, liabilities: 500, equity: 400, cash: 60 },
    ],
  };
}

/** Non-null year accessor so strict-index tests stay readable. */
function yearAt(company: CompanyFinancials, index: number): NonNullable<CompanyFinancials["years"][number]> {
  const year = company.years[index];
  assert.ok(year, `year ${index}`);
  return year;
}

test("clean company: no critical findings", () => {
  const findings = auditCompany(base());
  assert.equal(findings.filter((finding) => finding.severity === "critical").length, 0);
});

test("balance identity break is critical", () => {
  const company = base();
  yearAt(company, 0).assets = 900; // 550 + 450 = 1000 != 900
  const findings = auditCompany(company);
  const identity = findings.find((finding) => finding.check === "balance-identity");
  assert.ok(identity);
  assert.equal(identity.severity, "critical");
  assert.match(identity.detail, /assets .* != liabilities\+equity/);
});

test("negative equity is critical", () => {
  const company = base();
  yearAt(company, 0).equity = -50;
  yearAt(company, 0).liabilities = 1050;
  const findings = auditCompany(company);
  assert.equal(findings.find((finding) => finding.check === "negative-equity")?.severity, "critical");
});

test("persistent accrual divergence is an earnings-quality warning", () => {
  const company = base();
  for (const year of company.years) {
    year.netIncome = (year.operatingCashFlow as number) + 40;
  }
  const findings = auditCompany(company);
  const quality = findings.find((finding) => finding.check === "earnings-quality");
  assert.ok(quality);
  assert.equal(quality.severity, "warning");
  assert.match(quality.detail, /all 3 years/);
});

test("leverage ramp is a warning", () => {
  const company = base();
  yearAt(company, 2).liabilities = 150;
  yearAt(company, 2).equity = 750; // old D/E 0.2
  yearAt(company, 0).liabilities = 900;
  yearAt(company, 0).equity = 100; // new D/E 9.0 — assets stay 1000
  const findings = auditCompany(company);
  const leverage = findings.find((finding) => finding.check === "leverage-trend");
  assert.ok(leverage);
  assert.equal(leverage.severity, "warning");
});

test("wide margin swing is flagged, info lines still present", () => {
  const company = base();
  yearAt(company, 2).netIncome = -200; // deep loss year
  const findings = auditCompany(company);
  assert.ok(findings.find((finding) => finding.check === "margin-swing"));
  assert.ok(findings.find((finding) => finding.check === "revenue-trend"));
});

test("empty series produces the coverage warning instead of crashing", () => {
  const findings = auditCompany({ cik: 2, ticker: "X", title: "Empty", years: [] });
  assert.deepEqual(findings.map((finding) => finding.check), ["data-coverage"]);
});
