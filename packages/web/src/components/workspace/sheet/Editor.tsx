'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  FileDown,
  FileSpreadsheet,
  Italic,
  RefreshCw,
  Save,
  Search,
  Wand2,
  Table2,
} from 'lucide-react';
import clsx from 'clsx';
import { t } from '@/i18n/t';
import { useLocale } from '@/hooks/useLocale';
import type { WorkspaceEditorProps } from '../types';
import {
  BORDER_STYLE_KEYS,
  DEFAULT_COLUMN_WIDTH,
  DEFAULT_ROW_HEIGHT,
  addressAt,
  applyStylePatch,
  clearStyleKeys,
  columnLabel,
  countFilledCells,
  displayValue,
  findInSheet,
  loadSheetDoc,
  mergeGeometry,
  normalizeRange,
  parseRangeAddress,
  rangeAddress,
  rangeIndexes,
  rangesOverlap,
  serializeSheetDoc,
  sheetDocDigest,
  sheetDimensions,
  type CellIndex,
  type CellRange,
  type EditorSheet,
  type SheetDoc,
  type SheetStyleValue,
} from './sheetApi';
import { exportWorkspacePdf } from '../pdfExport';
import IntelligencePanel from '../intelligence/IntelligencePanel';
import ConnectionsPanel from '../intelligence/ConnectionsPanel';

interface CellPointer {
  r: number;
  c: number;
}

const LIVE_POLL_MS = 8000;
const ROW_WINDOW = 60;
const COLUMN_WINDOW = 16;
const BORDER_COLOR_DEFAULT = '#000000';

function nextWindow(current: number, needed: number): number {
  return Math.max(current, needed);
}

/** Translate a stored style record into the inline CSS the grid shows. */
function cellStyleFrom(record: Record<string, SheetStyleValue>): React.CSSProperties {
  const style: React.CSSProperties = {};
  if (record.bold === true) style.fontWeight = 'bold';
  if (record.italic === true) style.fontStyle = 'italic';
  if (typeof record.color === 'string') style.color = record.color;
  if (typeof record.background === 'string') style.background = record.background;
  if (record.alignment === 'left' || record.alignment === 'center' || record.alignment === 'right') {
    style.textAlign = record.alignment;
  }
  const sides = [
    ['borderTop', 'borderTopColor'],
    ['borderRight', 'borderRightColor'],
    ['borderBottom', 'borderBottomColor'],
    ['borderLeft', 'borderLeftColor'],
  ] as const;
  for (const [widthKey, colorKey] of sides) {
    const width = record[widthKey];
    if (typeof width !== 'string') continue;
    const color = typeof record[colorKey] === 'string' ? (record[colorKey] as string) : BORDER_COLOR_DEFAULT;
    const borderStyle = width === 'double' ? 'double' : 'solid';
    const borderWidth = width === 'medium' ? '2px' : '1px';
    style[widthKey] = `${borderWidth} ${borderStyle} ${color}`;
  }
  return style;
}

