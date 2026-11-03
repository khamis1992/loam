import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DocEditor from '../Editor';
import type { WorkspaceFile } from '../../types';
import { caretPointToOffset, placeCaret, visibleTotal } from '../trackEditing';
import { pendingChanges, type TrackedDocument } from '@shared/trackChanges';

vi.mock('@/services/rpc', () => ({
  getApiBase: () => '',
  getApiHeaders: async () => ({ 'x-test': '1' }),
}));

const DOC_HTML = '<p data-s="1">Hello world</p>\n<p data-s="2">Second paragraph</p>';

const file: WorkspaceFile = { taskId: 'task_t1', path: 'report.docx', name: 'report.docx', kind: 'doc' };

const fetchMock = vi.fn();

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/workspace/doc/track')) {
      if (init?.method === 'PUT') return jsonResponse({ ok: true });
      return jsonResponse({ track: null });
    }
    if (url.includes('metaOnly=1')) return jsonResponse({ mtimeMs: 11, size: 100 });
    if (url.includes('/api/workspace/doc/file')) {
      return jsonResponse({ html: `<!-- doc-session 00000000-0000-4000-8000-000000000001 11 -->\n${DOC_HTML}`, session: '00000000-0000-4000-8000-000000000001', mtimeMs: 11, size: 100, editable: true, warnings: [] });
    }
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function surfaceOf(container: HTMLElement): HTMLElement {
  const surface = container.querySelector('.doc-print-surface');
  if (!surface) throw new Error('doc surface not mounted yet');
  return surface as HTMLElement;
}

/** Put the caret at a *model* (visible) offset inside a paragraph — the tracked
 *  view mixes plain text, <ins> and struck spans, so raw text-node offsets do
 *  not line up; placeCaret is exactly what the editor ships for this. */
function caretAt(surface: HTMLElement, paragraphIndex: number, offset: number): void {
  placeCaret(surface.querySelectorAll('p')[paragraphIndex]!, offset);
}

function fireBeforeInput(surface: HTMLElement, inputType: string, data?: string): Event {
  const event = new InputEvent('beforeinput', { inputType, data, bubbles: true, cancelable: true });
  surface.dispatchEvent(event);
  return event;
}

/** Click the toolbar toggle and wait until React has committed track mode. */
async function enterTrack(surface: HTMLElement): Promise<void> {
  fireEvent.click(screen.getByTitle('Track changes'));
  await waitFor(() => {
    expect(screen.getByTitle('Track changes')).toHaveAttribute('aria-pressed', 'true');
    expect(surface.querySelector('p[data-tp]')).not.toBeNull();
  });
}

