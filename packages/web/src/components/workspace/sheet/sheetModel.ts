/**
 * Framework-free sheet model helpers shared by the editor and its tests.
 * Kept free of `@/` imports so unit tests can import it directly.
 */
export type SheetStyleValue = string | number | boolean;

export interface EditorSheet {
  name: string;
  cells: string[][];
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
