/**
 * Sheet workspace IO: read an .xlsx workbook from a task workspace into a plain
 * JSON model the web sheet editor can render, and write that model back as an
 * editable native .xlsx. Values and formulas round-trip as text; common cell
 * styling (fonts, fills, alignment, borders, number formats), column widths,
 * row heights, merged ranges and hidden rows/columns round-trip too.
 *
 * Formatting application reuses the studio spreadsheet writer
 * (studio/sheet-format.ts) which office tools already rely on, so saved files
 * open natively in Office like the studio exports do.
 */
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { applySheetFormat } from "../../studio/sheet-format.js";
import { recalcSheet, formatFormulaValue } from "../../studio/sheet-formulas.js";

export const MAX_SHEETS = 20;
export const MAX_ROWS = 2000;
export const MAX_COLUMNS = 100;
const DEFAULT_COLUMN_WIDTH = 12;
const DEFAULT_ROW_HEIGHT = 20;
const NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const MERGE_PATTERN = /^([A-Z]{1,3})(\d{1,4}):([A-Z]{1,3})(\d{1,4})$/;

export type SheetStyleValue = string | number | boolean;

export interface EditorSheet {
  name: string;
  /** Row-major cell text. Formulas keep their leading '='. */
  cells: string[][];
  /** Row-major display values computed by the formula engine: formula results formatted as text (errors as "#CODE!"), non-formula cells as their normalized text. */
  values: string[][];
  styles: Record<string, Record<string, SheetStyleValue>>;
  columnWidths: number[];
  rowHeights: number[];
  merges: string[];
  hiddenRows: boolean[];
  hiddenColumns: boolean[];
}

export interface SheetDoc {
  taskId: string;
  path: string;
  name: string;
  sheets: EditorSheet[];
  notes: string[];
}

export class SheetIOError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "SheetIOError";
  }
}

export function sheetFileIdentity(root: string, rel: string): { taskId: string; path: string; name: string } {
  return {
    taskId: "",
    path: rel.split(/\\+/).join("/"),
    name: path.basename(rel),
  };
}

/** Extract the editable text for one cell: formulas stay editable, values become text. */
function cellText(cell: ExcelJS.Cell): string {
  if (cell.isMerged && cell.master && cell.master.address !== cell.address) return "";
  const value: unknown = cell.value;
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.formula === "string" || typeof record.formula === "number") return "=" + String(record.formula);
    if (Array.isArray(record.richText)) {
      return record.richText
        .map((part) => (typeof part === "object" && part !== null ? String((part as Record<string, unknown>).text ?? "") : String(part)))
        .join("");
    }
    if (record.hyperlink !== undefined) return String(record.text ?? "");
    if (record.error !== undefined) return "#" + String(record.error);
    if (record.result !== undefined) return String(record.result);
    return "";
  }
  return String(value);
}

const BORDER_SIDES = ["top", "left", "right", "bottom"] as const;

function hex6(argb: unknown, fallback: string | null): string | null {
  const hex = String(argb ?? "");
  const digits = /^[0-9a-fA-F]*$/.test(hex) ? hex.slice(-6) : "";
  return /^[0-9a-fA-F]{6}$/.test(digits) ? "#" + digits.toLowerCase() : fallback;
}

/** Collect round-trippable cell style facts (subset of what the studio writer accepts). */
function cellStyle(cell: ExcelJS.Cell): Record<string, SheetStyleValue> {
  const style: Record<string, SheetStyleValue> = {};
  const font = cell.font;
  if (font?.name) style.fontFamily = String(font.name);
  if (typeof font?.size === "number" && font.size) style.fontSize = font.size;
  if (font?.bold === true) style.bold = true;
  if (font?.italic === true) style.italic = true;
  const color = hex6(font?.color?.argb, null);
  if (color) style.color = color;
  if (fillSolid(cell)) {
    const background = hex6((cell.fill as ExcelJS.FillPattern).fgColor?.argb, null);
    if (background) style.background = background;
  }
  const alignment = cell.alignment;
  if (alignment) {
    if (typeof alignment.horizontal === "string") style.alignment = alignment.horizontal;
    if (typeof alignment.vertical === "string") style.verticalAlignment = alignment.vertical;
    if (typeof alignment.wrapText === "boolean") style.wrapText = alignment.wrapText;
  }
  if (typeof cell.numFmt === "string" && cell.numFmt && cell.numFmt !== "General") style.numberFormat = cell.numFmt;
  const border = cell.border;
  if (border) {
    for (const side of BORDER_SIDES) {
      const edge = border[side];
      if (!edge?.style) continue;
      const key = "border" + side.charAt(0).toUpperCase() + side.slice(1);
      style[key] = String(edge.style);
      const borderColor = hex6(edge.color?.argb, null);
      if (borderColor) style[key + "Color"] = borderColor;
    }
  }
  return style;
}