describe('DocEditor track-changes toggle', () => {
  it('enters tracked mode, intercepts typing into the model and restores the DOM on exit', async () => {
    const { container } = render(<DocEditor file={file} live={false} onSave={vi.fn()} onChatEdit={vi.fn()} />);
    const surface = await waitFor(() => surfaceOf(container));
    await waitFor(() => { expect(surface.textContent).toContain('Hello world'); });
    const originalHtml = surface.innerHTML;

    // OFF: beforeinput is not intercepted at all
    const untouched = fireBeforeInput(surface, 'insertText', 'X');
    expect(untouched.defaultPrevented).toBe(false);
    expect(surface.innerHTML).toBe(originalHtml);

    // ON: toggle enters track mode, blocks are tagged with model paragraph ids
    await enterTrack(surface);
    expect(screen.getByText('Tracked changes')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/workspace/doc/track?taskId=task_t1'), expect.anything());

    // typing goes through the model: insert produces a green insert run
    caretAt(surface, 0, 5);
    const event = fireBeforeInput(surface, 'insertText', ' big');
    expect(event.defaultPrevented).toBe(true);
    const firstBlock = surface.querySelectorAll('p')[0]!;
    expect(firstBlock.querySelector('.loam-track-ins')!.textContent).toBe(' big');
    expect(firstBlock.textContent).toBe('Hello big world');

    // caret restored after the inserted text (model offset 9), skipping nothing
    const selection = window.getSelection()!;
    expect(caretPointToOffset(firstBlock, selection.anchorNode!, selection.anchorOffset)).toBe(9);

    // forward-delete marks the base run as a red struck run (one keystroke = one char)
    caretAt(surface, 0, 10);
    for (let i = 0; i < 5; i++) fireBeforeInput(surface, 'deleteContentForward');
    const deleted = Array.from(firstBlock.querySelectorAll('.loam-track-del')).map((span) => span.textContent).join('');
    expect(deleted).toBe('world');
    expect(visibleTotal(firstBlock)).toBe('Hello big '.length);

    // Enter is refused in track mode (the model has no paragraph insert)
    caretAt(surface, 0, 3);
    const enter = fireBeforeInput(surface, 'insertParagraph');
    expect(enter.defaultPrevented).toBe(true);
    expect(surface.querySelectorAll('p')).toHaveLength(2);

    // sidecar PUT fires after the debounce with the serialized model
    await new Promise((resolve) => setTimeout(resolve, 950));
    const put = fetchMock.mock.calls.find((call) => String(call[0]).includes('/api/workspace/doc/track') && (call[1] as RequestInit | undefined)?.method === 'PUT');
    expect(put).toBeTruthy();
    const body = JSON.parse((put![1] as RequestInit).body as string) as { track: TrackedDocument };
    expect(body.track.authors.local).toEqual({ id: 'local', name: 'مستخدم لوم' });
    expect(pendingChanges(body.track).length).toBeGreaterThanOrEqual(2);

    // the panel lists the pending changes (insert + the five delete chars)
    expect(screen.getByText('Insert')).toBeTruthy();
    expect(screen.getAllByText('Delete').length).toBeGreaterThanOrEqual(1);

    // OFF again: the pre-track DOM is restored byte-for-byte
    fireEvent.click(screen.getByTitle('Track changes'));
    await waitFor(() => { expect(surface.querySelector('[data-tp]')).toBeNull(); });
    expect(surface.innerHTML).toBe(originalHtml);
  });

  it('writes the resolved text onto the surface on Accept all and leaves track mode', async () => {
    const { container } = render(<DocEditor file={file} live={false} onSave={vi.fn()} onChatEdit={vi.fn()} />);
    const surface = await waitFor(() => surfaceOf(container));
    await waitFor(() => { expect(surface.textContent).toContain('Hello world'); });

    await enterTrack(surface);

    caretAt(surface, 0, 5);
    fireBeforeInput(surface, 'insertText', ' brave');
    caretAt(surface, 0, 12);
    fireBeforeInput(surface, 'deleteContentForward');
    // let the panel state flush so the bulk buttons are enabled
    await waitFor(() => expect(screen.getByText('2 pending')).toBeTruthy());

    fireEvent.click(screen.getByText('Accept all'));
    await waitFor(() => { expect(surface.querySelector('[data-tp]')).toBeNull(); });
    expect(surface.querySelectorAll('p')[0]!.textContent).toBe('Hello brave orld');
    expect(surface.querySelector('.loam-track-ins')).toBeNull();
    // the panel is gone and the save button is enabled again
    expect(screen.queryByText('Pending changes')).toBeNull();
    expect((screen.getByRole('button', { name: /Save/ }) as HTMLButtonElement).disabled).toBe(false);
    // resolved model persisted via PUT
    await waitFor(() => {
      const put = fetchMock.mock.calls.find((call) => String(call[0]).includes('/api/workspace/doc/track') && (call[1] as RequestInit | undefined)?.method === 'PUT');
      expect(put).toBeTruthy();
      expect(pendingChanges(JSON.parse((put![1] as RequestInit).body as string).track)).toHaveLength(0);
    });
  });

  it('reject all restores the original paragraph text', async () => {
    const { container } = render(<DocEditor file={file} live={false} onSave={vi.fn()} onChatEdit={vi.fn()} />);
    const surface = await waitFor(() => surfaceOf(container));
    await waitFor(() => { expect(surface.textContent).toContain('Hello world'); });

    await enterTrack(surface);
    caretAt(surface, 0, 5);
    fireBeforeInput(surface, 'insertText', 'XX');
    await waitFor(() => expect(screen.getByText('1 pending')).toBeTruthy());

    fireEvent.click(screen.getByText('Reject all'));
    await waitFor(() => { expect(surface.querySelector('[data-tp]')).toBeNull(); });
    expect(surface.querySelectorAll('p')[0]!.textContent).toBe('Hello world');
  });
});
