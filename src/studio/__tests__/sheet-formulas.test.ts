/**
 * Unit tests for the pure sheet formula engine (src/studio/sheet-formulas.ts):
 * arithmetic and text operator precedence, references (relative, absolute,
 * ranges, cross-sheet), every function family, error propagation, circular
 * references and the expression limits.
 */
import assert from "node:assert";
import { describe, it } from "node:test";

import {
  evaluateSheetFormula,
  recalcSheet,
  formatFormulaValue,
  isFormulaErrorText,
} from "../sheet-formulas.js";

const ctx = (sheets: Record<string, string[][]>, sheet = "Sheet1") => ({ sheet, sheets });

const GRID: Record<string, string[][]> = {
  Sheet1: [
    ["1", "2"],
    ["3", "4"],
  ],
  "My Sheet": [["10", "20"]],
  Letters: [
    ["a", "1"],
    ["b", "2"],
    ["c", "3"],
  ],
  Nums: [["10", "20", "30"]],
  NumsCol: [["10"], ["20"], ["30"]],
};

const num = (formula: string, sheets: Record<string, string[][]> = GRID, sheet = "Sheet1"): number => {
  const r = evaluateSheetFormula(formula, ctx(sheets, sheet));
  assert.equal(r.error, null, `${formula} should not error`);
  assert.equal(typeof r.value, "number", `${formula} should be a number`);
  return r.value as number;
};
const text = (formula: string, sheets: Record<string, string[][]> = GRID, sheet = "Sheet1"): string => {
  const r = evaluateSheetFormula(formula, ctx(sheets, sheet));
  assert.equal(r.error, null, `${formula} should not error`);
  return r.value as string;
};
const bool = (formula: string, sheets: Record<string, string[][]> = GRID, sheet = "Sheet1"): boolean => {
  const r = evaluateSheetFormula(formula, ctx(sheets, sheet));
  assert.equal(r.error, null, `${formula} should not error`);
  return r.value as boolean;
};
const errorOf = (formula: string, sheets: Record<string, string[][]> = GRID, sheet = "Sheet1"): string | null => {
  const r = evaluateSheetFormula(formula, ctx(sheets, sheet));
  assert.equal(r.value, null, `${formula} errored so its value must be null`);
  return r.error;
};

function colName(col: number): string {
  let label = "";
  let c = col;
  while (c) {
    c--;
    label = String.fromCharCode(65 + (c % 26)) + label;
    c = Math.floor(c / 26);
  }
  return label;
}

describe("formula engine: operators and literals", () => {
  it("evaluates arithmetic with Excel precedence", () => {
    assert.equal(num("=1+2*3"), 7);
    assert.equal(num("=(1+2)*3"), 9);
    assert.equal(num("=10/4"), 2.5);
    assert.equal(num("=2^3^2"), 64, "^ is left-associative in Excel");
    assert.equal(num("=-2^2"), 4, "unary minus binds tighter than ^");
    assert.equal(num("=2^-2"), 0.25);
    assert.equal(num("=--5"), 5);
    assert.equal(num("=1.5e2+1"), 151, "exponent notation parses");
    assert.equal(num("=TRUE+TRUE"), 2, "booleans coerce in arithmetic");
    assert.equal(num('="5"+2'), 7, "numeric text coerces in arithmetic");
  });

  it("evaluates text concatenation and comparisons", () => {
    assert.equal(text('="hello "&"world"'), "hello world");
    assert.equal(text('="a"&1+1'), "a2", "& binds looser than +");
    assert.equal(text('="say ""hi"""'), 'say "hi"', '"" escapes a quote');
    assert.equal(bool("=1=1"), true);
    assert.equal(bool("=1<>2"), true);
    assert.equal(bool("=2>=3"), false);
    assert.equal(bool("=3<=3"), true);
    assert.equal(bool('=1+2=3'), true, "comparisons bind loosest");
    assert.equal(bool('="a"="A"'), true, "text equality is case-insensitive");
    assert.equal(bool('="b">"a"'), true);
    assert.equal(bool('=1="1"'), false, "number and text are never equal");
    assert.equal(bool("=TRUE>100"), true, "booleans outrank numbers");
  });

  it("treats TRUE/FALSE literals and blanks Excel-style", () => {
    assert.equal(evaluateSheetFormula("=TRUE").value, true);
    assert.equal(evaluateSheetFormula("=false").value, false);
    assert.equal(num("=Z99+5"), 5, "out-of-grid refs read as blank");
    assert.equal(evaluateSheetFormula("=").value, null);
    assert.equal(evaluateSheetFormula("=1").value, 1, "leading '=' is optional");
  });
});

