/** Client helper for the sheet workspace editor: mirrors the server's JSON sheet model. */
import { getApiBase, getApiHeaders } from '@/services/rpc';

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

export function sheetUrl(file: { taskId: string; path: string }, format?: 'raw'): string {
  const params = new URLSearchParams({ taskId: file.taskId, path: file.path });
  if (format) params.set('format', format);
  return `${getApiBase()}/api/workspace/sheet/file?${params.toString()}`;
}

export async function loadSheetDoc(file: { taskId: string; path: string }): Promise<SheetDoc> {
  const res = await fetch(sheetUrl(file), { headers: await getApiHeaders() });
  if (!res.ok) {
    const message = await res.json().catch(() => ({}));
    throw new Error(typeof message.error === 'string' ? message.error : `HTTP ${res.status}`);
  }
  return (await res.json()) as SheetDoc;
}

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

/** Pad a sheet's grid boundary helpers so edits stay rectangular. */
export function ensureRow(sheet: EditorSheet): string[] {
  const width = sheet.cells.reduce((max, row) => Math.max(max, row.length), 0);
  return new Array(width).fill('');
}

export function sheetDimensions(sheet: EditorSheet): { rows: number; columns: number } {
  return {
    rows: sheet.cells.length,
    columns: sheet.cells.reduce((max, row) => Math.max(max, row.length), 0),
  };
}
