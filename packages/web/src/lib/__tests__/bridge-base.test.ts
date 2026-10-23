import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BridgeQueue,
  DEFAULT_CALL_TIMEOUT_MS,
  addMessageListener,
  armCallTimeout,
  bridgeTags,
  disposeBridge,
  parseBridgeMessage,
  rejectAllPending,
  settlePending,
  waitForApi,
} from '../bridge-base';
import { FILMCRAFT_FRAME_URL, FilmcraftBridge } from '../filmcraft';

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

/** Minimal iframe with its own contentWindow (jsdom gives every iframe one). */
function makeIframe(): HTMLIFrameElement {
  document.body.innerHTML = '<iframe id="ed"></iframe>';
  return document.getElementById('ed') as HTMLIFrameElement;
}

const emptyPending = (): Map<string, Pending> => new Map();
const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * jsdom always sets MessageEvent.source to null, so a dispatched MessageEvent can
 * never match an iframe. Dispatch a plain Event instead and define `source` and
 * `data` on it, which keeps the real listener registration (and removal) in play.
 */
function fireMessage(source: unknown, data: unknown): void {
  const event = new Event('message');
  Object.defineProperty(event, 'source', { value: source });
  Object.defineProperty(event, 'data', { value: data });
  window.dispatchEvent(event);
}

describe('bridgeTags', () => {
  it('derives every protocol tag from one prefix', () => {
    expect(bridgeTags('filmcraft')).toEqual({
      call: 'filmcraft:call',
      ready: 'filmcraft:ready',
      result: 'filmcraft:result',
      save: 'filmcraft:save',
      open: 'filmcraft:open',
    });
    expect(bridgeTags('craft').call).toBe('craft:call');
  });
});

describe('parseBridgeMessage', () => {
  it('passes through object payloads carrying a type', () => {
    expect(parseBridgeMessage({ type: 'craft:ready', app: 'docs' })).toEqual({
      type: 'craft:ready',
      app: 'docs',
    });
  });

  it('rejects null, arrays, primitives and typeless objects', () => {
    expect(parseBridgeMessage(null)).toBeNull();
    expect(parseBridgeMessage(undefined)).toBeNull();
    expect(parseBridgeMessage([{ type: 'craft:ready' }])).toBeNull();
    expect(parseBridgeMessage('craft:ready')).toBeNull();
    expect(parseBridgeMessage(42)).toBeNull();
    expect(parseBridgeMessage({ app: 'docs' })).toBeNull();
  });
});