export default function SheetWorkspaceEditor({ file, live, onSave, onChatEdit }: WorkspaceEditorProps) {
  const { dir } = useLocale();
  const [doc, setDoc] = useState<SheetDoc | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [selected, setSelected] = useState<CellPointer>({ r: 0, c: 0 });
  const [editing, setEditing] = useState<CellPointer | null>(null);
  const [editValue, setEditValue] = useState('');
  const [range, setRange] = useState<CellRange | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [renderRows, setRenderRows] = useState(ROW_WINDOW);
  const [renderColumns, setRenderColumns] = useState(COLUMN_WINDOW);
  const [chatInput, setChatInput] = useState('');
  const [findQuery, setFindQuery] = useState('');
  const [findPos, setFindPos] = useState(-1);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  const digestRef = useRef<string>('');
  const dirtyRef = useRef(false);
  const gridRef = useRef<HTMLDivElement | null>(null);

  const activeSheet: EditorSheet | undefined = doc?.sheets[sheetIndex];
  const dims = useMemo(() => (activeSheet ? sheetDimensions(activeSheet) : { rows: 0, columns: 0 }), [activeSheet]);
  const merges = useMemo(() => (activeSheet ? mergeGeometry(activeSheet) : { anchors: new Map(), covered: new Set() }), [activeSheet]);
  const filledCount = useMemo(() => (activeSheet ? countFilledCells(activeSheet) : 0), [activeSheet]);

  const docDigest = useMemo(() => (doc ? sheetDocDigest(doc) : ''), [doc]);
  useEffect(() => {
    digestRef.current = docDigest;
  }, [docDigest]);

  const reload = useCallback(
    async (silent: boolean) => {
      try {
        const next = await loadSheetDoc(file);
        const nextDigest = sheetDocDigest(next);
        if (silent && digestRef.current && nextDigest === digestRef.current) return;
        digestRef.current = nextDigest;
        setDoc(next);
        setDirty(false);
        dirtyRef.current = false;
        setLoadError(null);
        setStale(false);
        setSaveError(null);
        if (!silent) {
          setSheetIndex((index) => Math.min(index, Math.max(next.sheets.length - 1, 0)));
          setSelected({ r: 0, c: 0 });
          setEditing(null);
          setRange(null);
          setRenderRows(ROW_WINDOW);
          setRenderColumns(COLUMN_WINDOW);
        }
      } catch (err) {
        if (!silent) setLoadError(err instanceof Error ? err.message : String(err));
      }
    },
    [file],
  );

  useEffect(() => {
    digestRef.current = '';
    void reload(false);
  }, [file.taskId, file.path, reload]);

  // Live refresh: while the task runs, poll the file; skip reload with unsaved edits
  // and instead offer a manual reload when an external change is detected.
  useEffect(() => {
    if (!live) {
      setStale(false);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      if (cancelled || !digestRef.current) return;
      try {
        const next = await loadSheetDoc(file);
        const changed = sheetDocDigest(next) !== digestRef.current;
        if (!changed) return;
        if (dirtyRef.current) setStale(true);
        else await reload(true);
      } catch {
        /* transient errors during a run are ignored */
      }
    };
    const interval = setInterval(() => void poll(), LIVE_POLL_MS);
    void poll();
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [live, file, reload]);

  const markDirty = () => {
    setDirty(true);
    dirtyRef.current = true;
    setStale(false);
  };

  const cellValue = useCallback(
    (r: number, c: number): string => activeSheet?.cells[r]?.[c] ?? '',
    [activeSheet],
  );

  const beginEdit = useCallback(
    (pointer: CellPointer, seed?: string) => {
      setSelected(pointer);
      setEditing(pointer);
      setEditValue(seed ?? cellValue(pointer.r, pointer.c));
    },
    [cellValue],
  );

  const setCell = useCallback(
    (r: number, c: number, value: string) => {
      setDoc((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          sheets: prev.sheets.map((sheet, i) => {
            if (i !== sheetIndex) return sheet;
            const cells = sheet.cells.map((row) => [...row]);
            while (cells.length <= r) cells.push([]);
            while (cells[r]!.length <= c) cells[r]!.push('');
            cells[r]![c] = value;
            return { ...sheet, cells };
          }),
        };
      });
      markDirty();
    },
    [sheetIndex],
  );

  const updateActiveSheet = useCallback(
    (updater: (sheet: EditorSheet) => EditorSheet) => {
      setDoc((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          sheets: prev.sheets.map((sheet, i) => (i === sheetIndex ? updater(sheet) : sheet)),
        };
      });
      markDirty();
    },
    [sheetIndex],
  );

  const commitEdit = useCallback(
    (move?: 'down' | 'right') => {
      if (!editing || !doc) return;
      const source = cellValue(editing.r, editing.c);
      if (editValue !== source) setCell(editing.r, editing.c, editValue);
      setEditing(null);
      setRenderRows((w) => nextWindow(w, editing.r + 1));
      setRenderColumns((w) => nextWindow(w, editing.c + 1));
      if (move === 'down') setSelected({ r: Math.max(0, editing.r + 1), c: editing.c });
      else if (move === 'right') setSelected({ r: editing.r, c: Math.max(0, editing.c + 1) });
    },
    [editing, doc, cellValue, editValue, setCell],
  );

  const cancelEdit = useCallback(() => setEditing(null), []);

  const selectCell = useCallback(
    (pointer: CellPointer) => {
      setSelected(pointer);
      setRange(null);
      setRenderRows((w) => nextWindow(w, pointer.r + 1));
      setRenderColumns((w) => nextWindow(w, pointer.c + 1));
    },
    [],
  );

  /* --- formatting toolbar targets -------------------------------------- */

  const targetAddresses = useMemo(() => {
    if (!activeSheet) return [] as string[];
    if (range) return rangeIndexes(range).map(({ r, c }) => addressAt(r, c));
    return [addressAt(selected.r, selected.c)];
  }, [activeSheet, range, selected]);

  const targetStyle = targetAddresses.length ? activeSheet?.styles[targetAddresses[0]!] : undefined;

  const mutateStyles = useCallback(
    (updater: (styles: EditorSheet['styles']) => EditorSheet['styles']) => {
      if (!targetAddresses.length) return;
      updateActiveSheet((sheet) => ({ ...sheet, styles: updater(sheet.styles) }));
    },
    [targetAddresses, updateActiveSheet],
  );

  const applyStyleToTargets = useCallback(
    (patch: Record<string, SheetStyleValue>) => mutateStyles((styles) => applyStylePatch(styles, targetAddresses, patch)),
    [mutateStyles, targetAddresses],
  );

  const clearStyleFromTargets = useCallback(
    (keys: readonly string[]) => mutateStyles((styles) => clearStyleKeys(styles, targetAddresses, keys)),
    [mutateStyles, targetAddresses],
  );

  const toggleStyleFlag = (key: 'bold' | 'italic') => {
    if (targetStyle?.[key] === true) clearStyleFromTargets([key]);
    else applyStyleToTargets({ [key]: true });
  };

  const toggleBorders = () => {
    if (typeof targetStyle?.borderTop === 'string') clearStyleFromTargets(BORDER_STYLE_KEYS);
    else
      applyStyleToTargets({
        borderTop: 'thin',
        borderLeft: 'thin',
        borderRight: 'thin',
        borderBottom: 'thin',
        borderTopColor: BORDER_COLOR_DEFAULT,
        borderLeftColor: BORDER_COLOR_DEFAULT,
        borderRightColor: BORDER_COLOR_DEFAULT,
        borderBottomColor: BORDER_COLOR_DEFAULT,
      });
  };

  /* --- merge / unmerge --------------------------------------------------- */

  const selectionRange: CellRange | null = range ?? { r1: selected.r, c1: selected.c, r2: selected.r, c2: selected.c };
  const canMerge = !!range && (range.r2 > range.r1 || range.c2 > range.c1);
  const overlappingMerges = useMemo(() => {
    if (!activeSheet || !selectionRange) return [] as string[];
    return activeSheet.merges.filter((merge) => {
      const parsed = parseRangeAddress(merge);
      return !!parsed && rangesOverlap(parsed, selectionRange);
    });
  }, [activeSheet, selectionRange]);

  const mergeSelection = useCallback(() => {
    if (!range || !canMerge) return;
    const address = rangeAddress(range);
    updateActiveSheet((sheet) => {
      // The server keeps a merge only when every non-anchor cell is empty,
      // so clear their text exactly like the studio grid does.
      const cells = sheet.cells.map((row) => [...row]);
      while (cells.length <= range.r2) cells.push([]);
      for (const { r, c } of rangeIndexes(range)) {
        while (cells[r]!.length <= range.c2) cells[r]!.push('');
        if (r === range.r1 && c === range.c1) continue;
        cells[r]![c] = '';
      }
      return { ...sheet, cells, merges: sheet.merges.includes(address) ? sheet.merges : [...sheet.merges, address] };
    });
  }, [range, canMerge, updateActiveSheet]);

  const unmergeSelection = useCallback(() => {
    if (!activeSheet || !overlappingMerges.length) return;
    const drop = new Set(overlappingMerges);
    updateActiveSheet((sheet) => ({ ...sheet, merges: sheet.merges.filter((merge) => !drop.has(merge)) }));
  }, [activeSheet, overlappingMerges, updateActiveSheet]);

  /* --- find --------------------------------------------------------------- */

  const findMatches = useMemo(() => (activeSheet ? findInSheet(activeSheet, findQuery) : []), [activeSheet, findQuery]);
  const activeMatch: CellIndex | null = findPos >= 0 && findPos < findMatches.length ? findMatches[findPos]! : null;

  const findNext = useCallback(() => {
    if (!findMatches.length) {
      setFindPos(-1);
      return;
    }
    const next = (findPos + 1) % findMatches.length;
    setFindPos(next);
    selectCell(findMatches[next]!);
  }, [findMatches, findPos, selectCell]);

  /* --- rows / columns / save --------------------------------------------- */

  const addRow = useCallback(() => {
    setDoc((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        sheets: prev.sheets.map((sheet, i) => {
          if (i !== sheetIndex) return sheet;
          const width = sheet.cells.reduce((max, row) => Math.max(max, row.length), 0);
          return {
            ...sheet,
            cells: [...sheet.cells, new Array(width).fill('')],
            rowHeights: [...sheet.rowHeights, DEFAULT_ROW_HEIGHT],
            hiddenRows: [...sheet.hiddenRows, false],
          };
        }),
      };
    });
    markDirty();
  }, [sheetIndex]);

  const addColumn = useCallback(() => {
    setDoc((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        sheets: prev.sheets.map((sheet, i) => {
          if (i !== sheetIndex) return sheet;
          return {
            ...sheet,
            cells: sheet.cells.map((row) => [...row, '']),
            columnWidths: [...sheet.columnWidths, DEFAULT_COLUMN_WIDTH],
            hiddenColumns: [...sheet.hiddenColumns, false],
          };
        }),
      };
    });
    markDirty();
  }, [sheetIndex]);

  const handleSave = useCallback(async () => {
    if (!doc || saving) return;
    cancelEdit();
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(serializeSheetDoc(doc));
      setDirty(false);
      dirtyRef.current = false;
      setStale(false);
      // Pull the saved file back so freshly computed `values` arrive.
      await reload(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [doc, saving, cancelEdit, onSave, reload]);

  const exportPdf = useCallback(async () => {
    if (pdfBusy) return;
    setPdfBusy(true);
    setPdfError(null);
    try {
      const result = await exportWorkspacePdf('sheet', file.taskId, file.path);
      if (!result.ok) setPdfError(result.error);
    } finally {
      setPdfBusy(false);
    }
  }, [pdfBusy, file.taskId, file.path]);

  // Ctrl/Cmd+S saves like a desktop spreadsheet.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleSave]);

  const submitChatEdit = useCallback(() => {
    const instruction = chatInput.trim();
    if (!instruction) return;
    onChatEdit(instruction);
    setStale(false);
    setChatInput('');
  }, [chatInput, onChatEdit]);

  const gridKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (editing) return;
      if (event.key === 'Escape' && range) {
        event.preventDefault();
        setRange(null);
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const deltas: Record<string, CellPointer> = {
        ArrowUp: { r: -1, c: 0 },
        ArrowDown: { r: 1, c: 0 },
        ArrowLeft: { r: 0, c: -1 },
        ArrowRight: { r: 0, c: 1 },
      };
      if (deltas[event.key]) {
        event.preventDefault();
        const delta = deltas[event.key]!;
        setRange(null);
        setSelected((prev) => ({
          r: Math.min(dims.rows - 1 || 0, Math.max(0, prev.r + delta.r)),
          c: Math.min(dims.columns - 1 || 0, Math.max(0, prev.c + delta.c)),
        }));
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        setRange(null);
        setSelected((prev) => ({ ...prev, c: Math.min(dims.columns - 1 || 0, prev.c + 1) }));
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        beginEdit(selected);
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        setCell(selected.r, selected.c, '');
        return;
      }
      if (event.key.length === 1 && dims.rows > 0) {
        event.preventDefault();
        beginEdit({ r: selected.r, c: selected.c }, event.key);
      }
    },
    [editing, range, dims, selected, beginEdit, setCell],
  );

  const rowsToRender = Math.min(Math.max(renderRows, 1), dims.rows);
  const columnsToRender = Math.min(Math.max(renderColumns, 1), dims.columns);
  const visibleRows = rowsToRender || 1;
  const visibleColumns = columnsToRender || 1;
  const rowIndexes = Array.from({ length: visibleRows }, (_, i) => i);
  const columnIndexes = Array.from({ length: visibleColumns }, (_, i) => i);

  if (loadError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" dir={dir}>
        <FileSpreadsheet className="size-8 text-text-tertiary" aria-hidden />
        <p className="text-sm text-text-secondary">{t('Could not load the spreadsheet.')}</p>
        <p className="max-w-md text-xs text-text-tertiary">{loadError}</p>
        <button type="button" onClick={() => void reload(false)} className="rounded-control border border-border-main px-3 py-1.5 text-sm hover:bg-fill-hover">
          {t('Retry')}
        </button>
      </div>
    );
  }

  if (!doc || !activeSheet) {
    return (
      <div className="flex h-full items-center justify-center p-6" dir={dir}>
        <RefreshCw className="size-5 animate-spin text-text-tertiary" aria-hidden />
      </div>
    );
  }

  const currentNumberFormat = typeof targetStyle?.numberFormat === 'string' ? targetStyle.numberFormat : '';

  return (
    <div className="flex h-full flex-col bg-bg-menu text-text-primary" dir={dir}>
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border-main px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Table2 className="size-4 shrink-0 text-text-secondary" aria-hidden />
          <span className="truncate text-sm font-medium" title={file.path}>{file.name}</span>
          {dirty && !stale && <span className="size-1.5 shrink-0 rounded-full bg-func-warning" aria-label={t('Unsaved changes')} />}
          {stale && <span className="truncate text-xs text-func-warning">{t('The file changed while you edit — reload to pick it up.')}</span>}
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => void exportPdf()} disabled={pdfBusy} data-testid="sheet-export-pdf"
            className="flex items-center gap-1.5 rounded-control px-2.5 py-1.5 text-sm hover:bg-fill-hover disabled:opacity-40"
            title={t('Export the sheet as PDF')}>
            <FileDown className="size-4" aria-hidden />
            {pdfBusy ? t('Exporting…') : t('Export PDF')}
          </button>
          <button type="button" onClick={() => void reload(false)} className="rounded-control p-1.5 hover:bg-fill-hover" title={t('Reload')}>
            <RefreshCw className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className={clsx(
              'flex items-center gap-1.5 rounded-control px-2.5 py-1.5 text-sm',
              dirty ? 'bg-[var(--text-primary)] text-bg-main hover:opacity-90' : 'text-text-tertiary',
            )}
            title="Ctrl+S"
          >
            <Save className="size-4" aria-hidden />
            {saving ? t('Saving…') : dirty ? t('Save') : t('Saved')}
          </button>
        </div>
        {(saveError || pdfError) && (
          <p className="w-full truncate text-xs text-func-error" data-testid="sheet-notice">
            {saveError ? `${t('Save failed')}: ${saveError}` : pdfError}
          </p>
        )}
      </div>

      {/* formula bar + add row/column */}
      <div className="flex items-center gap-2 border-b border-border-main px-3 py-1.5">
        <div className="flex items-center gap-1.5">
          <span className="min-w-14 rounded-row bg-fill-hover px-2 py-0.5 text-center text-xs text-text-secondary">
            {dims.rows > 0 ? addressAt(selected.r, selected.c) : '-'}
          </span>
          <span className="select-none text-xs text-text-tertiary" title={t('Formula or value')}>fx</span>
        </div>
        <input
          type="text"
          dir="auto"
          spellCheck={false}
          value={editing ? editValue : cellValue(selected.r, selected.c)}
          onChange={(event) => {
            if (!editing) beginEdit(selected, event.target.value);
            else setEditValue(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitEdit('down');
            } else if (event.key === 'Escape') cancelEdit();
            else if (event.key === 'Tab') {
              event.preventDefault();
              commitEdit('right');
            }
          }}
          onBlur={() => commitEdit()}
          className="min-w-0 flex-1 rounded-row bg-bg-main px-2 py-1 text-sm outline-none ring-border-main focus:ring-1"
          placeholder={t('Value or =formula')}
        />
        <button type="button" onClick={addRow} className="whitespace-nowrap rounded-control px-2 py-1 text-xs hover:bg-fill-hover" title={t('Append a row at the end')}>
          + {t('Row')}
        </button>
        <button type="button" onClick={addColumn} className="whitespace-nowrap rounded-control px-2 py-1 text-xs hover:bg-fill-hover" title={t('Append a column at the end')}>
          + {t('Column')}
        </button>
      </div>

      {/* formatting toolbar + find */}
      <div className="flex flex-wrap items-center gap-1 border-b border-border-main px-3 py-1" role="toolbar" aria-label={t('Formatting')}>
        <button
          type="button"
          data-testid="sheet-toolbar-bold"
          aria-label={t('Bold')}
          aria-pressed={targetStyle?.bold === true}
          onClick={() => toggleStyleFlag('bold')}
          className={clsx('rounded-control p-1.5 hover:bg-fill-hover', targetStyle?.bold === true && 'bg-fill-hover')}
        >
          <Bold className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          data-testid="sheet-toolbar-italic"
          aria-label={t('Italic')}
          aria-pressed={targetStyle?.italic === true}
          onClick={() => toggleStyleFlag('italic')}
          className={clsx('rounded-control p-1.5 hover:bg-fill-hover', targetStyle?.italic === true && 'bg-fill-hover')}
        >
          <Italic className="size-3.5" aria-hidden />
        </button>
        <span className="mx-0.5 h-4 w-px bg-border-light" aria-hidden />
        <input
          type="color"
          data-testid="sheet-toolbar-color"
          aria-label={t('Text color')}
          title={t('Text color')}
          defaultValue="#111827"
          onChange={(event) => applyStyleToTargets({ color: event.target.value })}
          className="size-5 cursor-pointer rounded-control border border-border-light bg-transparent p-0"
        />
        <input
          type="color"
          data-testid="sheet-toolbar-fill"
          aria-label={t('Fill color')}
          title={t('Fill color')}
          defaultValue="#ffffff"
          onChange={(event) => applyStyleToTargets({ background: event.target.value })}
          className="size-5 cursor-pointer rounded-control border border-border-light bg-transparent p-0"
        />
        <span className="mx-0.5 h-4 w-px bg-border-light" aria-hidden />
        {([
          ['left', AlignLeft, t('Align left')],
          ['center', AlignCenter, t('Align center')],
          ['right', AlignRight, t('Align right')],
        ] as const).map(([value, Icon, label]) => (
          <button
            key={value}
            type="button"
            data-testid={`sheet-toolbar-align-${value}`}
            aria-label={label}
            aria-pressed={targetStyle?.alignment === value}
            onClick={() => applyStyleToTargets({ alignment: value })}
            className={clsx('rounded-control p-1.5 hover:bg-fill-hover', targetStyle?.alignment === value && 'bg-fill-hover')}
          >
            <Icon className="size-3.5" aria-hidden />
          </button>
        ))}
        <span className="mx-0.5 h-4 w-px bg-border-light" aria-hidden />
        <select
          data-testid="sheet-toolbar-number-format"
          aria-label={t('Number format')}
          title={t('Number format')}
          value={currentNumberFormat}
          onChange={(event) => {
            const value = event.target.value;
            if (value) applyStyleToTargets({ numberFormat: value });
            else clearStyleFromTargets(['numberFormat']);
          }}
          className="rounded-control border border-border-light bg-bg-main px-1 py-1 text-xs"
        >
          <option value="">{t('General')}</option>
          <option value="0.00">0.00</option>
          <option value="0%">0%</option>
          <option value="yyyy-mm-dd">yyyy-mm-dd</option>
          <option value="#,##0">#,##0</option>
        </select>
        <button
          type="button"
          data-testid="sheet-toolbar-border"
          aria-pressed={typeof targetStyle?.borderTop === 'string'}
          onClick={toggleBorders}
          className={clsx(
            'whitespace-nowrap rounded-control px-1.5 py-1 text-xs hover:bg-fill-hover',
            typeof targetStyle?.borderTop === 'string' && 'bg-fill-hover',
          )}
          title={t('Toggle thin borders on all four sides')}
        >
          {t('Borders')}
        </button>
        <span className="mx-0.5 h-4 w-px bg-border-light" aria-hidden />
        <button
          type="button"
          data-testid="sheet-toolbar-merge"
          onClick={mergeSelection}
          disabled={!canMerge}
          className="whitespace-nowrap rounded-control px-1.5 py-1 text-xs hover:bg-fill-hover disabled:opacity-40"
          title={t('Merge the selected range (keeps the top-left value)')}
        >
          {t('Merge')}
        </button>
        <button
          type="button"
          data-testid="sheet-toolbar-unmerge"
          onClick={unmergeSelection}
          disabled={!overlappingMerges.length}
          className="whitespace-nowrap rounded-control px-1.5 py-1 text-xs hover:bg-fill-hover disabled:opacity-40"
          title={t('Remove merged ranges under the selection')}
        >
          {t('Unmerge')}
        </button>
        {range && (
          <span className="ml-1 rounded-row bg-fill-hover px-1.5 py-0.5 font-mono text-[11px] text-text-secondary">
            {rangeAddress(range)}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Search className="size-3.5 text-text-tertiary" aria-hidden />
          <input
            type="text"
            dir="auto"
            data-testid="sheet-find"
            value={findQuery}
            onChange={(event) => {
              setFindQuery(event.target.value);
              setFindPos(-1);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                findNext();
              }
            }}
            placeholder={t('Find in sheet')}
            className="w-28 rounded-control bg-bg-main px-1.5 py-1 text-xs outline-none ring-border-main focus:ring-1"
          />
          {findQuery.trim() !== '' && (
            <span data-testid="sheet-find-count" className="whitespace-nowrap text-xs text-text-tertiary">
              {activeMatch ? `${findPos + 1}/${findMatches.length}` : `0/${findMatches.length}`}
            </span>
          )}
        </div>
      </div>

      {/* note area: charts and other CSVs of state from the loader */}
      {doc.notes.length > 0 && (
        <div className="border-b border-border-main bg-fill-hover/60 px-3 py-1.5">
          {doc.notes.map((note, i) => (
            <p key={i} className="text-xs text-text-secondary" role="note">
              {note}
            </p>
          ))}
        </div>
      )}

      {/* sheet tabs */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-border-main px-3 py-1" role="tablist" aria-label={t('Sheets')}>
        {doc.sheets.map((sheet, index) => (
          <button
            key={index}
            type="button"
            role="tab"
            aria-selected={index === sheetIndex}
            onClick={() => {
              setSheetIndex(index);
              selectCell({ r: 0, c: 0 });
            }}
            className={clsx(
              'shrink-0 rounded-row px-2.5 py-1 text-xs',
              index === sheetIndex ? 'bg-fill-hover font-medium' : 'text-text-secondary hover:bg-fill-hover',
            )}
          >
            {sheet.name || t('Sheet')}
          </button>
        ))}
      </div>

      {/* grid */}
      <div
        ref={gridRef}
        tabIndex={0}
        onKeyDown={gridKeyDown}
        className="flex-1 overflow-auto outline-none"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) gridRef.current?.focus();
        }}
      >
        {dims.rows === 0 ? (
          <div className="p-6 text-sm text-text-tertiary">
            {t('This sheet is empty. Type a value or use + Row to begin.')}
          </div>
        ) : (
          <table className="border-collapse text-sm" style={{ minWidth: 'max-content' }}>
            <thead>
              <tr>
                <th className="sticky start-0 top-0 z-10 min-w-9 border border-border-light bg-bg-menu text-center text-xs font-normal text-text-tertiary" />
                {columnIndexes.map((c) => (
                  <th
                    key={c}
                    className={clsx(
                      'sticky top-0 z-[5] min-w-24 border border-border-light bg-bg-menu px-2 py-1 text-xs font-normal text-text-tertiary',
                      selected.c === c && 'bg-fill-hover font-medium text-text-secondary',
                    )}
                    onMouseDown={() => selectCell({ r: selected.r, c })}
                  >
                    {columnLabel(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rowIndexes.map((r) => (
                <tr key={r}>
                  <th
                    className={clsx(
                      'sticky start-0 z-[5] min-w-9 border border-border-light bg-bg-menu px-1 text-center text-xs font-normal text-text-tertiary',
                      selected.r === r && 'bg-fill-hover font-medium text-text-secondary',
                    )}
                    onMouseDown={() => selectCell({ r, c: selected.c })}
                  >
                    {r + 1}
                  </th>
                  {columnIndexes.map((c) => {
                    const key = `${r},${c}`;
                    if (merges.covered.has(key)) return null;
                    const span = merges.anchors.get(key);
                    const isEditing = !!editing && editing.r === r && editing.c === c;
                    const isFocused = selected.r === r && selected.c === c;
                    const inRange = !!range && r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2;
                    const isMatch = !!activeMatch && activeMatch.r === r && activeMatch.c === c;
                    const styleRecord = activeSheet.styles[addressAt(r, c)];
                    const shown = isFocused ? cellValue(r, c) : displayValue(activeSheet, r, c);
                    return (
                      <td
                        key={c}
                        data-cell={key}
                        rowSpan={span?.rowSpan}
                        colSpan={span?.colSpan}
                        className={clsx(
                          'm-0 border border-border-light px-1 py-0 align-top',
                          isMatch
                            ? 'ring-2 ring-inset ring-func-warning'
                            : isFocused
                              ? 'ring-1 ring-inset ring-[var(--text-primary)]'
                              : inRange
                                ? 'bg-fill-hover/50 ring-1 ring-inset ring-[var(--text-secondary)]'
                                : 'hover:bg-fill-hover/50',
                        )}
                        style={{ minWidth: DEFAULT_COLUMN_WIDTH * 6, ...(styleRecord ? cellStyleFrom(styleRecord) : undefined) }}
                        onMouseDown={(event) => {
                          gridRef.current?.focus();
                          if (event.shiftKey) {
                            setRange(normalizeRange(selected, { r, c }));
                            return;
                          }
                          if (isFocused) beginEdit({ r, c });
                          else selectCell({ r, c });
                        }}
                        onDoubleClick={() => beginEdit({ r, c })}
                      >
                        {isEditing ? (
                          <input
                            autoFocus
                            dir="auto"
                            spellCheck={false}
                            value={editValue}
                            onChange={(event) => setEditValue(event.target.value)}
                            onBlur={() => commitEdit()}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                commitEdit('down');
                              } else if (event.key === 'Escape') {
                                event.preventDefault();
                                event.stopPropagation();
                                cancelEdit();
                              } else if (event.key === 'Tab') {
                                event.preventDefault();
                                commitEdit('right');
                              }
                            }}
                            className="w-full min-w-16 bg-bg-main px-0.5 py-0.5 text-sm outline-none"
                          />
                        ) : (
                          <div className="min-w-16 overflow-hidden whitespace-pre-wrap break-words py-0.5" title={shown}>
                            {shown}
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <IntelligencePanel file={file} applyDisabled={dirty} onApplied={() => { void reload(false); }} />
      <ConnectionsPanel file={file} onSynced={() => { void reload(false); }} />
      {/* window extensions + chat edit */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border-main px-3 py-2">
        <span data-testid="sheet-word-count" className="whitespace-nowrap text-xs text-text-tertiary">
          {t('Filled cells: {count}', { count: filledCount })}
        </span>
        {dims.rows > visibleRows || dims.columns > visibleColumns ? (
          <div className="flex items-center gap-1.5">
            {dims.rows > visibleRows && (
              <button type="button" onClick={() => setRenderRows((w) => w + 100)} className="rounded-control px-2 py-1 text-xs hover:bg-fill-hover">
                {t('Show more rows')} ({dims.rows - visibleRows})
              </button>
            )}
            {dims.columns > visibleColumns && (
              <button type="button" onClick={() => setRenderColumns((w) => w + 16)} className="rounded-control px-2 py-1 text-xs hover:bg-fill-hover">
                {t('Show more columns')} ({dims.columns - visibleColumns})
              </button>
            )}
          </div>
        ) : null}
        <div className="ml-auto flex min-w-56 flex-1 items-center gap-1.5">
          <Wand2 className="size-4 shrink-0 text-text-tertiary" aria-hidden />
          <input
            type="text"
            dir="auto"
            value={chatInput}
            onChange={(event) => setChatInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submitChatEdit();
            }}
            placeholder={live ? t('Ask the running agent to edit this file') : t('Ask an agent edit to be applied via chat')}
            className="min-w-0 flex-1 rounded-control bg-bg-main px-2 py-1 text-sm outline-none ring-border-main focus:ring-1"
          />
          <button
            type="button"
            onClick={submitChatEdit}
            disabled={!chatInput.trim()}
            className="rounded-control border border-border-main px-2.5 py-1 text-sm hover:bg-fill-hover disabled:opacity-40"
            title={t('Send the edit request to the task chat')}
          >
            {t('AI edit')}
          </button>
        </div>
      </div>
    </div>
  );
}

// Stub created by the workspace shell; replaced by the sheet editor session.
export function SheetEditorStub({ file }: WorkspaceEditorProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <Table2 className="size-8 text-text-quaternary" />
      <p className="text-sm text-text-tertiary">Preview not available yet</p>
      <p className="max-w-full truncate font-mono text-xs text-text-quaternary">{file.path}</p>
    </div>
  );
}
