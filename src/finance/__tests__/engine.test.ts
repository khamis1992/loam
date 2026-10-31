import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyzeStatements, auditLedger, compareMultiples, computeDcf } from "../engine.js";

describe("financial engine (blueprint §7.5)", () => {
  it("computes a DCF with known values", () => {
    // 100 in one year at 10% discount = 90.909...; terminal at 2% growth.
    const result = computeDcf({ cashFlows: [100, 110], discountRate: 0.10, terminalGrowth: 0.02 });
    assert.equal(Math.round(result.discountedFlows[0]!.presentValue * 100) / 100, 90.91);
    assert.equal(Math.round(result.discountedFlows[1]!.presentValue * 100) / 100, 90.91); // 110/1.21
    // Terminal = 110*1.02/0.08 = 1402.5 → PV = 1402.5/1.21 = 1159.09
    assert.equal(Math.round(result.terminalPresentValue * 100) / 100, 1159.09);
    assert.equal(Math.round(result.enterpriseValue * 100) / 100, 1340.91);
    assert.equal(result.equityValue, result.enterpriseValue); // no netCash → equal
  });

  it("adds net cash to the equity value and rejects invalid inputs", () => {
    const result = computeDcf({ cashFlows: [100], discountRate: 0.1, terminalGrowth: 0.02, netCash: 50 });
    assert.equal(result.equityValue, result.enterpriseValue + 50);
    assert.throws(() => computeDcf({ cashFlows: [], discountRate: 0.1, terminalGrowth: 0.02 }));
    assert.throws(() => computeDcf({ cashFlows: [1], discountRate: 0.02, terminalGrowth: 0.03 })); // growth >= discount
  });

  it("medians the comparable multiples", () => {
    const result = compareMultiples([
      { name: "A", pe: 10 }, { name: "B", pe: 20 }, { name: "C", pe: 30 },
      { name: "D", evEbitda: 5 }, { name: "E", evEbitda: 7 },
    ]);
    assert.equal(result.medianPe, 20);
    assert.equal(result.medianEvEbitda, 6);
  });

  it("detects duplicate payments within the window", () => {
    const findings = auditLedger([
      { id: "p1", kind: "payment", party: "شركة النور", amount: 5000, date: "2026-01-05" },
      { id: "p2", kind: "payment", party: "شركة النور", amount: 5000, date: "2026-01-08" },
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.code, "duplicate-payment");
    assert.deepEqual(findings[0]!.entryIds.sort(), ["p1", "p2"]);
  });

  it("ignores identical payments outside the window and differing amounts inside it", () => {
    const findings = auditLedger([
      { id: "p1", kind: "payment", party: "شركة النور", amount: 5000, date: "2026-01-01" },
      { id: "p2", kind: "payment", party: "شركة النور", amount: 5000, date: "2026-02-01" }, // 31 days apart
      { id: "p3", kind: "payment", party: "مؤسسة الفجر", amount: 5000, date: "2026-01-02" },
      { id: "p4", kind: "payment", party: "مؤسسة الفجر", amount: 5500, date: "2026-01-03" }, // different amount
    ]);
    assert.equal(findings.length, 0);
  });

  it("flags a payment dated before its invoice", () => {
    const findings = auditLedger([
      { id: "i1", kind: "invoice", party: "شركة النور", amount: 1000, date: "2026-03-10" },
      { id: "p1", kind: "payment", party: "شركة النور", amount: 1000, date: "2026-03-01" },
    ]);
    const contradiction = findings.find((f) => f.code === "date-contradiction");
    assert.ok(contradiction, "date contradiction reported");
    assert.deepEqual(contradiction.entryIds.sort(), ["i1", "p1"]);
  });

  it("flags an invoice above its contract cap", () => {
    const findings = auditLedger([
      { id: "c1", kind: "contract", party: "شركة النور", amount: 10_000, date: "2026-01-01" },
      { id: "i1", kind: "invoice", party: "شركة النور", amount: 12_000, date: "2026-02-01", contractId: "c1" },
    ]);
    const mismatch = findings.find((f) => f.code === "amount-mismatch");
    assert.ok(mismatch, "amount mismatch reported");
    assert.equal(mismatch.severity, "high");
  });

  it("computes statement ratios with growth", () => {
    const result = analyzeStatements([
      { year: 2025, revenue: 1000, netIncome: 100, currentAssets: 200, currentLiabilities: 100 },
      { year: 2026, revenue: 1200, netIncome: 180, currentAssets: 300, currentLiabilities: 100 },
    ]);
    assert.equal(result.rows[0]!.netMargin, 0.1);
    assert.equal(result.rows[1]!.netMargin, 0.15);
    assert.ok(Math.abs(result.rows[1]!.revenueGrowth! - 0.2) < 1e-9, "growth ≈ 20%");
    assert.equal(result.rows[1]!.currentRatio, 3);
    assert.equal(result.rows[0]!.revenueGrowth, null);
    assert.throws(() => analyzeStatements([{ year: 2026, revenue: 0, netIncome: 1, currentAssets: 1, currentLiabilities: 1 }]));
  });
});