function fillSolid(cell: ExcelJS.Cell): boolean {
  const fill = cell.fill as ExcelJS.FillPattern | undefined;
  return !!fill && typeof fill.pattern === "string" && fill.pattern === "solid" && /^[0-9a-fA-F]{6}$/.test(String(fill.fgColor?.argb ?? "").slice(-6));
}

/** Chart parts make the workbook visual in ways this editor does not round-trip. */
async function chartNotes(buffer: Buffer): Promise<string[]> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return [];
  }
  const charts = Object.keys(zip.files).filter((name) => /^xl\/charts\/[^/]+\.xml$/i.test(name));
  return charts.length
    ? [`This workbook contains ${charts.length} chart${charts.length === 1 ? "" : "s"}. The basic sheet editor rewrites the file without charts, so edit chart data in Office or keep a backup.`]
    : [];
}

/** Read one workbook file into the JSON sheet model. */
export async function readSheetDoc(abs: string, identity: { taskId: string; path: string; name: string }): Promise<SheetDoc> {
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new SheetIOError("file not found", 404);
  const buffer = fs.readFileSync(abs);
  let workload = new ExcelJS.Workbook();
  try {
    workload = await workload.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  } catch {
    throw new SheetIOError("this file is not a readable .xlsx workbook", 400);
  }

  const notes: string[] = [...(await chartNotes(buffer))];
  const sheets: EditorSheet[] = [];
  const selected = workload.worksheets.slice(0, MAX_SHEETS);
  if (workload.worksheets.length > MAX_SHEETS) {
    notes.push(`The workbook has ${workload.worksheets.length} sheets; the first ${MAX_SHEETS} are loaded and a later save would drop the rest.`);
  }
  for (const sheet of selected) {
    const rows = Math.min(sheet.rowCount || 0, MAX_ROWS);
    const columns = Math.min(sheet.columnCount || 0, MAX_COLUMNS);
    if (sheet.rowCount > MAX_ROWS || sheet.columnCount > MAX_COLUMNS) {
      notes.push(`Sheet “${sheet.name}” is truncated to ${rows} rows × ${columns} columns for the basic editor.`);
    }
    const cells: string[][] = [];
    const styles: Record<string, Record<string, SheetStyleValue>> = {};
    for (let r = 1; r <= rows; r++) {
      const row: string[] = [];
      for (let c = 1; c <= columns; c++) {
        const cell = sheet.getCell(r, c);
        const text = cellText(cell);
        if (text !== "" && /^[A-Z]{1,3}\d{1,4}$/.test(cell.address)) {
          const style = cellStyle(cell);
          if (Object.keys(style).length) styles[cell.address] = style;
        }
        row.push(text);
      }
      cells.push(row);
    }
    const width = (i: number) => {
      const w = sheet.getColumn(i + 1).width;
      return typeof w === "number" && w > 0 ? Number(w.toFixed(1)) : DEFAULT_COLUMN_WIDTH;
    };
    const height = (i: number) => {
      const h = sheet.getRow(i + 1).height;
      return typeof h === "number" && h > 0 ? Number(h.toFixed(1)) : DEFAULT_ROW_HEIGHT;
    };
    const merges = (sheet.model as { merges?: string[] } | undefined)?.merges ?? [];
    sheets.push({
      name: sheet.name,
      cells,
      values: [],
      styles,
      columnWidths: Array.from({ length: columns }, (_, i) => width(i)),
      rowHeights: Array.from({ length: rows }, (_, i) => height(i)),
      merges: merges.map(String).filter((range) => MERGE_PATTERN.test(range)),
      hiddenRows: Array.from({ length: rows }, (_, i) => !!sheet.getRow(i + 1).hidden),
      hiddenColumns: Array.from({ length: columns }, (_, i) => !!sheet.getColumn(i + 1).hidden),
    });
  }
  // Compute display values for every sheet with the whole workbook addressable,
  // so cross-sheet formulas resolve. `cells` keeps the editable formula text.
  const sheetTexts: Record<string, string[][]> = {};
  for (const sheet of sheets) sheetTexts[sheet.name] = sheet.cells;
  for (const sheet of sheets) {
    const { values } = recalcSheet(sheet.cells, { sheet: sheet.name, sheets: sheetTexts });
    sheet.values = values.map((row) => row.map(formatFormulaValue));
  }
  if (!sheets.length) notes.push("The workbook has no sheets yet; the editor can start from an empty sheet.");
  return { ...identity, sheets, notes };
}

