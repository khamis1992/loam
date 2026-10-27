import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspacePanel } from '../WorkspacePanel';
import { registerEditor } from '../registry';
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

registerEditor({ kind: 'doc', label: 'Doc probe', extensions: ['docx'], load: async () => ({ default: ProbeEditor }) });
registerEditor({ kind: 'sheet', label: 'Sheet probe', extensions: ['xlsx'], load: async () => ({ default: ProbeEditor }) });

const filesResponse = (entries: Array<{ name: string; path: string; mtimeMs: number }>) => ({
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
