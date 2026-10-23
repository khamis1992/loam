import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CRAFT_APPS,
  CraftBridge,
  CraftCallError,
  CraftNotReadyError,
  CraftTimeoutError,
  craftAppFromInternalId,
  craftFrameUrl,
  type CraftReady,
} from '../craftBridge';

/**
 * A minimal fake iframe: the bridge only needs `contentWindow`, and the source
 * filter compares `event.source` against it. `posted` records every message the
 * bridge sends so tests can drive the other side of the protocol.
 */
function fakeIframe() {
  const contentWindow = { postMessage: vi.fn() } as unknown as Window;
  const posted: Array<Record<string, unknown>> = [];
  (contentWindow.postMessage as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (message: Record<string, unknown>) => {
      posted.push(message);
    },
  );
  const iframe = { contentWindow } as unknown as HTMLIFrameElement;
  return { iframe, posted, contentWindow };
}

/** The queued send runs on a microtask, so flush before asserting on it. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Emit a message as if it came from the editor iframe. */
function fromIframe(contentWindow: Window, message: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent('message', { source: contentWindow, data: message }));
}

/** Emit a message from a different window (must be ignored). */
function fromForeignWindow(message: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent('message', { source: {} as Window, data: message }));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('craft app map', () => {
  it('maps every Loam product key to its internal id and display name', () => {
    expect(Object.keys(CRAFT_APPS)).toEqual(['docs', 'sheets', 'slides', 'photo', 'design']);
    expect(CRAFT_APPS.docs.internalId).toBe('wordcraft');
    expect(CRAFT_APPS.sheets.internalId).toBe('gridcraft');
    expect(CRAFT_APPS.slides.internalId).toBe('deckcraft');
    expect(CRAFT_APPS.photo.internalId).toBe('photocraft');
    expect(CRAFT_APPS.design.internalId).toBe('designcraft');
    expect(CRAFT_APPS.docs.displayName).toBe('Loam Docs');
    expect(CRAFT_APPS.design.displayName).toBe('Loam Design');
  });

  it('resolves the product key from an internal id and rejects unknown ids', () => {
    expect(craftAppFromInternalId('gridcraft')).toBe('sheets');
    expect(craftAppFromInternalId('artcraft')).toBeNull();
  });

  it('builds the loamcraft:// frame url from a product key or an internal id', () => {
    expect(craftFrameUrl('slides')).toBe('loamcraft://deckcraft/index.html?loam=1');
    expect(craftFrameUrl('designcraft')).toBe('loamcraft://designcraft/index.html?loam=1');
  });
});

