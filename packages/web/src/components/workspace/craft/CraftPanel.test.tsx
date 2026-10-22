import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CraftPanel,
  craftFrameUrl,
  CRAFT_READY_TIMEOUT_MS,
  fetchCraftStatus,
  fetchTaskFileBytes,
  fallbackKindFor,
  getCraftBridge,
  registerCraftBridge,
  subscribeCraftBridges,
} from './CraftPanel';
import { CraftBridge, CRAFT_APPS } from '@/lib/craftBridge';
import { setLocale } from '@/i18n/t';

const docFallback = () => Promise.resolve(null);

/** Make /api/craft/status answer for every app, so the panel does not fall back. */
function stubCraftStatus(present = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/craft/status')) {
        const apps = Object.fromEntries(
          ['docs', 'sheets', 'slides', 'photo', 'design'].map((app) => [app, { present }]),
        );
        return new Response(JSON.stringify({ ok: present, apps, missing: present ? [] : ['docs'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    }),
  );
}

/**
 * Mount one editor panel and drive it through the iframe's real `contentWindow`.
 * Queries are scoped to `view.container` so DOM from earlier tests can never
 * collide with this panel's elements.
 */
async function mountEditorPanel(props: Partial<React.ComponentProps<typeof CraftPanel>>) {
  stubCraftStatus();
  const view = render(
    <CraftPanel
      taskId="t1"
      app="docs"
      path="notes/plan.docx"
      onClose={() => undefined}
      fetchBytes={vi.fn(async () => new Uint8Array([1, 2, 3]))}
      uploadBytes={vi.fn(async () => undefined)}
      loadFallback={docFallback}
      {...props}
    />,
  );
  const iframe = view.container.querySelector('iframe');
  expect(iframe).not.toBeNull();
  const posted: Array<Record<string, unknown>> = [];
  const contentWindow = (iframe as HTMLIFrameElement).contentWindow as Window & {
    postMessage: ReturnType<typeof vi.fn>;
  };
  contentWindow.postMessage = vi.fn((message: Record<string, unknown>) => {
    posted.push(message);
  });
  return { ...view, iframe: iframe as HTMLIFrameElement, posted, contentWindow };
}

function announceReady(contentWindow: Window, app = 'wordcraft', version = '1.0.0'): void {
  window.dispatchEvent(
    new MessageEvent('message', { source: contentWindow, data: { type: 'craft:ready', app, version } }),
  );
}

function announceSave(contentWindow: Window, name: string, bytes: number[], app = 'wordcraft'): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      source: contentWindow,
      data: { type: 'craft:save', app, name, bytes },
    }),
  );
}

describe('craftFrameUrl / fallbackKindFor', () => {
  it('builds the loamcraft:// url from the app product key', () => {
    expect(craftFrameUrl('docs')).toBe('loamcraft://wordcraft/index.html?loam=1');
    expect(craftFrameUrl('photo')).toBe('loamcraft://photocraft/index.html?loam=1');
  });

  it('maps docs/sheets/slides to their built-in editor and photo/design to preview', () => {
    expect(fallbackKindFor('docs')).toBe('doc');
    expect(fallbackKindFor('sheets')).toBe('sheet');
    expect(fallbackKindFor('slides')).toBe('slides');
    expect(fallbackKindFor('photo')).toBeNull();
    expect(fallbackKindFor('design')).toBeNull();
  });

  it('waits up to 20s for the embedded app to become ready', () => {
    expect(CRAFT_READY_TIMEOUT_MS).toBe(20_000);
  });
});