describe("formula engine: references", () => {
  it("resolves relative, absolute and range references", () => {
    assert.equal(num("=A1+B2"), 5);
    assert.equal(num("=$A$1*2"), 2);
    assert.equal(num("=SUM(A1:B2)"), 10);
    assert.equal(num("=SUM(B2:A1)"), 10, "ranges normalize rows then columns");
    assert.equal(num("=A1:B1"), 1, "a bare range takes its top-left value");
  });

  it("resolves cross-sheet references case-insensitively", () => {
    assert.equal(num("=Sheet1!A1*2"), 2);
    assert.equal(num("=sheet1!A1"), 1);
    assert.equal(num("='My Sheet'!B1"), 20);
    assert.equal(num("='my sheet'!A1+'My Sheet'!B1"), 30);
    assert.equal(num("=SUM('My Sheet'!A1:B1)"), 30);
    assert.equal(errorOf("=Nope!A1"), "#REF!", "unknown sheet is #REF!");
    assert.equal(errorOf("=Nope!A1:B2"), "#REF!");
  });

  it("propagates error cells and formula results through references", () => {
    const sheets = { S: [["=1/0", "=A1+1", "#N/A", "2"]] };
    assert.equal(errorOf("=B1", sheets, "S"), "#DIV/0!");
    assert.equal(errorOf("=SUM(A1:B1)", sheets, "S"), "#DIV/0!");
    assert.equal(errorOf("=SUM(C1:D1)", sheets, "S"), "#N/A", "literal error text propagates");
    assert.equal(num("=D1*2", sheets, "S"), 4, "clean cells still work");
  });

  it("supports column() and row() from context or a reference", () => {
    const withCell = { ...ctx(GRID), cell: { row: 3, column: 2 } };
    assert.equal(evaluateSheetFormula("=ROW()", withCell).value, 3);
    assert.equal(evaluateSheetFormula("=COLUMN()", withCell).value, 2);
    assert.equal(evaluateSheetFormula("=COLUMN()", ctx(GRID)).error, "#VALUE!", "no anchor cell in context");
    assert.equal(num("=COLUMN(C7)"), 3);
    assert.equal(num("=ROW(C7)"), 7);
    assert.equal(num("=COLUMN(B2:C4)"), 2, "range gives its top-left column");
  });
});

describe("formula engine: math functions", () => {
  it("covers rounding and basic math", () => {
    assert.equal(num("=ABS(-3)"), 3);
    assert.equal(num("=SQRT(9)"), 3);
    assert.equal(num("=POWER(2,10)"), 1024);
    assert.equal(num("=MOD(10,3)"), 1);
    assert.equal(num("=MOD(-10,3)"), 2, "MOD follows the sign of the divisor");
    assert.equal(num("=INT(-1.5)"), -2);
    assert.equal(num("=CEILING(2.1)"), 3);
    assert.equal(num("=CEILING(1.234,0.05)"), 1.25);
    assert.equal(num("=FLOOR(2.9)"), 2);
    assert.equal(num("=ROUND(2.5)"), 3);
    assert.equal(num("=ROUND(-2.5)"), -3, "ROUND is half away from zero");
    assert.equal(num("=ROUND(3.14159,2)"), 3.14);
    assert.equal(num("=ROUND(2.345,2)"), 2.35);
    assert.equal(num("=ROUNDUP(3.1,0)"), 4);
    assert.equal(num("=ROUNDUP(-3.1,0)"), -4);
    assert.equal(num("=ROUNDDOWN(3.9,0)"), 3);
    assert.equal(num("=ROUNDDOWN(-3.9,0)"), -3);
    assert.equal(num("=EXP(0)"), 1);
    assert.ok(Math.abs(num("=LN(EXP(2))") - 2) < 1e-9);
    assert.ok(Math.abs(num("=LOG(100)") - 2) < 1e-9);
    assert.ok(Math.abs(num("=LOG(8,2)") - 3) < 1e-12);
    assert.equal(num("=LOG10(1000)"), 3);
    assert.equal(num("=SIGN(-5)"), -1);
    assert.equal(num("=SIGN(0)"), 0);
  });

  it("maps numeric domain errors to #VALUE!", () => {
    assert.equal(errorOf("=SQRT(-1)"), "#VALUE!");
    assert.equal(errorOf("=LN(0)"), "#VALUE!");
    assert.equal(errorOf("=LOG10(-2)"), "#VALUE!");
    assert.equal(errorOf("=MOD(1,0)"), "#DIV/0!");
    assert.equal(errorOf("=1/0"), "#DIV/0!");
    assert.equal(errorOf('=1+"abc"'), "#VALUE!");
    assert.equal(errorOf("=NOPEFN(1)"), "#NAME?", "unknown functions are #NAME?");
    assert.equal(errorOf("=notafunction"), "#NAME?");
  });
});