describe('CraftBridge', () => {
  it('reports not ready until the app announces craft:ready', () => {
    const { iframe } = fakeIframe();
    const bridge = new CraftBridge(iframe);
    expect(bridge.isReady()).toBe(false);
    bridge.dispose();
  });

  it('waitReady resolves with {app, version} and reports ready', async () => {
    const { iframe, contentWindow } = fakeIframe();
    const bridge = new CraftBridge(iframe);
    const ready: Promise<CraftReady> = bridge.waitReady();
    fromIframe(contentWindow, { type: 'craft:ready', app: 'wordcraft', version: '1.2.3' });
    await expect(ready).resolves.toEqual({ app: 'wordcraft', version: '1.2.3' });
    expect(bridge.isReady()).toBe(true);
    // A second caller resolves immediately with the same announcement.
    await expect(bridge.waitReady()).resolves.toEqual({ app: 'wordcraft', version: '1.2.3' });
    bridge.dispose();
  });

  it('waitReady rejects with CraftNotReadyError when the app never answers', async () => {
    vi.useFakeTimers();
    const { iframe } = fakeIframe();
    const bridge = new CraftBridge(iframe);
    const ready = bridge.waitReady(1_000);
    const assertion = expect(ready).rejects.toBeInstanceOf(CraftNotReadyError);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    bridge.dispose();
  });

  it('waitReady rejects when the app reports it exposes no API', async () => {
    const { iframe, contentWindow } = fakeIframe();
    const bridge = new CraftBridge(iframe);
    const ready = bridge.waitReady();
    fromIframe(contentWindow, { type: 'craft:ready', app: 'wordcraft', version: '1.0.0', hasApi: false });
    await expect(ready).rejects.toBeInstanceOf(CraftNotReadyError);
    bridge.dispose();
  });

  it('routes a craft:result to the matching call and unwraps {ok, result}', async () => {
    const { iframe, contentWindow, posted } = fakeIframe();
    const bridge = new CraftBridge(iframe);
    const call = bridge.call('document.inspect', { depth: 1 });
    await flush();
    expect(posted[0]).toMatchObject({
      type: 'craft:call',
      method: 'document.inspect',
      params: { depth: 1 },
    });
    fromIframe(contentWindow, { type: 'craft:result', id: posted[0].id, ok: true, result: { paragraphs: 3 } });
    await expect(call).resolves.toEqual({ paragraphs: 3 });
    bridge.dispose();
  });

  it('throws CraftCallError carrying the app message on ok:false', async () => {
    const { iframe, contentWindow, posted } = fakeIframe();
    const bridge = new CraftBridge(iframe);
    const call = bridge.call('engine.execute', { command: 'edit.delete' });
    await flush();
    const id = posted[0].id as string;
    fromIframe(contentWindow, {
      type: 'craft:result',
      id,
      ok: false,
      method: 'engine.execute',
      error: 'document is read-only',
    });
    await expect(call).rejects.toBeInstanceOf(CraftCallError);
    await expect(call).rejects.toMatchObject({
      name: 'CraftCallError',
      message: 'document is read-only',
      method: 'engine.execute',
      id,
    });
    bridge.dispose();
  });

  it('times out an unanswered call with CraftTimeoutError', async () => {
    vi.useFakeTimers();
    const { iframe } = fakeIframe();
    const bridge = new CraftBridge(iframe);
    const call = bridge.call('ui.screenshot', {}, 2_000);
    const assertion = expect(call).rejects.toBeInstanceOf(CraftTimeoutError);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    bridge.dispose();
  });

  it('ignores messages that did not come from the embedded iframe', async () => {
    vi.useFakeTimers();
    const { iframe } = fakeIframe();
    const bridge = new CraftBridge(iframe);
    const call = bridge.call('document.inspect', {}, 3_000);
    const assertion = expect(call).rejects.toBeInstanceOf(CraftTimeoutError);
    fromForeignWindow({ type: 'craft:ready', app: 'wordcraft', version: '9.9.9' });
    fromForeignWindow({ type: 'craft:result', id: 'craft-1', ok: true, result: 'forged' });
    expect(bridge.isReady()).toBe(false);
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;
    bridge.dispose();
  });

  it('execute() wraps the command and params in engine.execute', async () => {
    const { iframe, contentWindow, posted } = fakeIframe();
    const bridge = new CraftBridge(iframe);
    const call = bridge.execute('edit.undo');
    await flush();
    expect(posted[0]).toMatchObject({
      type: 'craft:call',
      method: 'engine.execute',
      params: { command: 'edit.undo', params: {} },
    });
    fromIframe(contentWindow, { type: 'craft:result', id: posted[0].id, ok: true, result: true });
    await expect(call).resolves.toBe(true);
    bridge.dispose();
  });

  it('commands() returns the command list and tolerates a non-array answer', async () => {
    const { iframe, contentWindow, posted } = fakeIframe();
    const bridge = new CraftBridge(iframe);
    const call = bridge.commands('bold');
    await flush();
    expect(posted[0]).toMatchObject({ method: 'engine.commands', params: { search: 'bold' } });
    fromIframe(contentWindow, {
      type: 'craft:result',
      id: posted[0].id,
      ok: true,
      result: [{ id: 'edit.bold', label: 'Bold' }],
    });
    await expect(call).resolves.toEqual([{ id: 'edit.bold', label: 'Bold' }]);

    const empty = bridge.commands();
    await flush();
    fromIframe(contentWindow, { type: 'craft:result', id: posted[1].id, ok: true, result: null });
    await expect(empty).resolves.toEqual([]);
    bridge.dispose();
  });

  it('delivers craft:save bytes to every onSave subscriber', () => {
    const { iframe, contentWindow } = fakeIframe();
    const bridge = new CraftBridge(iframe);
    const saves: string[] = [];
    bridge.onSave((save) => {
      saves.push(`${save.app}:${save.name}:${save.bytes.length}`);
    });
    fromIframe(contentWindow, { type: 'craft:save', app: 'gridcraft', name: 'budget.xlsx', bytes: [1, 2, 3] });
    expect(saves).toEqual(['gridcraft:budget.xlsx:3']);
    bridge.dispose();
  });

  it('decodes a base64 craft:save payload into bytes', () => {
    const { iframe, contentWindow } = fakeIframe();
    const bridge = new CraftBridge(iframe);
    const received: string[] = [];
    bridge.onSave((save) => received.push(new TextDecoder().decode(save.bytes)));
    // "hello" in base64.
    fromIframe(contentWindow, { type: 'craft:save', app: 'wordcraft', name: 'note.txt', bytes: 'aGVsbG8=' });
    expect(received).toEqual(['hello']);
    bridge.dispose();
  });

  it('open() posts craft:open with the file name and bytes', () => {
    const { iframe, posted } = fakeIframe();
    const bridge = new CraftBridge(iframe);
    bridge.open('plan.docx', new Uint8Array([9, 8, 7]));
    expect(posted[0]).toMatchObject({ type: 'craft:open', name: 'plan.docx' });
    expect(posted[0].bytes).toBeInstanceOf(Uint8Array);
    bridge.dispose();
  });

  it('serialises calls so only one request is in flight at a time', async () => {
    const { iframe, contentWindow, posted } = fakeIframe();
    const bridge = new CraftBridge(iframe);
    const first = bridge.call('document.inspect');
    const second = bridge.call('ui.inspect');
    await flush();
    expect(posted.filter((m) => m.type === 'craft:call')).toHaveLength(1);
    fromIframe(contentWindow, { type: 'craft:result', id: posted[0].id, ok: true, result: 1 });
    await expect(first).resolves.toBe(1);
    await flush();
    expect(posted.filter((m) => m.type === 'craft:call')).toHaveLength(2);
    fromIframe(contentWindow, { type: 'craft:result', id: posted[1].id, ok: true, result: 2 });
    await expect(second).resolves.toBe(2);
    bridge.dispose();
  });

  it('dispose() fails in-flight calls and drops the listener', async () => {
    const { iframe, contentWindow, posted } = fakeIframe();
    const bridge = new CraftBridge(iframe);
    const pending = bridge.call('document.inspect');
    await flush();
    bridge.dispose();
    await expect(pending).rejects.toThrow('Loam Craft bridge disposed');
    // A late result from the disposed bridge must not resolve anything.
    expect(() =>
      fromIframe(contentWindow, { type: 'craft:result', id: posted[0].id, ok: true, result: 1 }),
    ).not.toThrow();
  });

  it('drops save subscribers on dispose', () => {
    const { iframe, contentWindow } = fakeIframe();
    const bridge = new CraftBridge(iframe);
    let calls = 0;
    bridge.onSave(() => {
      calls += 1;
    });
    bridge.dispose();
    fromIframe(contentWindow, { type: 'craft:save', app: 'wordcraft', name: 'a.docx', bytes: [1] });
    expect(calls).toBe(0);
  });
});
