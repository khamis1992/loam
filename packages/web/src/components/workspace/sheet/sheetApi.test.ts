import { describe, it, expect } from 'vitest';
import {
  addressAt,
  columnLabel,
  serializeSheetDoc,
  sheetDocDigest,
  sheetDimensions,
  type SheetDoc,
} from './sheetModel';

function miniDoc(): SheetDoc {
  return {
    taskId: 'task_1',
    path: 'reports/budget.xlsx',
    name: 'budget.xlsx',
    sheets: [
      {
        name: 'Budget',
        cells: [
          ['Item', 'Cost'],
          ['desk', '100'],
          ['total', '=B1+B2'],
        ],
        styles: { A1: { bold: true } },
        columnWidths: [12, 9],
        rowHeights: [20, 20, 20],
        merges: [],
        hiddenRows: [false, false, false],
        hiddenColumns: [false, false],
      },
    ],
    notes: ['This workbook contains 1 chart.'],
  };
}

describe('sheet workspace helpers', () => {
  it('labels spreadsheet columns A..Z..AA', () => {
    expect(columnLabel(0)).toBe('A');
    expect(columnLabel(25)).toBe('Z');
    expect(columnLabel(26)).toBe('AA');
    expect(addressAt(0, 0)).toBe('A1');
    expect(addressAt(3, 25)).toBe('Z4');
  });

  it('computes grid dimensions from the tallest row', () => {
    const sheet = miniDoc().sheets[0]!;
    expect(sheetDimensions(sheet)).toEqual({ rows: 3, columns: 2 });
    expect(sheetDimensions({ ...sheet, cells: [] })).toEqual({ rows: 0, columns: 0 });
  });

  it('serializes the save payload without task identity fields', () => {
    const payload = JSON.parse(serializeSheetDoc(miniDoc())) as { sheets?: unknown[]; taskId?: string };
    expect(payload.sheets).toHaveLength(1);
    expect(payload.taskId).toBeUndefined();
  });

  it('digests the document content, not the save payload identity', () => {
    const doc = miniDoc();
    expect(sheetDocDigest(doc)).toBe(sheetDocDigest(miniDoc()));
    const edited: SheetDoc = { ...doc, sheets: [{ ...doc.sheets[0]!, cells: [['Name', 'Cost'], ['desk', '100'], ['total', '=B1+B2']] }] };
    expect(sheetDocDigest(doc)).not.toBe(sheetDocDigest(edited));
  });
});
