/**
 * Unit tests for the typed studio cell model (src/studio/sheet-format.ts):
 *  - text/number/boolean/date/formula stay distinct through planning,
 *  - the workbook receives native Excel types and reads them back,
 *  - impossible dates and malformed colours fail loudly instead of writing
 *    corrupt values.
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import ExcelJS from "exceljs";

import {
  typedCellValue,
  applyCellType,
  sheetCellValue,
  cellAddress,
  applySheetFormat,
} from "../sheet-format.js";
import { StudioError } from "../store.js";

describe("sheet typed cells", () => {
  it("types text, numbers, booleans, dates and formulas distinctly", () => {
    assert.equal(typedCellValue("hello"), "hello");
    assert.equal(typedCellValue("42"), 42);
    assert.equal(typedCellValue("-3.5"), -3.5);
    assert.equal(typedCellValue("TRUE"), true);
    assert.equal(typedCellValue("false"), false);
    assert.deepEqual(typedCellValue("2024-03-05"), { date: "2024-03-05" });
    assert.equal(typedCellValue("=SUM(A1:A2)"), "=SUM(A1:A2)");
    assert.equal(typedCellValue("1e3"), "1e3", "exponent text stays text");
    assert.equal(typedCellValue("0012"), "0012", "leading zeros stay text");
    assert.equal(typedCellValue("2021-02-30"), "2021-02-30", "impossible calendar date stays text");
  });

  it("writes native Excel types and reads them back", () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("S");
    const inputs: unknown[] = ["text", 42, true, "2024-03-05", "=SUM(A1:A1)"];
    inputs.forEach((input, index) => applyCellType(sheet.getCell(1, index + 1), typedCellValue(input)));
    assert.equal(sheet.getCell(1, 1).value, "text");
    assert.equal(sheet.getCell(1, 2).value, 42);
    assert.equal(sheet.getCell(1, 3).value, true);
    assert.ok(sheet.getCell(1, 4).value instanceof Date);
    assert.equal(sheet.getCell(1, 4).numFmt, "yyyy-mm-dd");
    assert.deepEqual(sheet.getCell(1, 5).value, { formula: "SUM(A1:A1)" });
    assert.equal(sheetCellValue(sheet.getCell(1, 1)), "text");
    assert.equal(sheetCellValue(sheet.getCell(1, 2)), 42);
    assert.equal(sheetCellValue(sheet.getCell(1, 3)), true);
    assert.deepEqual(sheetCellValue(sheet.getCell(1, 4)), { date: "2024-03-05" });
    assert.equal(sheetCellValue(sheet.getCell(1, 5)), "=SUM(A1:A1)");
  });

  it("rejects an invalid date instead of writing an Invalid Date", () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("S");
    assert.throws(() => applyCellType(sheet.getCell(1, 1), { date: "not-a-date" }), StudioError);
  });

  it("rejects a malformed colour instead of emitting a bad ARGB value", () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("S");
    assert.throws(
      () => applySheetFormat(sheet, { cells: [["x"]], styles: { A1: { color: "red" } } }),
      StudioError,
    );
  });

  it("computes column labels", () => {
    assert.equal(cellAddress(1, 1), "A1");
    assert.equal(cellAddress(27, 10), "AA10");
  });

  it("applySheetFormat writes typed cells, styles, merges and dimensions", () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("S");
    applySheetFormat(sheet, {
      cells: [["Name", "Qty"], ["Widget", "3"]],
      styles: { B2: { bold: true, numberFormat: "0.00" } },
      columnWidths: [18, 8],
      merges: ["A3:B3"],
    });
    assert.equal(sheet.getCell("B2").value, 3, "numeric text becomes a native number");
    assert.equal(sheet.getCell("B2").numFmt, "0.00");
    assert.equal(sheet.getCell("B2").font.bold, true);
    assert.equal(sheet.getCell("A1").value, "Name");
    assert.ok(sheet.getCell("A3").isMerged, "empty region merges cleanly");
    assert.equal(sheet.getColumn(1).width, 18);
  });
});
