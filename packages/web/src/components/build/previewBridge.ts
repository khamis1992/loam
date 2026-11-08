import { previewFrame } from './previewFrame';

export const PREVIEW_CHANNEL = 'loam-build-preview';

const PREVIEW_ACTIONS = ['ready'] as const;
type PreviewAction = (typeof PREVIEW_ACTIONS)[number];

export interface PreviewBinding {
  source: MessageEventSource | null;
  origin: string;
  nonce: string;
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function allowedNonce(nonce: string): boolean {
  return /^[a-f0-9]{32}$/.test(nonce);
}

export function acceptPreviewMessage(
  event: { source: MessageEventSource | null; origin: string; data: unknown },
  binding: PreviewBinding,
): PreviewAction | null {
  if (!binding.source || event.source !== binding.source) return null;
  if (!allowedNonce(binding.nonce)) return null;
  if (binding.origin === '' || binding.origin === '*' || binding.origin === 'null') return null;
  if (event.origin !== binding.origin) return null;
  const data = record(event.data);
  if (!data) return null;
  const keys = Object.keys(data).sort();
  if (keys.length !== 3 || keys[0] !== 'action' || keys[1] !== 'channel' || keys[2] !== 'nonce') return null;
  if (data.channel !== PREVIEW_CHANNEL || data.nonce !== binding.nonce || data.action !== 'ready') return null;
  return 'ready';
}

export function previewReply(
  target: { postMessage(message: unknown, origin: string): void },
  origin: string,
  nonce: string,
): void {
  if (!allowedNonce(nonce)) return;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return;
  }
  if (parsed.protocol !== 'http:' || parsed.origin !== origin || parsed.port === '') return;
  const host = parsed.hostname.toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return;
  target.postMessage({ channel: PREVIEW_CHANNEL, action: 'bound', nonce }, parsed.origin);
}

export function bindPreviewMessages(
  node: HTMLIFrameElement | null,
  pageOrigin: string,
  url: string,
  nonce: string,
): () => void {
  const frame = previewFrame(url, pageOrigin);
  if (!frame || !node?.contentWindow) return () => undefined;
  const origin = new URL(frame.src).origin;
  const onMessage = (event: MessageEvent): void => {
    const action = acceptPreviewMessage(event, { source: node.contentWindow, origin, nonce });
    if (action !== 'ready' || !node.contentWindow) return;
    previewReply(node.contentWindow, origin, nonce);
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}
