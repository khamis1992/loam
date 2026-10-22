'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileSpreadsheet, RefreshCw, Save, Sparkles, Table2 } from 'lucide-react';
import clsx from 'clsx';
import { t } from '@/i18n/t';
import type { WorkspaceEditorProps } from '../types';
import {
  DEFAULT_COLUMN_WIDTH,
  DEFAULT_ROW_HEIGHT,
  addressAt,
  columnLabel,
  loadSheetDoc,
  serializeSheetDoc,
  sheetDocDigest,
  sheetDimensions,
  type EditorSheet,
  type SheetDoc,
} from './sheetApi';

interface CellPointer {
  r: number;
  c: number;
}

const LIVE_POLL_MS = 8000;
const ROW_WINDOW = 60;
const COLUMN_WINDOW = 16;

function nextWindow(current: number, needed: number): number {
  return Math.max(current, needed);
}

export default function SheetWorkspaceEditor({ file, live, onSave, onChatEdit }: WorkspaceEditorProps) {
  const [doc, setDoc] = useState<SheetDoc | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [selected, setSelected] = useState<CellPointer>({ r: 0, c: 0 });
  const [editing, setEditing] = useState<CellPointer | null>(null);
  const [editValue, setEditValue] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [renderRows, setRenderRows] = useState(ROW_WINDOW);
  const [renderColumns, setRenderColumns] = useState(COLUMN_WINDOW);
  const [chatInput, setChatInput] = useState('');

  const digestRef = useRef<string>('');
  const dirtyRef = useRef(false);
  const gridRef = useRef<HTMLDivElement | null>(null);

  const activeSheet: EditorSheet | undefined = doc?.sheets[sheetIndex];
  const dims = useMemo(() => (activeSheet ? sheetDimensions(activeSheet) : { rows: 0, columns: 0 }), [activeSheet]);

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
      setRenderRows((w) => nextWindow(w, pointer.r + 1));
      setRenderColumns((w) => nextWindow(w, pointer.c + 1));
    },
    [],
  );

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
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [doc, saving, cancelEdit, onSave]);

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
        setSelected((prev) => ({
          r: Math.min(dims.rows - 1 || 0, Math.max(0, prev.r + delta.r)),
          c: Math.min(dims.columns - 1 || 0, Math.max(0, prev.c + delta.c)),
        }));
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
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
    [editing, dims, selected, beginEdit, setCell],
  );

  const rowsToRender = Math.min(Math.max(renderRows, 1), dims.rows);
  const columnsToRender = Math.min(Math.max(renderColumns, 1), dims.columns);
  const visibleRows = rowsToRender || 1;
  const visibleColumns = columnsToRender || 1;
  const rowIndexes = Array.from({ length: visibleRows }, (_, i) => i);
  const columnIndexes = Array.from({ length: visibleColumns }, (_, i) => i);

  if (loadError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" dir="ltr">
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
      <div className="flex h-full items-center justify-center p-6" dir="ltr">
        <RefreshCw className="size-5 animate-spin text-text-tertiary" aria-hidden />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-bg-menu text-text-primary" dir="ltr">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border-main px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Table2 className="size-4 shrink-0 text-text-secondary" aria-hidden />
          <span className="truncate text-sm font-medium" title={file.path}>{file.name}</span>
          {dirty && !stale && <span className="size-1.5 shrink-0 rounded-full bg-func-warning" aria-label={t('Unsaved changes')} />}
          {stale && <span className="truncate text-xs text-func-warning">{t('The file changed while you edit — reload to pick it up.')}</span>}
        </div>
        <div className="flex items-center gap-1.5">
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
        {saveError && <p className="w-full truncate text-xs text-func-error">{t('Save failed') + ': ' + saveError}</p>}
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
          dir="ltr"
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
                <th className="sticky left-0 top-0 z-10 min-w-9 border border-border-light bg-bg-menu text-center text-xs font-normal text-text-tertiary" />
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
                      'sticky left-0 z-[5] min-w-9 border border-border-light bg-bg-menu px-1 text-center text-xs font-normal text-text-tertiary',
                      selected.r === r && 'bg-fill-hover font-medium text-text-secondary',
                    )}
                    onMouseDown={() => selectCell({ r, c: selected.c })}
                  >
                    {r + 1}
                  </th>
                  {columnIndexes.map((c) => {
                    const isEditing = !!editing && editing.r === r && editing.c === c;
                    return (
                      <td
                        key={c}
                        className={clsx(
                          'm-0 border border-border-light px-1 py-0 align-top',
                          selected.r === r && selected.c === c
                            ? 'ring-1 ring-inset ring-[var(--text-primary)]'
                            : 'hover:bg-fill-hover/50',
                        )}
                        style={{ minWidth: DEFAULT_COLUMN_WIDTH * 6 }}
                        onMouseDown={() => {
                          gridRef.current?.focus();
                          if (selected.r === r && selected.c === c) beginEdit({ r, c });
                          else selectCell({ r, c });
                        }}
                        onDoubleClick={() => beginEdit({ r, c })}
                      >
                        {isEditing ? (
                          <input
                            autoFocus
                            dir="ltr"
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
                          <div className="min-w-16 overflow-hidden whitespace-pre-wrap break-words py-0.5" title={cellValue(r, c)}>
                            {cellValue(r, c)}
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

      {/* window extensions + chat edit */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border-main px-3 py-2">
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
          <Sparkles className="size-4 shrink-0 text-text-tertiary" aria-hidden />
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