describe("formula engine: aggregate and statistics functions", () => {
  const stats: Record<string, string[][]> = { S: [["2", "4", "4", "4", "5", "5", "7", "9"]] };
  it("aggregates ranges and coerces direct scalars", () => {
    assert.equal(num("=SUM(A1:B2)"), 10);
    assert.equal(num("=SUM(1,2,3)"), 6);
    assert.equal(num("=PRODUCT(A1:B1)"), 2);
    assert.equal(num("=PRODUCT(2,3,4)"), 24);
    assert.equal(num("=AVERAGE(A1:B2)"), 2.5);
    assert.equal(num("=MIN(3,1,2)"), 1);
    assert.equal(num("=MAX(A1:B2)"), 4);
    assert.equal(num("=COUNT(A1:B2)"), 4);
    assert.equal(num('=COUNT(1,"x",2)'), 2, "COUNT only counts numbers");
    assert.equal(num("=COUNTA(A1:B2,1)"), 5);
    assert.equal(num("=COUNTBLANK(A1:C2)"), 2);
    assert.equal(errorOf("=AVERAGE(Z9:Z10)"), "#DIV/0!", "no numbers to average");
  });

  it("computes statistics", () => {
    assert.equal(num("=MEDIAN(1,2,3,4)"), 2.5);
    assert.equal(num("=MEDIAN(1,9)"), 5);
    assert.equal(num("=LARGE(A1:H1,2)", stats, "S"), 7);
    assert.equal(num("=SMALL(A1:H1,2)", stats, "S"), 4);
    assert.equal(errorOf("=LARGE(A1:H1,99)", stats, "S"), "#VALUE!");
    assert.ok(Math.abs(num("=STDEV(A1:H1)", stats, "S") - 2.1380899) < 1e-5, "sample stdev");
    assert.equal(num("=STDEVP(A1:H1)", stats, "S"), 2, "population stdev");
    assert.ok(Math.abs(num("=VAR(A1:H1)", stats, "S") - 32 / 7) < 1e-9);
    assert.equal(num("=VARP(A1:H1)", stats, "S"), 4);
  });
});

describe("formula engine: logical and information functions", () => {
  it("evaluates logic lazily and safely", () => {
    assert.equal(evaluateSheetFormula('=IF(1>2,"a","b")').value, "b");
    assert.equal(evaluateSheetFormula('=IF(2>1,"a","b")').value, "a");
    assert.equal(num("=IF(TRUE,1,1/0)"), 1, "IF only evaluates the taken branch");
    assert.equal(evaluateSheetFormula("=IF(FALSE,1)").value, false);
    assert.equal(evaluateSheetFormula('=IFERROR(1/0,"fallback")').value, "fallback");
    assert.equal(num("=IFERROR(7,0)"), 7);
    assert.equal(bool("=AND(TRUE,1)"), true);
    assert.equal(bool("=AND(TRUE,0)"), false);
    assert.equal(bool("=OR(FALSE,0)"), false);
    assert.equal(bool("=OR(0,2)"), true);
    assert.equal(bool("=NOT(FALSE)"), true);
    assert.equal(errorOf("=AND()"), "#VALUE!");
  });

  it("classifies values", () => {
    const blank: Record<string, string[][]> = { S: [["", "1", "x"]] };
    assert.equal(evaluateSheetFormula("=ISBLANK(A1)", ctx(blank, "S")).value, true);
    assert.equal(evaluateSheetFormula("=ISBLANK(B1)", ctx(blank, "S")).value, false);
    assert.equal(evaluateSheetFormula("=ISNUMBER(B1)", ctx(blank, "S")).value, true);
    assert.equal(evaluateSheetFormula('=ISNUMBER("1")').value, false);
    assert.equal(evaluateSheetFormula('=ISTEXT("1")').value, true);
    assert.equal(evaluateSheetFormula("=ISERROR(1/0)").value, true);
    assert.equal(evaluateSheetFormula("=ISERROR(1)").value, false);
    assert.equal(evaluateSheetFormula('=ISERROR(ISERROR(1/0))').value, false);
  });
});

