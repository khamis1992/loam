import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Editor from '../Editor';
import type { WorkspaceEditorProps, WorkspaceFile } from '../../types';

/** Wave G tools on the sheet editor: computed-value display, the formatting
 * toolbar (styles model), shift+click ranges with merge/unmerge, find,
 * RTL direction, PDF export, and the filled-cells counter.
 * Network access is stubbed per test with `vi.stubGlobal('fetch', …)`; the
 * default locale is English, so `t()` falls back to the English key text. */

const pdfMock = vi.hoisted(() => vi.fn());
vi.mock('../../pdfExport', () => ({ exportWorkspacePdf: pdfMock }));

const localeState = vi.hoisted(() => ({ isRtl: false, dir: 'ltr' as 'ltr' | 'rtl' }));
vi.mock('@/hooks/useLocale', () => ({
  useLocale: () => ({
    locale: localeState.isRtl ? 'ar' : 'en',
    isRtl: localeState.isRtl,
    dir: localeState.dir,
    setLocale: () => {},
    product: 'Loam',
  }),
}));

type StyleRecord = Record<string, string | number | boolean>;

interface TestSheet {
  name: string;
  cells: string[][];
  values?: string[][];
  styles: Record<string, StyleRecord>;
  columnWidths: number[];
  rowHeights: number[];
  merges: string[];
  hiddenRows: boolean[];
  hiddenColumns: boolean[];
}

interface TestDoc {
  taskId: string;
  path: string;
  name: string;
  sheets: TestSheet[];
  notes: string[];
}

const file: WorkspaceFile = { taskId: 'task_1', path: 'case/budget.xlsx', name: 'budget.xlsx', kind: 'sheet' };

/** 3x2 sheet: B3 holds a formula whose computed value is "5"; "hello" appears
 * twice (A2 raw text, A3 raw text) so find has multiple matches. */
