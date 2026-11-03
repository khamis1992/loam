import assert from "node:assert";
import { describe, it } from "node:test";
import type { StudioArtifact } from "../../../studio/store.js";
import { analyzeSpreadsheet, createSpreadsheetCleaningPlan, detectSpreadsheetAnomalies, explainFormula, forecastNumericSeries, numericValue } from "../sheets/analysis.js";

const workbook = (): Extract<StudioArtifact, { kind: "spreadsheet" }> => ({
  kind: "spreadsheet",
  title: "Finance",
  revision: 0,
  content: {
    sheets: [{
      name: "Sheet1",
      cells: [
        ["Item", "Amount", "Date"],
        ["A", "10", "01/02/2024"],
        ["B", "11", "02/02/2024"],
        ["C", "12", "03/02/2024"],
        ["D", "13", "04/02/2024"],
        ["Outlier", "1000", "05/02/2024"],
        ["Formula", "=SUM(B2:B5)", ""],
      ],
    }],
  },
});

describe("deterministic spreadsheet analysis", () => {
  it("parses Arabic and grouped numbers without accepting arbitrary text", () => {
    assert.equal(numericValue("١٢٫٥"), 12.5);
    assert.equal(numericValue("1,250"), 1250);
    assert.equal(numericValue("12abc"), undefined);
  });

  it("calculates exact statistics and detects IQR outliers", () => {
    const analysis = analyzeSpreadsheet(workbook());
    const amounts = analysis.numericColumns.find((column) => column.label === "Amount");
    assert.equal(amounts?.count, 5);
    assert.equal(amounts?.sum, 1046);
    assert.equal(analysis.formulas, 1);
    const anomalies = detectSpreadsheetAnomalies(workbook());
    assert.equal(anomalies.length, 1);
    assert.equal(anomalies[0]?.address, "Sheet1!B6");
  });

  it("creates a previewable cleaning plan without deleting duplicates", () => {
    const artifact = workbook();
    artifact.content.sheets[0]!.cells[1]![0] = " A ";
    artifact.content.sheets[0]!.cells[2] = [...artifact.content.sheets[0]!.cells[1]!];
    const plan = createSpreadsheetCleaningPlan(artifact);
    assert.ok(plan.ops.some((op) => op.op === "set-cell" && op.address === "A2" && op.value === "A"));
    assert.ok(plan.ops.some((op) => op.op === "set-cell" && op.address === "C2" && op.value === "2024-02-01"));
    assert.equal(plan.duplicates.length, 1);
    assert.equal(plan.normalizedDates >= 2, true);
  });

  it("returns a bounded forecast with error and assumptions", () => {
    const forecast = forecastNumericSeries([10, 12, 14, 16, 18], 2);
    assert.equal(forecast.forecasts.length, 2);
    assert.equal(forecast.mae, 0);
    assert.ok(forecast.forecasts[0]!.value > 18);
    assert.ok(forecast.assumptions.length > 0);
    assert.throws(() => forecastNumericSeries([1, 2]), /at least four/);
  });

  it("explains supported formulas honestly", () => {
    assert.match(explainFormula("=SUM(B2:B5)"), /يجمع/);
    assert.match(explainFormula("=AVERAGE(B2:B5)"), /المتوسط/);
    assert.match(explainFormula("=CUSTOM(A1)"), /لا يفسرها/);
  });
});