function uniqueSheetName(desired: string, used: Set<string>): string {
  const cleaned = String(desired ?? "").replace(/[\[\]:*?/\\]/g, " ").trim() || "Sheet";
  let name = cleaned.slice(0, 31);
  let n = 2;
  while (used.has(name.toLowerCase())) {
    const suffix = ` ${n}`;
    name = cleaned.slice(0, 31 - suffix.length) + suffix;
    n++;
  }
  used.add(name.toLowerCase());
  return name;
}

function normalizeCells(input: unknown): { cells: string[][]; changed: boolean; warning?: string } {
  if (!Array.isArray(input)) return { cells: [[]], changed: true, warning: "ignored a sheet without a cell grid" };
  const cells: string[][] = [];
  let changed = false;
  for (const rawRow of input.slice(0, MAX_ROWS)) {
    const row = Array.isArray(rawRow) ? rawRow.slice(0, MAX_COLUMNS).map((value) => (value === null || value === undefined ? "" : String(value))) : [""];
    if (!Array.isArray(rawRow) || rawRow.length > MAX_COLUMNS) changed = true;
    cells.push(row);
  }
  if (Array.isArray(input) && input.length > MAX_ROWS) {
    changed = true;
    return { cells, changed, warning: `cell grid truncated to ${MAX_ROWS} rows × ${MAX_COLUMNS} columns` };
  }
  return { cells, changed };
}

function sanitizeStyleRecord(input: unknown): Record<string, SheetStyleValue> {
  const out: Record<string, SheetStyleValue> = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
  }
  return out;
}

/** Validate a merge range against the grid and unresolved limits; null when unusable. */
function usableMerge(range: string, cells: string[][]): boolean {
  if (!MERGE_PATTERN.test(range)) return false;
  const columnIndex = (letters: string) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
  const match = MERGE_PATTERN.exec(range)!;
  const left = columnIndex(match[1]!);
  const top = Number(match[2]!);
  const right = columnIndex(match[3]!);
  const bottom = Number(match[4]!);
  if (left > right || top > bottom || right > MAX_COLUMNS || bottom > MAX_ROWS) return false;
  for (let r = top; r <= bottom; r++) {
    for (let c = left; c <= right; c++) {
      if (r === top && c === left) continue;
      if (cells[r - 1]?.[c - 1]) return false;
    }
  }
  return true;
}

function normalizeSheet(input: Record<string, unknown>, usedNames: Set<string>, warnings: string[]): EditorSheet {
  const { cells, warning } = normalizeCells(input.cells);
  if (warning) warnings.push(`Sheet “${String(input.name ?? "sheet")}”: ${warning}`);
  const styles: Record<string, Record<string, SheetStyleValue>> = {};
  for (const [address, rawStyle] of Object.entries((input.styles ?? {}) as Record<string, unknown>)) {
    const style = sanitizeStyleRecord(rawStyle);
    if (/^[A-Z]{1,3}\d{1,4}$/.test(address) && Object.keys(style).length) styles[address] = style;
  }
  const numbers = (value: unknown, fallback: number) =>
    Array.isArray(value)
      ? value.map((n) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : fallback))
      : [];
  const booleans = (value: unknown, fallback: boolean) =>
    Array.isArray(value) ? value.map((v) => v === null || v === undefined ? fallback : Boolean(v)) : [];
  const merges = Array.isArray(input.merges) ? input.merges.filter((m) => typeof m === "string") : [];
  const validMerges: string[] = [];
  for (const merge of merges) {
    if (usableMerge(merge, cells)) validMerges.push(merge);
  }
  if (validMerges.length < merges.length) {
    warnings.push(`Sheet “${String(input.name ?? "sheet")}”: dropped ${merges.length - validMerges.length} unusable merged range(s).`);
  }
  return {
    name: uniqueSheetName(String(input.name ?? "sheet"), usedNames),
    cells,
    // The PUT path writes `cells`; `values` is recomputed on read, so keep the normalized cell text here.
    values: cells.map((row) => [...row]),
    styles,
    columnWidths: numbers(input.columnWidths, DEFAULT_COLUMN_WIDTH),
    rowHeights: numbers(input.rowHeights, DEFAULT_ROW_HEIGHT),
    merges: validMerges,
    hiddenRows: booleans(input.hiddenRows, false),
    hiddenColumns: booleans(input.hiddenColumns, false),
  };
}