describe("formula engine: text functions", () => {
  it("slices, cases, substitutes and repeats text", () => {
    assert.equal(text('=CONCAT("a","b","c")'), "abc");
    assert.equal(text('=CONCATENATE("x","y")'), "xy");
    assert.equal(text('=CONCAT("n=1",A1)'), "n=11", "numbers stringify without float noise");
    assert.equal(num('=LEN("hello")'), 5);
    assert.equal(text('=LEFT("hello")'), "h");
    assert.equal(text('=LEFT("hello",2)'), "he");
    assert.equal(text('=RIGHT("hello",3)'), "llo");
    assert.equal(text('=MID("hello",2,3)'), "ell");
    assert.equal(text('=UPPER("aBc")'), "ABC");
    assert.equal(text('=LOWER("aBc")'), "abc");
    assert.equal(text('=TRIM("  a   b  ")'), "a b", "TRIM collapses inner runs of spaces");
    assert.equal(text('=SUBSTITUTE("aaa","a","b")'), "bbb");
    assert.equal(text('=SUBSTITUTE("a-a-a","a","b",2)'), "a-b-a");
    assert.equal(text('=REPLACE("abcdef",2,3,"XY")'), "aXYef");
    assert.equal(text('=REPEAT("ab",3)'), "ababab");
    assert.equal(errorOf('=LEFT("x",-1)'), "#VALUE!");
    assert.equal(errorOf('=REPEAT("ab",-2)'), "#VALUE!");
  });

  it("searches and converts", () => {
    assert.equal(num('=FIND("b","abc")'), 2);
    assert.equal(num('=FIND("b","abcb",3)'), 4);
    assert.equal(errorOf('=FIND("B","abc")'), "#VALUE!", "FIND is case-sensitive");
    assert.equal(num('=SEARCH("B","abc")'), 2, "SEARCH is case-insensitive");
    assert.equal(num('=SEARCH("l*o","hello")'), 3, "SEARCH supports * wildcards");
    assert.equal(num('=SEARCH("?e","hello")'), 1, "SEARCH supports ? wildcards");
    assert.equal(errorOf('=SEARCH("z","abc")'), "#VALUE!");
    assert.equal(num('=VALUE("12.5")'), 12.5);
    assert.equal(num('=VALUE("50%")'), 0.5);
    assert.equal(errorOf('=VALUE("abc")'), "#VALUE!");
    assert.equal(text('=TEXT(1.5,"0.00")'), "1.50");
    assert.equal(text('=TEXT(0.256,"0%")'), "26%");
    assert.equal(text('=TEXT(0.125,"0.0%")'), "12.5%");
    assert.equal(errorOf('=TEXT(1,"#,##0")'), "#VALUE!", "only basic 0.00/0% formats are supported");
  });
});

describe("formula engine: dates as serial numbers", () => {
  const NOW_MS = Date.UTC(2026, 9, 27, 6, 30);
  const todaySerial = Math.floor((Date.UTC(2026, 9, 27) - Date.UTC(1899, 11, 30)) / 86400000);
  const withClock = { ...ctx(GRID), now: NOW_MS };

  it("computes DATE / YEAR / MONTH / DAY", () => {
    assert.equal(num("=DATE(2024,3,5)"), 45356);
    assert.equal(num("=YEAR(DATE(2024,3,5))"), 2024);
    assert.equal(num("=MONTH(DATE(2024,3,5))"), 3);
    assert.equal(num("=DAY(DATE(2024,3,5))"), 5);
    assert.equal(num("=YEAR(45356)"), 2024);
    assert.equal(num("=DATE(2020,13,1)"), num("=DATE(2021,1,1)"), "months normalize like Excel");
    assert.equal(errorOf("=DATE(1899,1,1)"), "#VALUE!");
  });

  it("reads TODAY/NOW from ctx.now", () => {
    assert.equal(evaluateSheetFormula("=TODAY()", withClock).value, todaySerial);
    const nowSerial = evaluateSheetFormula("=NOW()", withClock).value as number;
    assert.ok(nowSerial > todaySerial && nowSerial < todaySerial + 1, "NOW() carries the time fraction");
    assert.equal(evaluateSheetFormula("=YEAR(TODAY())", withClock).value, 2026);
    assert.equal(typeof evaluateSheetFormula("=TODAY()").value, "number", "without ctx.now it falls back to the clock");
  });
});