describe('addMessageListener', () => {
  it('delivers messages whose source is the watched window', () => {
    const iframe = makeIframe();
    const handler = vi.fn();
    addMessageListener(iframe, handler);

    fireMessage(iframe.contentWindow, { type: 'craft:ready' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('ignores messages from any other window', () => {
    const iframe = makeIframe();
    const handler = vi.fn();
    addMessageListener(iframe, handler);

    fireMessage(window, { type: 'craft:ready' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('stops delivering once the returned remover runs', () => {
    const iframe = makeIframe();
    const handler = vi.fn();
    const remove = addMessageListener(iframe, handler);

    fireMessage(iframe.contentWindow, { type: 'craft:ready' });
    expect(handler).toHaveBeenCalledTimes(1);

    remove();
    fireMessage(iframe.contentWindow, { type: 'craft:ready' });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('BridgeQueue', () => {
  it('runs tasks strictly one after another', async () => {
    const queue = new BridgeQueue();
    const order: string[] = [];

    const first = queue.run(async () => {
      order.push('first-start');
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('first-end');
    });
    const second = queue.run(async () => {
      order.push('second-start');
    });

    expect(queue.busy).toBe(true);
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
    expect(queue.busy).toBe(false);
  });

  it('keeps the chain alive after a rejected task', async () => {
    const queue = new BridgeQueue();
    const seen: string[] = [];

    const failing = queue.run(async () => {
      seen.push('failing');
      throw new Error('boom');
    });
    const after = queue.run(async () => {
      seen.push('after');
      return 'ok';
    });

    await expect(failing).rejects.toThrow('boom');
    await expect(after).resolves.toBe('ok');
    expect(seen).toEqual(['failing', 'after']);
  });
});

describe('pending call bookkeeping', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('rejects a call once its timeout elapses', () => {
    const reject = vi.fn();
    const pending = emptyPending();
    pending.set('a', { resolve: vi.fn(), reject, timer: null });

    armCallTimeout(pending, 'a', 1000, 'too slow');
    vi.advanceTimersByTime(1000);

    expect(reject).toHaveBeenCalledWith(new Error('too slow'));
    expect(pending.has('a')).toBe(false);
  });

  it('clears the timeout when the call settles in time', () => {
    const reject = vi.fn();
    const pending = emptyPending();
    pending.set('a', { resolve: vi.fn(), reject, timer: null });

    armCallTimeout(pending, 'a', 1000, 'too slow');
    expect(settlePending(pending, 'a', { ok: true, value: 7 })).toBe(true);
    vi.advanceTimersByTime(2000);

    expect(reject).not.toHaveBeenCalled();
    expect(pending.has('a')).toBe(false);
  });

  it('ignores settle attempts for unknown ids', () => {
    expect(settlePending(emptyPending(), 'missing', { ok: true, value: 1 })).toBe(false);
  });

  it('rejects and clears every pending call', () => {
    const first = { resolve: vi.fn(), reject: vi.fn(), timer: null };
    const second = { resolve: vi.fn(), reject: vi.fn(), timer: null };
    const pending = emptyPending();
    pending.set('a', first);
    pending.set('b', second);

    rejectAllPending(pending, new Error('bridge lost'));

    expect(first.reject).toHaveBeenCalledWith(expect.any(Error));
    expect(second.reject).toHaveBeenCalledWith(expect.any(Error));
    expect(pending.size).toBe(0);
  });
});

describe('waitForApi', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves on a ready message that reports an API', async () => {
    const callbacks = new Set<(hasApi: boolean) => void>();
    const promise = waitForApi(callbacks, 1000, () => {}, () => {});

    callbacks.forEach((cb) => cb(true));
    await expect(promise).resolves.toEqual({ hasApi: true });
  });

  it('rejects when the editor reports no API and abandons in-flight calls', async () => {
    const callbacks = new Set<(hasApi: boolean) => void>();
    const rejectAll = vi.fn();
    const promise = waitForApi(callbacks, 1000, () => {}, rejectAll);

    callbacks.forEach((cb) => cb(false));
    await expect(promise).rejects.toThrow('did not expose its API');
    expect(rejectAll).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'The editor did not expose its API' }),
    );
  });

  it('rejects on timeout and forgets its listeners', async () => {
    const callbacks = new Set<(hasApi: boolean) => void>();
    const promise = waitForApi(callbacks, 1000, () => {}, () => {});
    const sizeBefore = callbacks.size;

    vi.advanceTimersByTime(1000);
    await expect(promise).rejects.toThrow('Timed out waiting for the editor bridge');
    expect(callbacks.size).toBeLessThan(sizeBefore);
  });

  it('only settles once even if ready fires twice', async () => {
    const callbacks = new Set<(hasApi: boolean) => void>();
    const promise = waitForApi(callbacks, 1000, () => {}, () => {});
    const resolved = vi.fn();
    promise.then(resolved);

    callbacks.forEach((cb) => cb(true));
    callbacks.forEach((cb) => cb(true));
    await promise;
    expect(resolved).toHaveBeenCalledTimes(1);
  });
});

describe('disposeBridge', () => {
  it('invokes the remover, fails in-flight calls and clears ready callbacks', () => {
    const removeListener = vi.fn();
    const pending = emptyPending();
    pending.set('a', { resolve: vi.fn(), reject: vi.fn(), timer: null });
    const callbacks = new Set<(hasApi: boolean) => void>([() => {}]);

    disposeBridge(pending, callbacks, removeListener, 'gone');

    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(pending.size).toBe(0);
    expect(callbacks.size).toBe(0);
  });

  it('detaches the window listener it registered', () => {
    const removeEventListener = vi.spyOn(window, 'removeEventListener');
    const iframe = makeIframe();
    const bridge = new FilmcraftBridge(iframe);

    expect(removeEventListener).not.toHaveBeenCalled();
    bridge.dispose();

    // The remover returned by addMessageListener must reach removeEventListener.
    expect(removeEventListener).toHaveBeenCalledWith('message', expect.any(Function));
  });
});

describe('FilmcraftBridge (regression for the shared bridge-base refactor)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('serves the privileged loamfilm:// frame', () => {
    expect(FILMCRAFT_FRAME_URL).toBe('loamfilm://app/index.html');
  });

  it('posts one tagged call per queued request with a unique id', async () => {
    const iframe = makeIframe();
    const bridge = new FilmcraftBridge(iframe);
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');

    // The queue serialises calls, so the first request goes out immediately and
    // the second waits for the first to settle.
    const first = bridge.call('info');
    await flushMicrotasks();
    expect(postMessage).toHaveBeenCalledWith(
      { type: 'filmcraft:call', id: 'fc-1', method: 'info', args: [] },
      '*',
    );

    fireMessage(iframe.contentWindow, {
      type: 'filmcraft:result',
      id: 'fc-1',
      ok: true,
      result: { fps: 30 },
    });
    await expect(first).resolves.toEqual({ fps: 30 });

    const second = bridge.call('commands');
    await flushMicrotasks();
    expect(postMessage).toHaveBeenCalledWith(
      { type: 'filmcraft:call', id: 'fc-2', method: 'commands', args: [] },
      '*',
    );

    fireMessage(iframe.contentWindow, { type: 'filmcraft:result', id: 'fc-2', ok: true, result: [] });
    await expect(second).resolves.toEqual([]);
    bridge.dispose();
  });

  it('rejects a call immediately when the iframe is not mounted', async () => {
    const iframe = makeIframe();
    vi.spyOn(iframe, 'contentWindow', 'get').mockReturnValue(null);
    const bridge = new FilmcraftBridge(iframe);

    await expect(bridge.call('info')).rejects.toThrow('iframe is not mounted');
    bridge.dispose();
  });

  it('rejects a call once it outlives the default timeout', async () => {
    vi.useFakeTimers();
    const iframe = makeIframe();
    const bridge = new FilmcraftBridge(iframe);

    const pending = bridge.call('inspect');
    const rejection = expect(pending).rejects.toThrow('Loam Video editor call timed out');
    await vi.advanceTimersByTimeAsync(DEFAULT_CALL_TIMEOUT_MS);
    await rejection;
    bridge.dispose();
  });

  it('routes a result from the iframe to the matching call', async () => {
    const iframe = makeIframe();
    const bridge = new FilmcraftBridge(iframe);

    const pending = bridge.call('info');
    await flushMicrotasks();
    fireMessage(iframe.contentWindow, {
      type: 'filmcraft:result',
      id: 'fc-1',
      ok: true,
      result: { fps: 30 },
    });

    await expect(pending).resolves.toEqual({ fps: 30 });
    bridge.dispose();
  });

  it('routes a failed result to the matching rejection', async () => {
    const iframe = makeIframe();
    const bridge = new FilmcraftBridge(iframe);

    const pending = bridge.call('execute');
    await flushMicrotasks();
    fireMessage(iframe.contentWindow, {
      type: 'filmcraft:result',
      id: 'fc-1',
      ok: false,
      error: 'no exporter',
    });

    await expect(pending).rejects.toThrow('no exporter');
    bridge.dispose();
  });

  it('ignores results that did not come from the iframe', async () => {
    const iframe = makeIframe();
    const bridge = new FilmcraftBridge(iframe);

    const pending = bridge.call('info');
    await flushMicrotasks();
    fireMessage(window, { type: 'filmcraft:result', id: 'fc-1', ok: true, result: 'injected' });
    fireMessage(iframe.contentWindow, { type: 'filmcraft:result', id: 'fc-1', ok: true, result: 'real' });

    await expect(pending).resolves.toBe('real');
    bridge.dispose();
  });

  it('surfaces editor readiness to waitForApi and onReady', async () => {
    const iframe = makeIframe();
    const bridge = new FilmcraftBridge(iframe);
    const onReady = vi.fn();

    bridge.onReady(onReady);
    const ready = bridge.waitForApi();
    fireMessage(iframe.contentWindow, { type: 'filmcraft:ready', hasApi: true });

    await expect(ready).resolves.toEqual({ hasApi: true });
    expect(onReady).toHaveBeenCalledWith(true);
    bridge.dispose();
  });

  it('stops delivering messages once disposed', () => {
    const iframe = makeIframe();
    const bridge = new FilmcraftBridge(iframe);
    const onReady = vi.fn();
    bridge.onReady(onReady);

    fireMessage(iframe.contentWindow, { type: 'filmcraft:ready', hasApi: true });
    expect(onReady).toHaveBeenCalledWith(true);

    bridge.dispose();
    // The listener must be detached: a later ready must not reach subscribers.
    fireMessage(iframe.contentWindow, { type: 'filmcraft:ready', hasApi: true });
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('rejects in-flight calls on dispose', async () => {
    const iframe = makeIframe();
    const bridge = new FilmcraftBridge(iframe);

    const pending = bridge.call('info');
    await flushMicrotasks();
    bridge.dispose();

    await expect(pending).rejects.toThrow('Loam Video bridge disposed');
  });

  it('broadcasts a no-API boot to every ready subscriber', () => {
    const iframe = makeIframe();
    const bridge = new FilmcraftBridge(iframe);
    const onReady = vi.fn();
    bridge.onReady(onReady);

    fireMessage(iframe.contentWindow, { type: 'filmcraft:ready', hasApi: false });
    expect(onReady).toHaveBeenCalledWith(false);
    bridge.dispose();
  });
});
