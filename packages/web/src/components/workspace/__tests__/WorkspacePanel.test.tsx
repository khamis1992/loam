import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspacePanel } from '../WorkspacePanel';
import { getEditorForPath, registerEditor, setEditorOverride } from '../registry';
import type { WorkspaceEditorProps } from '../types';

vi.mock('@/services/rpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/rpc')>();
  return { ...actual, getApiBase: () => '', getApiHeaders: async () => ({}) };
});
vi.mock('@/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/store')>();
  return { ...actual, useAppSelector: () => false };
});

/** Probe editor: captures the panel's onSave so the save payload can be asserted. */
let captured: WorkspaceEditorProps | null = null;
function ProbeEditor(props: WorkspaceEditorProps) {
  captured = props;
  return <div data-testid="probe-editor" />;
}
/** Second probe for the override tests: a distinct editor claiming .docx too. */
function SlidesProbeEditor() {
  return <div data-testid="slides-probe" />;
}

registerEditor({ kind: 'doc', label: 'Doc probe', extensions: ['docx'], load: async () => ({ default: ProbeEditor }) });
registerEditor({ kind: 'sheet', label: 'Sheet probe', extensions: ['xlsx'], load: async () => ({ default: ProbeEditor }) });

const filesResponse = (entries: Array<{ name: string; path: string; mtimeMs: number; size?: number }>) => ({
  ok: true,
  json: async () => ({ entries }),
});

const saveResponse = { ok: true, json: async () => ({}) };

describe('WorkspacePanel onSave payload', () => {
  beforeEach(() => {
    captured = null;
  });

  it('saves doc files as a JSON { html } body with the JSON content type', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(filesResponse([{ name: 'plan.docx', path: 'docs/plan.docx', mtimeMs: 10 }]))
      .mockResolvedValueOnce(saveResponse);
    vi.stubGlobal('fetch', fetchMock);

    render(<WorkspacePanel taskId="task_1" live={false} events={[]} onChatEdit={() => undefined} />);
    await screen.findByTestId('probe-editor');
    await captured!.onSave('<!-- doc-session x -->\n<p>edited</p>');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(String(url)).toBe('/api/workspace/doc/file?taskId=task_1&path=docs%2Fplan.docx');
    expect(init.method).toBe('PUT');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ html: '<!-- doc-session x -->\n<p>edited</p>' }));
    vi.unstubAllGlobals();
  });

  it('keeps the raw text/plain payload for sheet files', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(filesResponse([
        { name: 'plan.docx', path: 'docs/plan.docx', mtimeMs: 10 },
        { name: 'grid.xlsx', path: 'docs/grid.xlsx', mtimeMs: 20 },
      ]))
      .mockResolvedValueOnce(saveResponse);
    vi.stubGlobal('fetch', fetchMock);

    render(<WorkspacePanel taskId="task_1" live={false} events={[]} onChatEdit={() => undefined} />);
    await screen.findByTestId('probe-editor');
    await captured!.onSave('{"sheets":[{"cells":[["1"]]}]}');

    const [url, init] = fetchMock.mock.calls[1]!;
    expect(String(url)).toBe('/api/workspace/sheet/file?taskId=task_1&path=docs%2Fgrid.xlsx');
    expect(init.method).toBe('PUT');
    expect(init.headers['content-type']).toBe('text/plain');
    expect(init.body).toBe('{"sheets":[{"cells":[["1"]]}]}');
    vi.unstubAllGlobals();
  });
});

describe('WorkspacePanel editor gateway', () => {
  beforeEach(() => {
    captured = null;
    window.localStorage.clear();
  });

  it('shows the fallback card for a requested file no editor claims', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      filesResponse([
        { name: 'archive.zip', path: 'out/archive.zip', mtimeMs: 30, size: 2048 },
        { name: 'grid.xlsx', path: 'docs/grid.xlsx', mtimeMs: 20 },
        { name: 'plan.docx', path: 'docs/plan.docx', mtimeMs: 10 },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkspacePanel
        taskId="task_1"
        live={false}
        events={[]}
        requestedPath="out/archive.zip"
        onChatEdit={() => undefined}
      />,
    );

    // The auto-opened file has no editor, so the honest card shows (not another
    // file, and no fake edit affordance).
    expect(await screen.findByText('No editor for this file type yet.')).toBeInTheDocument();
    expect(screen.getByText(/Type: ZIP/)).toBeInTheDocument();
    expect(screen.getByText(/2\.0 KB/)).toBeInTheDocument();

    const link = screen.getByText('Download file').closest('a');
    expect(link?.getAttribute('href')).toBe('/api/media?taskId=task_1&path=out%2Farchive.zip');
    expect(link).toHaveAttribute('download', 'archive.zip');

    // The docx file stays openable: selecting its tab still hosts the editor.
    fireEvent.click(screen.getByTitle('docs/plan.docx'));
    expect(await screen.findByTestId('probe-editor')).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('override menu lists every editor claiming the extension and persists the choice', async () => {
    registerEditor({
      kind: 'slides',
      label: 'Slides probe',
      extensions: ['docx'],
      load: async () => ({ default: SlidesProbeEditor }),
    });
    const fetchMock = vi.fn().mockImplementation(() =>
      filesResponse([{ name: 'plan.docx', path: 'docs/plan.docx', mtimeMs: 10 }]),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<WorkspacePanel taskId="task_1" live={false} events={[]} onChatEdit={() => undefined} />);
    await screen.findByTestId('probe-editor');

    // The «Open with» menu lists the automatic pick plus every claiming editor.
    fireEvent.click(screen.getByText('Open with'));
    expect(screen.getByRole('menuitemradio', { name: 'Automatic' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: 'Doc probe' })).toBeInTheDocument();
    const slidesOption = screen.getByRole('menuitemradio', { name: 'Slides probe' });
    expect(slidesOption).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(slidesOption);

    // Persisted per extension and honored by resolution: after the panel
    // re-resolves, the overridden editor hosts the file.
    expect(window.localStorage.getItem('loam.editor.override.docx')).toBe('slides');
    expect(getEditorForPath('docs/plan.docx')?.kind).toBe('slides');
    expect(await screen.findByTestId('slides-probe')).toBeInTheDocument();

    // Resetting to Automatic clears the override again.
    fireEvent.click(screen.getByText('Open with'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Automatic' }));
    expect(window.localStorage.getItem('loam.editor.override.docx')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('shows no override menu for a file type no editor claims', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      filesResponse([{ name: 'archive.zip', path: 'out/archive.zip', mtimeMs: 30 }]),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WorkspacePanel
        taskId="task_1"
        live={false}
        events={[]}
        requestedPath="out/archive.zip"
        onChatEdit={() => undefined}
      />,
    );
    expect(await screen.findByText('No editor for this file type yet.')).toBeInTheDocument();
    expect(screen.queryByText('Open with')).toBeNull();
    vi.unstubAllGlobals();
  });
});
