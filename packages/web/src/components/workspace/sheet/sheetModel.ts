/**
 * Framework-free sheet model helpers shared by the editor and its tests.
 * Kept free of `@/` imports so unit tests can import it directly.
 */
export type SheetStyleValue = string | number | boolean;

export interface EditorSheet {
  name: string;
  cells: string[][];
  /** Computed display values (formula results) delivered by the server on GET.
   * Read-only for the editor: the PUT payload keeps `cells` and the server
   * recomputes values on read, so serializeSheetDoc omits this field. */
  values?: string[][];
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

export const DEFAULT_COLUMN_WIDTH = 12;
export const DEFAULT_ROW_HEIGHT = 20;

/** The payload PUT back through onSave: the server turns this JSON into .xlsx. */
export function serializeSheetDoc(doc: SheetDoc): string {
  return JSON.stringify({
    sheets: doc.sheets.map((sheet) => ({
      name: sheet.name,
      cells: sheet.cells,
      styles: sheet.styles,
      columnWidths: sheet.columnWidths,
      rowHeights: sheet.rowHeights,
      merges: sheet.merges,
      hiddenRows: sheet.hiddenRows,
      hiddenColumns: sheet.hiddenColumns,
    })),
    notes: doc.notes,
  });
}

/** Cheap content fingerprint used by live refresh to detect external edits. */
export function sheetDocDigest(doc: SheetDoc): string {
  const text = serializeSheetDoc(doc);
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return `${doc.sheets.length}:${text.length}:${hash}`;
}

export function columnLabel(index: number): string {
  let label = '';
  let n = index + 1;
  while (n > 0) {
    const mod = (n - 1) % 26;
    label = String.fromCharCode(65 + mod) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

export function addressAt(row: number, column: number): string {
  return `${columnLabel(column)}${row + 1}`;
}

export function sheetDimensions(sheet: EditorSheet): { rows: number; columns: number } {
  return {
    rows: sheet.cells.length,
    columns: sheet.cells.reduce((max, row) => Math.max(max, row.length), 0),
  };
}

/* ---------------------------------------------------------------------------
 * Display values, ranges, merges, styles, find — pure helpers shared by the
 * editor and its tests. The server recomputes `values` on every GET; the
 * editor falls back to the raw cell text whenever they are missing.
 * ------------------------------------------------------------------------- */

export interface CellIndex {
  r: number;
  c: number;
}

export interface CellRange {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

/** The text shown in a non-focused, non-editing cell: the computed formula
 * result when the server provided it, otherwise the raw cell text. */
export function displayValue(sheet: EditorSheet, r: number, c: number): string {
  return sheet.values?.[r]?.[c] ?? sheet.cells[r]?.[c] ?? '';
}

export function normalizeRange(a: CellIndex, b: CellIndex): CellRange {
  return {
    r1: Math.min(a.r, b.r),
    c1: Math.min(a.c, b.c),
    r2: Math.max(a.r, b.r),
    c2: Math.max(a.c, b.c),
  };
}

export function rangeAddress(range: CellRange): string {
  return `${addressAt(range.r1, range.c1)}:${addressAt(range.r2, range.c2)}`;
}

export function rangeIndexes(range: CellRange): CellIndex[] {
  const cells: CellIndex[] = [];
  for (let r = range.r1; r <= range.r2; r++) {
    for (let c = range.c1; c <= range.c2; c++) cells.push({ r, c });
  }
  return cells;
}

const RANGE_PATTERN = /^([A-Z]{1,3})(\d{1,4}):([A-Z]{1,3})(\d{1,4})$/;

function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1; // zero-based
}

/** Parse an "A1:B3" merge address into zero-based inclusive coordinates. */
export function parseRangeAddress(address: string): CellRange | null {
  const match = RANGE_PATTERN.exec(address.trim().toUpperCase());
  if (!match) return null;
  const r1 = Number(match[2]!) - 1;
  const c1 = columnIndex(match[1]!);
  const r2 = Number(match[4]!) - 1;
  const c2 = columnIndex(match[3]!);
  if (r1 < 0 || c1 < 0 || r1 > r2 || c1 > c2) return null;
  return { r1, c1, r2, c2 };
}

export function rangesOverlap(a: CellRange, b: CellRange): boolean {
  return !(a.r2 < b.r1 || a.r1 > b.r2 || a.c2 < b.c1 || a.c1 > b.c2);
}

/** Layout facts the grid needs to render merged ranges: the anchor cell
 * carries the span, every other covered cell is skipped. */
export interface MergeGeometry {
  anchors: Map<string, { rowSpan: number; colSpan: number }>;
  covered: Set<string>;
}

export function mergeGeometry(sheet: EditorSheet): MergeGeometry {
  const anchors = new Map<string, { rowSpan: number; colSpan: number }>();
  const covered = new Set<string>();
  for (const merge of sheet.merges) {
    const range = parseRangeAddress(merge);
    if (!range) continue;
    anchors.set(`${range.r1},${range.c1}`, {
      rowSpan: range.r2 - range.r1 + 1,
      colSpan: range.c2 - range.c1 + 1,
    });
    for (const { r, c } of rangeIndexes(range)) {
      if (r === range.r1 && c === range.c1) continue;
      covered.add(`${r},${c}`);
    }
  }
  return { anchors, covered };
}

/** Keys removed when the border toggle switches off (sides + their colors). */
export const BORDER_STYLE_KEYS = [
  'borderTop',
  'borderLeft',
  'borderRight',
  'borderBottom',
  'borderTopColor',
  'borderLeftColor',
  'borderRightColor',
  'borderBottomColor',
] as const;

/** Set style keys on every address; an empty record drops the address. */
export function applyStylePatch(
  styles: Record<string, Record<string, SheetStyleValue>>,
  addresses: string[],
  patch: Record<string, SheetStyleValue>,
): Record<string, Record<string, SheetStyleValue>> {
  if (!addresses.length || !Object.keys(patch).length) return styles;
  const next = { ...styles };
  for (const address of addresses) {
    const record = { ...(next[address] ?? {}), ...patch };
    if (Object.keys(record).length) next[address] = record;
    else delete next[address];
  }
  return next;
}

/** Remove style keys from every address; an empty record drops the address. */
export function clearStyleKeys(
  styles: Record<string, Record<string, SheetStyleValue>>,
  addresses: string[],
  keys: readonly string[],
): Record<string, Record<string, SheetStyleValue>> {
  if (!addresses.length) return styles;
  const next = { ...styles };
  for (const address of addresses) {
    const record = next[address];
    if (!record || !keys.some((key) => key in record)) continue;
    const copy = { ...record };
    for (const key of keys) delete copy[key as keyof typeof copy];
    if (Object.keys(copy).length) next[address] = copy;
    else delete next[address];
  }
  return next;
}

/** Cells whose raw text OR computed value contains the query, row-major. */
export function findInSheet(sheet: EditorSheet, query: string): CellIndex[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: CellIndex[] = [];
  sheet.cells.forEach((row, r) => {
    row.forEach((text, c) => {
      const raw = (text ?? '').toLowerCase();
      const computed = (sheet.values?.[r]?.[c] ?? '').toLowerCase();
      if (raw.includes(needle) || computed.includes(needle)) hits.push({ r, c });
    });
  });
  return hits;
}

/** Number of cells with non-blank text on the current sheet. */
export function countFilledCells(sheet: EditorSheet): number {
  let count = 0;
  for (const row of sheet.cells) {
    for (const text of row) if (text && text.trim()) count += 1;
  }
  return count;
}