/** Validate and normalize the editor's JSON model into a writable document. */
export function parseSheetDoc(input: unknown, identity: { taskId: string; path: string; name: string }): SheetDoc {
  if (!input || typeof input !== "object") throw new SheetIOError("body must be a JSON sheet document", 400);
  const record = input as Record<string, unknown>;
  if (!Array.isArray(record.sheets)) throw new SheetIOError("body.sheets must be an array", 400);
  const warnings: string[] = [];
  const usedNames = new Set<string>();
  const sheets = (record.sheets as Record<string, unknown>[]).slice(0, MAX_SHEETS).map((sheet) =>
    typeof sheet === "object" && sheet !== null ? (sheet as Record<string, unknown>) : {},
  );
  if (record.sheets.length > MAX_SHEETS) warnings.push(`Only the first ${MAX_SHEETS} sheets are saved.`);
  const doc: SheetDoc = {
    ...identity,
    sheets: sheets.map((sheet) => normalizeSheet(sheet, usedNames, warnings)),
    notes: Array.isArray(record.notes) ? record.notes.map(String).slice(0, 10) : [],
  };
  if (!doc.sheets.length) throw new SheetIOError("at least one sheet is required", 400);
  if (warnings.length) doc.notes = [...doc.notes, ...warnings];
  return doc;
}

const isRtlText = (text: string) => /[\u0590-\u08ff]/u.test(text);

/** Write the JSON sheet model back as an editable .xlsx workbook. */
export async function writeSheetDoc(abs: string, doc: SheetDoc): Promise<{ bytes: number; warnings: string[] }> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Loam";
  workbook.calcProperties = { fullCalcOnLoad: true };
  const warnings: string[] = [];
  // The full workbook text is the formula context, so cross-sheet references resolve when caching results.
  const sheetTexts: Record<string, string[][]> = {};
  for (const source of doc.sheets) sheetTexts[source.name] = source.cells;
  for (const source of doc.sheets) {
    const rightToLeft = source.cells.some((row) => row.some(isRtlText));
    const sheet = workbook.addWorksheet(source.name, rightToLeft ? { views: [{ rightToLeft: true }] } : undefined);
    for (let r = 0; r < source.cells.length; r++) {
      for (let c = 0; c < source.cells[r]!.length; c++) {
        const text = source.cells[r]![c]!;
        if (text === "") continue;
        const cell = sheet.getCell(r + 1, c + 1);
        if (text.startsWith("=") && text.length > 1) cell.value = { formula: text.slice(1) };
        else if (NUMBER_PATTERN.test(text) && Number.isFinite(Number(text)) && text.replace(/[-.]/g, "").length <= 15) cell.value = Number(text);
        else cell.value = text;
        cell.font = { name: "Arial", size: 11 };
        cell.alignment = { vertical: "top", wrapText: true, ...(isRtlText(text) ? { horizontal: "right" as const } : {}) };
      }
    }
    for (const merge of source.merges) {
      const m = MERGE_PATTERN.exec(merge);
      if (!m) continue;
      const columnIndex = (letters: string) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
      const top = Number(m[2]!), bottom = Number(m[4]!), left = columnIndex(m[1]!), right = columnIndex(m[3]!);
      for (let r = top; r <= bottom; r++) {
        for (let c = left; c <= right; c++) {
          if (r === top && c === left) continue;
          const cell = sheet.getCell(r, c);
          if (cell.value !== null && cell.value !== undefined) sheet.getCell(r, c).value = null;
        }
      }
    }
    try {
      applySheetFormat(sheet, source, { sheet: source.name, sheets: sheetTexts });
    } catch (err) {
      warnings.push(`Sheet “${source.name}”: formatting partially skipped (${err instanceof Error ? err.message : String(err)}).`);
      workbook.removeWorksheet(sheet.id);
      const retry = workbook.addWorksheet(sheet.name, rightToLeft ? { views: [{ rightToLeft: true }] } : undefined);
      source.cells.forEach((row, rowIndex) =>
        row.forEach((value, colIndex) => {
          if (value === "") return;
          const cell = retry.getCell(rowIndex + 1, colIndex + 1);
          if (value.startsWith("=") && value.length > 1) cell.value = { formula: value.slice(1) };
          else if (NUMBER_PATTERN.test(value) && Number.isFinite(Number(value)) && value.replace(/[-.]/g, "").length <= 15) cell.value = Number(value);
          else cell.value = value;
        }),
      );
      applySheetFormat(
        retry,
        { cells: source.cells, columnWidths: source.columnWidths, rowHeights: source.rowHeights, hiddenRows: source.hiddenRows, hiddenColumns: source.hiddenColumns },
        { sheet: source.name, sheets: sheetTexts },
      );
    }
  }
  const buffer: Buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buffer);
  return { bytes: buffer.length, warnings };
}
