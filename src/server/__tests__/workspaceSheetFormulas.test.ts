/**
 * End-to-end formula coverage for the workspace sheet editor IO:
 * writing a SheetDoc caches computed formula results in the .xlsx (reopened
 * with ExcelJS to verify), and reading it back returns a `values` grid of
 * display strings computed against the whole workbook while `cells` keeps the
 * editable "=..." formula text.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import ExcelJS from "exceljs";

interface SheetDoc {
  taskId: string;
  path: string;
  name: string;
  sheets: Array<{
    name: string;
    cells: string[][];
    values?: string[][];
    styles: Record<string, Record<string, string | number | boolean>>;
    columnWidths: number[];
    rowHeights: number[];
    merges: string[];
    hiddenRows: boolean[];
    hiddenColumns: boolean[];
  }>;
  notes: string[];
}

let tmpDir = "";
let io: {
  readSheetDoc: (abs: string, identity: { taskId: string; path: string; name: string }) => Promise<SheetDoc>;
  writeSheetDoc: (abs: string, doc: SheetDoc) => Promise<{ bytes: number; warnings: string[] }>;
};

function formulaDoc(file: string): SheetDoc {
  return {
    taskId: "task-formulas",
    path: file,
    name: file,
    sheets: [
      {
        name: "Main",
        cells: [
          ["1", "2", "3", ""],
          ["=SUM(A1:C1)", '=IF(A1=1,"yes","no")', "=Data!A1*10", "=1/0"],
        ],
        styles: {},
        columnWidths: [10, 10, 10, 10],
        rowHeights: [20, 20],
        merges: [],
        hiddenRows: [false, false],
        hiddenColumns: [false, false, false, false],
      },
      {
        name: "Data",
        cells: [["30"]],
        styles: {},
        columnWidths: [10],
        rowHeights: [20],
        merges: [],
        hiddenRows: [false],
        hiddenColumns: [false],
      },
    ],
    notes: [],
  } as unknown as SheetDoc;
}

describe("workspace sheet formulas", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-sheetfx-"));
    io = (await import("../workspace/sheetIO.js")) as unknown as typeof io;
  });

  after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("GET builder returns computed display values while cells keep formula text", async () => {
    const abs = path.join(tmpDir, "formulas.xlsx");
    await io.writeSheetDoc(abs, formulaDoc("formulas.xlsx"));
    const doc = await io.readSheetDoc(abs, { taskId: "t", path: "formulas.xlsx", name: "formulas.xlsx" });

    const main = doc.sheets[0]!;
    assert.equal(main.name, "Main");
    // The formula text stays editable in `cells`…
    assert.equal(main.cells[1]![0], "=SUM(A1:C1)");
    assert.equal(main.cells[1]![1], '=IF(A1=1,"yes","no")');
    assert.equal(main.cells[1]![2], "=Data!A1*10");
    assert.equal(main.cells[1]![3], "=1/0");
    // …while `values` carries the computed display grid.
    assert.deepEqual(main.values![0], ["1", "2", "3", ""]);
    assert.deepEqual(main.values![1], ["6", "yes", "300", "#DIV/0!"]);
    // Non-formula sheets recalc too.
    assert.deepEqual(doc.sheets[1]!.values, [["30"]]);
  });

  it("PUT caches computed formula results inside the .xlsx", async () => {
    const abs = path.join(tmpDir, "cached.xlsx");
    await io.writeSheetDoc(abs, formulaDoc("cached.xlsx"));

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(abs);
    const main = workbook.getWorksheet("Main")!;
    const sum = main.getCell("A2").value as { formula: string; result?: unknown };
    assert.equal(sum.formula, "SUM(A1:C1)");
    assert.equal(sum.result, 6);
    const conditional = main.getCell("B2").value as { formula: string; result?: unknown };
    assert.equal(conditional.formula, 'IF(A1=1,"yes","no")');
    assert.equal(conditional.result, "yes");
    const cross = main.getCell("C2").value as { formula: string; result?: unknown };
    assert.equal(cross.formula, "Data!A1*10");
    assert.equal(cross.result, 300);
    // Errored formulas keep their formula but no cached result.
    const broken = main.getCell("D2").value as { formula: string; result?: unknown };
    assert.equal(broken.formula, "1/0");
    assert.equal(broken.result, undefined);
  });

  it("round-trips results through a second write and read", async () => {
    const abs = path.join(tmpDir, "roundtrip.xlsx");
    await io.writeSheetDoc(abs, formulaDoc("roundtrip.xlsx"));
    const first = await io.readSheetDoc(abs, { taskId: "t", path: "roundtrip.xlsx", name: "roundtrip.xlsx" });

    // Save the read-back model again (the editor's normal PUT flow)…
    await io.writeSheetDoc(abs, { ...first, path: "roundtrip.xlsx", name: "roundtrip.xlsx" });

    // …the workbook still carries cached results for Office to open with.
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(abs);
    const sum = workbook.getWorksheet("Main")!.getCell("A2").value as { formula: string; result?: unknown };
    assert.equal(sum.formula, "SUM(A1:C1)");
    assert.equal(sum.result, 6);

    const second = await io.readSheetDoc(abs, { taskId: "t", path: "roundtrip.xlsx", name: "roundtrip.xlsx" });
    assert.deepEqual(second.sheets[0]!.values![1], ["6", "yes", "300", "#DIV/0!"]);
    assert.equal(second.sheets[0]!.cells[1]![2], "=Data!A1*10");
  });

  it("computes dependency-aware chains across a save", async () => {
    const doc = formulaDoc("chain.xlsx");
    doc.sheets[0]!.cells = [
      ["2", "=A1*3", "=B1+10"],
      ["=SUM(A1:C1)", "=IF(C1>15,\"big\",\"small\")", "=A2&B2"],
    ];
    doc.sheets[0]!.values = undefined;
    const abs = path.join(tmpDir, "chain.xlsx");
    await io.writeSheetDoc(abs, doc);
    const read = await io.readSheetDoc(abs, { taskId: "t", path: "chain.xlsx", name: "chain.xlsx" });
    assert.deepEqual(read.sheets[0]!.values![0], ["2", "6", "16"]);
    assert.deepEqual(read.sheets[0]!.values![1], ["24", "big", "24big"]);
    // The cached results are in the file as well.
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(abs);
    const total = workbook.getWorksheet("Main")!.getCell("A2").value as { formula: string; result?: unknown };
    assert.equal(total.result, 24);
    const concat = workbook.getWorksheet("Main")!.getCell("C2").value as { formula: string; result?: unknown };
    assert.equal(concat.result, "24big");
  });

  it("reports circular references as #CIRC! in the values grid", async () => {
    const doc = formulaDoc("cycle.xlsx");
    doc.sheets[0]!.cells = [["=B1", "=A1"]];
    const abs = path.join(tmpDir, "cycle.xlsx");
    await io.writeSheetDoc(abs, doc);
    const read = await io.readSheetDoc(abs, { taskId: "t", path: "cycle.xlsx", name: "cycle.xlsx" });
    assert.deepEqual(read.sheets[0]!.values![0], ["#CIRC!", "#CIRC!"]);
    assert.equal(read.sheets[0]!.cells[0]![0], "=B1");
  });
});
