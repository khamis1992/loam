import { describe, expect, it } from 'vitest';
import { acceptPreviewMessage, previewReply, PREVIEW_CHANNEL } from '../previewBridge';

const source = {} as MessageEventSource;
const nonce = 'ab'.repeat(16);
const origin = 'http://127.0.0.1:9';

function message(data: unknown, overrides: { source?: MessageEventSource | null; origin?: string } = {}) {
  return {
    source: overrides.source === undefined ? source : overrides.source,
    origin: overrides.origin ?? origin,
    data,
  };
}

describe('preview bridge', () => {
  it('accepts only the preview frame, its origin, and the lease nonce', () => {
    const ready = { channel: PREVIEW_CHANNEL, action: 'ready', nonce };
    expect(acceptPreviewMessage(message(ready), { source, origin, nonce })).toBe('ready');
    expect(acceptPreviewMessage(message(ready, { source: {} as MessageEventSource }), { source, origin, nonce })).toBeNull();
    expect(acceptPreviewMessage(message(ready, { source: null }), { source, origin, nonce })).toBeNull();
    expect(acceptPreviewMessage(message(ready, { origin: 'http://127.0.0.1:10' }), { source, origin, nonce })).toBeNull();
    expect(acceptPreviewMessage(message(ready, { origin: 'null' }), { source, origin: 'null', nonce })).toBeNull();
    expect(acceptPreviewMessage(message({ ...ready, nonce: 'cd'.repeat(16) }), { source, origin, nonce })).toBeNull();
    expect(acceptPreviewMessage(message({ channel: 'loam-mobile-sandbox', action: 'select', nonce }), { source, origin, nonce })).toBeNull();
    expect(acceptPreviewMessage(message({ channel: PREVIEW_CHANNEL, action: 'exec', nonce }), { source, origin, nonce })).toBeNull();
    expect(acceptPreviewMessage(message({ channel: PREVIEW_CHANNEL, action: 'ready', nonce, path: 'C:/secret' }), { source, origin, nonce })).toBeNull();
    expect(acceptPreviewMessage(message('ready'), { source, origin, nonce })).toBeNull();
  });

  it('replies to the preview origin and never to every origin', () => {
    const sent: unknown[][] = [];
    const target = { postMessage: (...args: unknown[]) => { sent.push(args); } };
    previewReply(target, origin, nonce);
    expect(sent).toEqual([[{ channel: PREVIEW_CHANNEL, action: 'bound', nonce }, origin]]);
    previewReply(target, '*', nonce);
    previewReply(target, 'null', nonce);
    previewReply(target, 'http://evil.example:9', nonce);
    previewReply(target, origin, 'short');
    expect(sent).toHaveLength(1);
  });
});