describe('CraftPanel', () => {
  beforeEach(() => {
    setLocale('en');
    vi.restoreAllMocks();
    registerCraftBridge('t1', 'docs', null);
    registerCraftBridge('t1', 'sheets', null);
    registerCraftBridge('t1', 'design', null);
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.restoreAllMocks();
    registerCraftBridge('t1', 'docs', null);
    registerCraftBridge('t1', 'sheets', null);
    registerCraftBridge('t1', 'design', null);
  });

  it('shows the built-in editor with a notice when forceFallback is set', async () => {
    const Fallback = () => <div>built-in doc editor</div>;
    const view = render(
      <CraftPanel
        taskId="t1"
        app="docs"
        path="notes/plan.docx"
        onClose={() => undefined}
        forceFallback
        loadFallback={() => Promise.resolve(Fallback)}
      />,
    );
    expect(await within(view.container).findByText('built-in doc editor')).toBeInTheDocument();
    expect(within(view.container).getByText('Loam Docs')).toBeInTheDocument();
    expect(within(view.container).queryByTitle('Save to task files')).toBeNull();
  });

  it('shows the media preview for apps without a built-in editor', () => {
    const view = render(
      <CraftPanel
        taskId="t1"
        app="photo"
        path="shots/art.png"
        onClose={() => undefined}
        forceFallback
        loadFallback={docFallback}
      />,
    );
    expect(within(view.container).getByAltText('art.png')).toBeInTheDocument();
  });

  it('embeds the editor iframe once ready and registers the bridge for agent tools', async () => {
    const fetchBytes = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const { iframe, posted, contentWindow, container } = await mountEditorPanel({ fetchBytes });

    expect(iframe.src).toBe('loamcraft://wordcraft/index.html?loam=1');
    announceReady(contentWindow);

    await vi.waitFor(() => expect(getCraftBridge('t1', 'docs')).toBeInstanceOf(CraftBridge));
    await vi.waitFor(() => expect(posted.some((m) => m.type === 'craft:open')).toBe(true));
    expect(posted.find((m) => m.type === 'craft:open')).toMatchObject({ name: 'plan.docx' });
    expect(fetchBytes).toHaveBeenCalledWith('notes/plan.docx');
    expect(within(container).getByText('Ready')).toBeInTheDocument();
  });

  it('falls back with a notice when the app never becomes ready', async () => {
    vi.useFakeTimers();
    stubCraftStatus();
    const Fallback = () => <div>built-in doc editor</div>;
    const view = render(
      <CraftPanel
        taskId="t1"
        app="docs"
        path="notes/plan.docx"
        onClose={() => undefined}
        fetchBytes={vi.fn(async () => new Uint8Array())}
        loadFallback={() => Promise.resolve(Fallback)}
      />,
    );
    expect(view.container.querySelector('iframe')?.getAttribute('src')).toContain('loamcraft://');
    // Advance the ready timeout and flush React's state update inside act.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CRAFT_READY_TIMEOUT_MS);
    });
    vi.useRealTimers();
    // The notice is rendered both as the header status and as the notice row.
    expect(
      await within(view.container).findAllByText(
        'The Craft editor did not start, so the built-in editor is open instead.',
      ),
    ).not.toHaveLength(0);
    expect(await within(view.container).findByText('built-in doc editor')).toBeInTheDocument();
  });

  it('uploads every craft:save through the task-files upload API', async () => {
    const uploadBytes = vi.fn(async () => undefined);
    const { posted, contentWindow, container } = await mountEditorPanel({
      app: 'sheets',
      path: 'data/budget.xlsx',
      uploadBytes,
    });
    announceReady(contentWindow, 'gridcraft');
    await vi.waitFor(() => expect(getCraftBridge('t1', 'sheets')).toBeInstanceOf(CraftBridge));
    // The app is opened asynchronously once React settles the ready state.
    await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0));
    expect(posted.some((m) => m.type === 'craft:open')).toBe(true);

    announceSave(contentWindow, 'budget.xlsx', [10, 20, 30], 'gridcraft');

    await vi.waitFor(() => expect(uploadBytes).toHaveBeenCalledTimes(1));
    const [taskId, name, bytes] = uploadBytes.mock.calls[0] as unknown as [string, string, Uint8Array];
    expect(taskId).toBe('t1');
    expect(name).toBe('budget.xlsx');
    expect(Array.from(bytes)).toEqual([10, 20, 30]);
    expect(await within(container).findByText('Saved budget.xlsx')).toBeInTheDocument();
  });

  it('save button runs file.save on the live bridge', async () => {
    const { posted, contentWindow, container } = await mountEditorPanel({});
    announceReady(contentWindow);
    await vi.waitFor(() => expect(getCraftBridge('t1', 'docs')).toBeInstanceOf(CraftBridge));

    // The save action only appears once the panel has settled into the ready state.
    const saveButton = await within(container).findByRole('button', { name: 'Save to task files' });
    fireEvent.click(saveButton);
    await vi.waitFor(() => {
      expect(
        posted.some(
          (m) => m.method === 'engine.execute' && (m.params as { command?: string } | undefined)?.command === 'file.save',
        ),
      ).toBe(true);
    });
  });

  it('localises the fallback notice in Arabic', async () => {
    setLocale('ar');
    const view = render(
      <CraftPanel
        taskId="t1"
        app="docs"
        path="notes/plan.docx"
        onClose={() => undefined}
        forceFallback
        loadFallback={docFallback}
      />,
    );
    expect(await within(view.container).findByText('المحرّر المدمج')).toBeInTheDocument();
  });

  it('exposes bridge registration to subscribers and clears it on unmount', async () => {
    const events: number[] = [];
    const unsubscribe = subscribeCraftBridges(() => events.push(1));
    const { contentWindow, unmount } = await mountEditorPanel({
      app: 'design',
      path: 'shots/art.png',
    });
    announceReady(contentWindow, 'designcraft');
    await vi.waitFor(() => expect(getCraftBridge('t1', 'design')).not.toBeNull());
    expect(events.length).toBeGreaterThan(0);
    unmount();
    expect(getCraftBridge('t1', 'design')).toBeNull();
    unsubscribe();
  });

  it('uses the Loam display name for every app', () => {
    expect(CRAFT_APPS.photo.displayName).toBe('Loam Photo');
    expect(CRAFT_APPS.slides.displayName).toBe('Loam Slides');
  });
});