describe("formula engine: lookups", () => {
  it("vlookups exactly and approximately", () => {
    assert.equal(num('=VLOOKUP("b",Letters!A1:B3,2,FALSE)'), 2);
    assert.equal(num('=VLOOKUP("c",Letters!A1:B3,2,FALSE)'), 3);
    assert.equal(num('=VLOOKUP("b",Letters!A1:B3,2)'), 2, "approximate lookup still finds exact");
    assert.equal(errorOf('=VLOOKUP("zz",Letters!A1:B3,2,FALSE)'), "#N/A");
    assert.equal(num("=VLOOKUP(25,NumsCol!A1:A3,1)"), 20, "approximate picks the largest value <= lookup");
    assert.equal(num("=VLOOKUP(15,NumsCol!A1:A3,1)"), 10);
    assert.equal(errorOf("=VLOOKUP(5,NumsCol!A1:A3,1)"), "#N/A", "smaller than every row");
    assert.equal(errorOf("=VLOOKUP(5,NumsCol!A1:A3,2)"), "#REF!", "column beyond the table is #REF!");
    assert.equal(errorOf("=VLOOKUP(5,NumsCol!A1:A3,0)"), "#VALUE!");
  });

  it("hlookups, indexes and matches", () => {
    assert.equal(num("=HLOOKUP(20,Nums!A1:C1,1,FALSE)"), 20);
    assert.equal(num("=HLOOKUP(25,Nums!A1:C1,1)"), 20, "approximate HLOOKUP");
    assert.equal(errorOf("=HLOOKUP(99,Nums!A1:C1,1,FALSE)"), "#N/A");
    assert.equal(evaluateSheetFormula('=INDEX(Letters!A1:B3,2,1)', ctx(GRID)).value, "b");
    assert.equal(evaluateSheetFormula('=INDEX(Letters!A1:A3,3)', ctx(GRID)).value, "c", "single-column INDEX indexes along it");
    assert.equal(errorOf("=INDEX(Letters!A1:B3,9,1)"), "#REF!");
    assert.equal(num('=MATCH("c",Letters!A1:A3,0)'), 3);
    assert.equal(num("=MATCH(25,Nums!A1:C1,1)"), 2);
    assert.equal(errorOf('=MATCH("zz",Letters!A1:A3,0)'), "#N/A");
    assert.equal(num('=INDEX(Letters!A1:B3,MATCH("b",Letters!A1:A3,0),2)'), 2, "INDEX+MATCH compose");
  });
});

describe("formula engine: conditional aggregates", () => {
  const cond: Record<string, string[][]> = { S: [["1", "6", "x"], ["4", "9", "2"]] };
  it("sums, counts and averages by criteria", () => {
    assert.equal(num("=SUMIF(A1:B2,\">3\")", cond, "S"), 19, "6+4+9");
    assert.equal(num("=COUNTIF(A1:B2,\">3\")", cond, "S"), 3);
    assert.ok(Math.abs(num("=AVERAGEIF(A1:B2,\">3\")", cond, "S") - 19 / 3) < 1e-12);
    assert.equal(num('=COUNTIF(A1:B2,"4")', cond, "S"), 1, "numeric text criteria matches numbers");
    assert.equal(num("=SUMIF(A1:B2,\">3\",C1:C2)", cond, "S"), 2, "third argument redirects the summed range");
    assert.equal(errorOf("=AVERAGEIF(A1:B2,\">99\")", cond, "S"), "#DIV/0!");
    assert.equal(num("=SUMIF(A1:B2,\"<>4\")", cond, "S"), 16, "1+6+9 within A1:B2");
  });
});