const baseDoc = (): TestDoc => ({
  taskId: 'task_1',
  path: 'case/budget.xlsx',
  name: 'budget.xlsx',
  sheets: [
    {
      name: 'Budget',
      cells: [
        ['Item', '2'],
        ['hello desk', '3'],
        ['hello again', '=B1+B2'],
      ],
      values: [
        ['Item', '2'],
        ['hello desk', '3'],
        ['hello again', '5'],
      ],
      styles: {},
      columnWidths: [12, 9],
      rowHeights: [20, 20, 20],
      merges: [],
      hiddenRows: [false, false, false],
      hiddenColumns: [false, false],
    },
  ],
  notes: [],
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Serves the sheet GET and lets tests advance the served document through the
 * onSave payload, mimicking the save → reload round trip. */
function installSheetServer(initial: TestDoc) {
  let latest = initial;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/api/workspace/sheet/file') && method === 'GET') return json(latest);
    throw new Error(`unexpected fetch ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const onSave = vi.fn(async (payload: string | Blob) => {
    const parsed = JSON.parse(payload as string) as { sheets: TestSheet[]; notes?: string[] };
    latest = { ...latest, sheets: parsed.sheets, notes: parsed.notes ?? [] };
  });
  return { fetchMock, onSave, servedDoc: () => latest };
}

function propsFor(overrides: Partial<WorkspaceEditorProps> = {}): WorkspaceEditorProps {
  return { file, live: false, onSave: vi.fn(async () => {}), onChatEdit: () => {}, ...overrides };
}

const savedSheet = (onSave: ReturnType<typeof installSheetServer>['onSave'], call = -1): TestSheet =>
  (JSON.parse(onSave.mock.calls.at(call)![0] as string) as { sheets: TestSheet[] }).sheets[0]!;

describe('sheet Editor tools', () => {
  beforeEach(() => {
    pdfMock.mockReset();
    localeState.isRtl = false;
    localeState.dir = 'ltr';
    // Every test loads a sheet over the (stubbed) network; tests override with installSheetServer.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/api/workspace/sheet/file') && (init?.method ?? 'GET') === 'GET') return json(baseDoc());
        throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows computed values while the focused cell and formula bar keep the raw text', async () => {
    const view = render(<Editor {...propsFor()} />);
    await screen.findByText('hello desk');
    const cell = (id: string) => view.container.querySelector(`[data-cell="${id}"]`)!;
    const formulaBar = screen.getByPlaceholderText('Value or =formula') as HTMLInputElement;

    // Not focused: the formula cell shows its computed value, others their text.
    expect(cell('2,1')!.textContent).toBe('5');
    expect(cell('1,1')!.textContent).toBe('3');
    // Focused A1 keeps the raw cells text, and so does the formula bar.
    expect(cell('0,0')!.textContent).toBe('Item');
    expect(formulaBar.value).toBe('Item');

    // Focusing the formula cell switches its display to the raw formula.
    fireEvent.mouseDown(cell('2,1')!);
    await waitFor(() => expect(formulaBar.value).toBe('=B1+B2'));
    expect(cell('2,1')!.textContent).toBe('=B1+B2');
  });

  it('editing seeds the raw formula and the commit writes back to cells', async () => {
    const { onSave } = installSheetServer(baseDoc());
    const view = render(<Editor {...propsFor({ onSave })} />);
    await screen.findByText('hello desk');

    fireEvent.mouseDown(view.container.querySelector('[data-cell="2,1"]')!);
    fireEvent.doubleClick(view.container.querySelector('[data-cell="2,1"]')!);
    const input = view.container.querySelector('[data-cell="2,1"] input') as HTMLInputElement;
    expect(input.value).toBe('=B1+B2');

    fireEvent.change(input, { target: { value: '=SUM(B1:B2)' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(savedSheet(onSave).cells[2]![1]).toBe('=SUM(B1:B2)');
  });

  it('toolbar bold writes the style for the selected cell and clears on the next click', async () => {
    const { onSave } = installSheetServer(baseDoc());
    const view = render(<Editor {...propsFor({ onSave })} />);
    await screen.findByText('hello desk');

    fireEvent.mouseDown(view.container.querySelector('[data-cell="1,1"]')!);
    fireEvent.click(screen.getByTestId('sheet-toolbar-bold'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(savedSheet(onSave).styles.B2).toEqual({ bold: true });

    // After the save-reload the selection resets to A1; reselect B2 and toggle off.
    fireEvent.mouseDown(view.container.querySelector('[data-cell="1,1"]')!);
    fireEvent.click(screen.getByTestId('sheet-toolbar-bold'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    const sheet = savedSheet(onSave);
    expect(sheet.styles.B2).toBeUndefined();
    expect(sheet.styles.A1).toBeUndefined();
  });

  it('toolbar writes color, alignment, and number format — General clears the format key', async () => {
    const { onSave } = installSheetServer(baseDoc());
    render(<Editor {...propsFor({ onSave })} />);
    await screen.findByText('hello desk');

    const saveOnce = async (calls: number) => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(calls));
    };

    // A1 is the initial selection; apply the color.
    fireEvent.change(screen.getByTestId('sheet-toolbar-color'), { target: { value: '#ff0000' } });
    await saveOnce(1);
    expect(savedSheet(onSave).styles.A1).toEqual({ color: '#ff0000' });

    // Alignment accumulates on the same record.
    fireEvent.click(screen.getByTestId('sheet-toolbar-align-center'));
    await saveOnce(2);
    expect(savedSheet(onSave).styles.A1).toEqual({ color: '#ff0000', alignment: 'center' });

    // Number format is written as a string; the General option removes the key.
    fireEvent.change(screen.getByTestId('sheet-toolbar-number-format'), { target: { value: '0.00' } });
    await saveOnce(3);
    expect(savedSheet(onSave).styles.A1).toEqual({ color: '#ff0000', alignment: 'center', numberFormat: '0.00' });

    fireEvent.change(screen.getByTestId('sheet-toolbar-number-format'), { target: { value: '' } });
    await saveOnce(4);
    expect(savedSheet(onSave).styles.A1).toEqual({ color: '#ff0000', alignment: 'center' });
  });

  it('shift+click selects a range and the toolbar formats every cell in it', async () => {
    const { onSave } = installSheetServer(baseDoc());
    const view = render(<Editor {...propsFor({ onSave })} />);
    await screen.findByText('hello desk');

    fireEvent.mouseDown(view.container.querySelector('[data-cell="0,0"]')!);
    fireEvent.mouseDown(view.container.querySelector('[data-cell="1,1"]')!, { shiftKey: true });
    expect(screen.getByText('A1:B2')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('sheet-toolbar-bold'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const styles = savedSheet(onSave).styles;
    expect(Object.keys(styles).sort()).toEqual(['A1', 'A2', 'B1', 'B2']);
    expect(styles.A1).toEqual({ bold: true });
    expect(styles.B2).toEqual({ bold: true });
  });

  it('merge writes the range, clears non-anchor cells, and unmerge removes it', async () => {
    const { onSave } = installSheetServer(baseDoc());
    const view = render(<Editor {...propsFor({ onSave })} />);
    await screen.findByText('hello desk');

    fireEvent.mouseDown(view.container.querySelector('[data-cell="0,0"]')!);
    fireEvent.mouseDown(view.container.querySelector('[data-cell="1,1"]')!, { shiftKey: true });
    fireEvent.click(screen.getByTestId('sheet-toolbar-merge'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));

    const merged = savedSheet(onSave);
    expect(merged.merges).toContain('A1:B2');
    expect(merged.cells[0]![0]).toBe('Item'); // anchor text kept
    expect(merged.cells[0]![1]).toBe('');
    expect(merged.cells[1]![0]).toBe('');
    expect(merged.cells[1]![1]).toBe('');

    // After the reload the merged range renders as a single spanned cell…
    await waitFor(() =>
      expect(view.container.querySelector('[data-cell="0,1"]')).toBeNull(),
    );
    expect(view.container.querySelector('[data-cell="0,0"]')!.getAttribute('colspan')).toBe('2');
    expect(view.container.querySelector('[data-cell="0,0"]')!.getAttribute('rowspan')).toBe('2');

    // …and the selection inside it can unmerge.
    fireEvent.click(screen.getByTestId('sheet-toolbar-unmerge'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(savedSheet(onSave).merges).toEqual([]);
  });

  it('find jumps between matches with a counter and outlines the active hit', async () => {
    const view = render(<Editor {...propsFor()} />);
    await screen.findByText('hello desk');
    const formulaBar = screen.getByPlaceholderText('Value or =formula') as HTMLInputElement;

    const find = screen.getByTestId('sheet-find') as HTMLInputElement;
    expect(screen.queryByTestId('sheet-find-count')).toBeNull();

    fireEvent.change(find, { target: { value: 'hello' } });
    expect(screen.getByTestId('sheet-find-count')).toHaveTextContent('0/2');

    fireEvent.keyDown(find, { key: 'Enter' });
    expect(screen.getByTestId('sheet-find-count')).toHaveTextContent('1/2');
    expect(formulaBar.value).toBe('hello desk'); // jumped to A2
    expect(view.container.querySelector('[data-cell="1,0"]')!.className).toContain('ring-func-warning');

    fireEvent.keyDown(find, { key: 'Enter' });
    expect(screen.getByTestId('sheet-find-count')).toHaveTextContent('2/2');
    expect(formulaBar.value).toBe('hello again'); // jumped to A3

    fireEvent.keyDown(find, { key: 'Enter' }); // wraps around
    expect(screen.getByTestId('sheet-find-count')).toHaveTextContent('1/2');
    expect(formulaBar.value).toBe('hello desk');
  });

  it('find matches computed values, not just the raw formula text', async () => {
    render(<Editor {...propsFor()} />);
    await screen.findByText('hello desk');
    const formulaBar = screen.getByPlaceholderText('Value or =formula') as HTMLInputElement;

    fireEvent.change(screen.getByTestId('sheet-find'), { target: { value: '5' } });
    expect(screen.getByTestId('sheet-find-count')).toHaveTextContent('0/1');

    fireEvent.keyDown(screen.getByTestId('sheet-find'), { key: 'Enter' });
    expect(screen.getByTestId('sheet-find-count')).toHaveTextContent('1/1');
    expect(formulaBar.value).toBe('=B1+B2'); // the only cell whose value is 5
  });

  it('renders with the locale direction and auto-directional text inputs', async () => {
    localeState.isRtl = true;
    localeState.dir = 'rtl';
    const view = render(<Editor {...propsFor()} />);
    await screen.findByText('hello desk');

    expect(view.container.firstElementChild).toHaveAttribute('dir', 'rtl');
    expect(screen.getByPlaceholderText('Value or =formula')).toHaveAttribute('dir', 'auto');
  });

  it('keeps the grid LTR-safe when the locale is English', async () => {
    const view = render(<Editor {...propsFor()} />);
    await screen.findByText('hello desk');
    expect(view.container.firstElementChild).toHaveAttribute('dir', 'ltr');
  });

  it('PDF export calls the shared helper and surfaces its error in the notice area', async () => {
    pdfMock.mockResolvedValue({ ok: false, error: 'PDF engine offline' });
    render(<Editor {...propsFor()} />);
    await screen.findByText('hello desk');

    fireEvent.click(screen.getByTestId('sheet-export-pdf'));
    await waitFor(() => expect(pdfMock).toHaveBeenCalledWith('sheet', 'task_1', 'case/budget.xlsx'));
    expect(await screen.findByTestId('sheet-notice')).toHaveTextContent('PDF engine offline');
  });

  it('PDF export success keeps the notice area quiet', async () => {
    pdfMock.mockResolvedValue({ ok: true, filename: 'budget.pdf', bytes: 9 });
    render(<Editor {...propsFor()} />);
    await screen.findByText('hello desk');

    fireEvent.click(screen.getByTestId('sheet-export-pdf'));
    await waitFor(() => expect(pdfMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('sheet-notice')).toBeNull();
    expect(screen.getByTestId('sheet-export-pdf')).toHaveTextContent('Export PDF'); // busy state cleared
  });

  it('counts the filled cells of the current sheet', async () => {
    render(<Editor {...propsFor()} />);
    await screen.findByText('hello desk');
    expect(screen.getByTestId('sheet-word-count')).toHaveTextContent('Filled cells: 6');
  });
});
