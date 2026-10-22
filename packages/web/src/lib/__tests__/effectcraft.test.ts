import { afterEach, describe, expect, it, vi } from 'vitest';
import { EffectcraftBridge, EFFECTCRAFT_FRAME_URL } from '../effectcraft';

function makeIframe(): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  return iframe;
}

function emitFrom(
  iframe: HTMLIFrameElement,
  data: unknown,
): void {
  const event = new MessageEvent('message', {
    data,
    source: iframe.contentWindow as MessageEventSource,
  });
  window.dispatchEvent(event);
}

describe('EffectcraftBridge', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('exposes the privileged loameffect:// frame URL', () => {
    expect(EFFECTCRAFT_FRAME_URL).toBe('loameffect://app/index.html');
  });

  it('posts a typed call and resolves with the relay result', async () => {
    const iframe = makeIframe();
    const bridge = new EffectcraftBridge(iframe);
    const postSpy = vi.spyOn(iframe.contentWindow!, 'postMessage');

    const pending = bridge.call('execute', { command: 'effects.apply', params: { id: 'blur' } });
    expect(postSpy).toHaveBeenCalledTimes(1);
    const [message, origin] = postSpy.mock.calls[0]!;
    expect(origin).toBe('*');
    expect(message).toMatchObject({
      type: 'effectcraft:call',
      method: 'execute',
      args: [{ command: 'effects.apply', params: { id: 'blur' } }],
    });
    const id = (message as { id: string }).id;
    expect(typeof id).toBe('string');

    emitFrom(iframe, { type: 'effectcraft:result', id, ok: true, result: { applied: true } });
    await expect(pending).resolves.toEqual({ applied: true });
    bridge.dispose();
  });

  it('rejects when the relay reports a failed call', async () => {
    const iframe = makeIframe();
    const bridge = new EffectcraftBridge(iframe);
    const postSpy = vi.spyOn(iframe.contentWindow!, 'postMessage');

    const pending = bridge.call('screenshot');
    const id = (postSpy.mock.calls[0]![0] as { id: string }).id;
    emitFrom(iframe, { type: 'effectcraft:result', id, ok: false, error: 'engine not ready' });
    await expect(pending).rejects.toThrow('engine not ready');
    bridge.dispose();
  });

  it('exposes typed helpers that map onto engine methods', async () => {
    const iframe = makeIframe();
    const bridge = new EffectcraftBridge(iframe);
    const callSpy = vi.spyOn(bridge, 'call').mockResolvedValue(undefined);

    await bridge.execute('effects.apply', { id: 'blur' });
    await bridge.commands();
    await bridge.inspect();
    await bridge.info();
    await bridge.renderFrame({ frame: 1 });
    await bridge.screenshot();
    await bridge.addFile({ path: 'a.mp4' });
    await bridge.files();
    await bridge.readFile('out.png');
    await bridge.saveToBrowser({ name: 'out.png' });
    await bridge.flush();
    await bridge.request('effects.list');

    expect(callSpy).toHaveBeenNthCalledWith(1, 'execute', { command: 'effects.apply', params: { id: 'blur' } });
    expect(callSpy).toHaveBeenNthCalledWith(2, 'commands');
    expect(callSpy).toHaveBeenNthCalledWith(3, 'inspect');
    expect(callSpy).toHaveBeenNthCalledWith(4, 'info');
    expect(callSpy).toHaveBeenNthCalledWith(5, 'renderFrame', { frame: 1 });
    expect(callSpy).toHaveBeenNthCalledWith(6, 'screenshot');
    expect(callSpy).toHaveBeenNthCalledWith(7, 'addFile', { path: 'a.mp4' });
    expect(callSpy).toHaveBeenNthCalledWith(8, 'files');
    expect(callSpy).toHaveBeenNthCalledWith(9, 'readFile', 'out.png');
    expect(callSpy).toHaveBeenNthCalledWith(10, 'saveToBrowser', { name: 'out.png' });
    expect(callSpy).toHaveBeenNthCalledWith(11, 'flush');
    expect(callSpy).toHaveBeenNthCalledWith(12, 'request', 'effects.list');
    bridge.dispose();
  });

  it('resolves waitForApi when the relay announces readiness', async () => {
    const iframe = makeIframe();
    const bridge = new EffectcraftBridge(iframe);
    const ready = bridge.waitForApi(1000);
    emitFrom(iframe, { type: 'effectcraft:ready', hasApi: true });
    await expect(ready).resolves.toEqual({ hasApi: true });
    bridge.dispose();
  });

  it('waitForApi rejects after the timeout when the relay never answers', async () => {
    const iframe = makeIframe();
    const bridge = new EffectcraftBridge(iframe);
    await expect(bridge.waitForApi(20)).rejects.toThrow('Timed out');
    bridge.dispose();
  });

  it('dispose rejects pending calls', async () => {
    const iframe = makeIframe();
    const bridge = new EffectcraftBridge(iframe);
    const pending = bridge.call('commands');
    bridge.dispose();
    await expect(pending).rejects.toThrow('disposed');
  });

  it('dispose removes the message listener', () => {
    const iframe = makeIframe();
    const bridge = new EffectcraftBridge(iframe);
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    bridge.dispose();
    expect(removeSpy).toHaveBeenCalledWith('message', expect.any(Function));
  });
});