describe("formula engine: recalcSheet", () => {
  it("computes every formula cell dependency-aware", () => {
    const cells = [
      ["1", "2", "=SUM(A1:B1)"],
      ["=C1*10", "5", '=IF(B2>3,"big","small")'],
      ["=B2+A2", "", ""],
    ];
    const result = recalcSheet(cells, { sheet: "Main", sheets: { Main: cells, Data: [["30"]] } });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.values[0], [1, 2, 3]);
    assert.deepEqual(result.values[1], [30, 5, "big"]);
    assert.deepEqual(result.values[2], [35, null, null]);
  });

  it("resolves cross-sheet formulas from the workbook map", () => {
    const cells = [["=Data!A1*10"]];
    const result = recalcSheet(cells, { sheet: "Main", sheets: { Main: cells, Data: [["30"]] } });
    assert.deepEqual(result.values, [[300]]);
  });

  it("marks circular references as #CIRC!", () => {
    const cycle = recalcSheet([["=B1", "=A1"]]);
    assert.deepEqual(cycle.values, [["#CIRC!", "#CIRC!"]]);
    assert.equal(cycle.errors.length, 2);
    assert.ok(cycle.errors.includes("A1: #CIRC!") && cycle.errors.includes("B1: #CIRC!"));

    const self = recalcSheet([["=A1+1"]]);
    assert.deepEqual(self.values, [["#CIRC!"]]);

    const indirect = recalcSheet([["=A2"], ["=A3"], ["=A1"]]);
    assert.equal(indirect.values[0]![0], "#CIRC!");
    assert.equal(indirect.values[1]![0], "#CIRC!");
    assert.equal(indirect.values[2]![0], "#CIRC!");
  });

  it("lets IFERROR contain a circular reference", () => {
    const result = recalcSheet([["=B1+1", "=IFERROR(A1,0)"]]);
    assert.deepEqual(result.values, [[1, 0]]);
  });

  it("reports errors per cell with addresses", () => {
    const result = recalcSheet([["=1/0", "=Nope!A1", "fine"]]);
    assert.deepEqual(result.values, [["#DIV/0!", "#REF!", "fine"]]);
    assert.deepEqual(result.errors, ["A1: #DIV/0!", "B1: #REF!"]);
  });

  it("normalizes non-formula cells to typed values", () => {
    const result = recalcSheet([["100", "", "hello", "TRUE", "0012"]]);
    assert.deepEqual(result.values, [[100, null, "hello", true, "0012"]]);
  });
});

describe("formula engine: limits", () => {
  it("rejects expressions beyond the caps with #VALUE!", () => {
    // Within the 2000-character cap an expression cannot exceed 5000 AST nodes,
    // so the length and depth caps are the practically reachable guards.
    assert.equal(errorOf("=1" + "+1".repeat(1000)), "#VALUE!", "over 2000 characters");
    assert.equal(num("=1" + "+1".repeat(998)), 999, "the longest flat chain under 2000 chars still works");
    assert.equal(errorOf("=" + "(".repeat(65) + "1" + ")".repeat(65)), "#VALUE!", "65 nesting levels");
    assert.equal(num("=" + "(".repeat(64) + "1" + ")".repeat(64)), 1, "64 nesting levels pass");
    assert.equal(errorOf("=" + "-".repeat(65) + "1"), "#VALUE!", "unary chains count as depth");
    assert.equal(num("=" + "-".repeat(64) + "1"), 1, "64 unary minuses pass");
  });

  it("caps formula-to-formula dependency chains", () => {
    const row: string[] = ["1"];
    for (let i = 1; i < 300; i++) row.push(`=${colName(i)}1+0`);
    const sheets = { S: [row] };
    assert.equal(errorOf("=KN1", sheets, "S"), "#VALUE!", "300-hop chain exceeds the cap");
    assert.equal(num("=G1", sheets, "S"), 1, "short chains are fine");
    // A top-down recalc evaluates cell by cell, so the whole grid still resolves.
    const result = recalcSheet([row], { sheet: "S", sheets });
    assert.equal(result.values[0]!.length, 300);
    assert.equal(result.values[0]![299], 1);
    assert.deepEqual(result.errors, []);
  });
});

describe("formula engine: display formatting", () => {
  it("formats values without float noise", () => {
    assert.equal(formatFormulaValue(null), "");
    assert.equal(formatFormulaValue(6), "6");
    assert.equal(formatFormulaValue(300), "300");
    assert.equal(formatFormulaValue(-0), "0");
    assert.equal(formatFormulaValue(0.1 + 0.2), "0.3");
    assert.equal(formatFormulaValue(true), "TRUE");
    assert.equal(formatFormulaValue("abc"), "abc");
    assert.equal(formatFormulaValue("#DIV/0!"), "#DIV/0!");
    assert.equal(isFormulaErrorText("#CIRC!"), true);
    assert.equal(isFormulaErrorText("nope"), false);
  });
});