describe('CraftPanel task-file helpers', () => {
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.restoreAllMocks();
  });

  it('reads a task file as bytes through /api/files', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ entries: [{ data: 'aGVsbG8=' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const bytes = await fetchTaskFileBytes('t1', 'notes/a.txt');
    expect(new TextDecoder().decode(bytes)).toBe('hello');
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/api/files?');
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('taskId=t1');
  });

  it('throws a clear error when the task file is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    await expect(fetchTaskFileBytes('t1', 'missing.docx')).rejects.toThrow(/404/);
  });

  it('treats a missing cr-01 status endpoint as unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    await expect(fetchCraftStatus()).resolves.toEqual({ ok: false });
  });

  it('reads the installed Craft dists when the endpoint exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ apps: { docs: { present: true } }, missing: ['design'] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    await expect(fetchCraftStatus()).resolves.toEqual({
      ok: true,
      apps: { docs: { present: true } },
      missing: ['design'],
    });
  });

  it('falls back to the built-in editor when /api/craft/status reports the dist missing', async () => {
    const Fallback = () => <div>built-in doc editor</div>;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ ok: true, apps: { docs: { present: false } }, missing: ['docs'] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const view = render(
      <CraftPanel
        taskId="t1"
        app="docs"
        path="notes/plan.docx"
        onClose={() => undefined}
        fetchBytes={vi.fn(async () => new Uint8Array())}
        uploadBytes={vi.fn(async () => undefined)}
        loadFallback={() => Promise.resolve(Fallback)}
      />,
    );
    expect(await within(view.container).findByText('built-in doc editor')).toBeInTheDocument();
    expect(within(view.container).queryByTitle('Save to task files')).toBeNull();
  });
});
