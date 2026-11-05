export const PREVIEW_SELECTION_SOURCE = 'loam-preview-selection';

export interface PreviewSelectionMessage {
  source: typeof PREVIEW_SELECTION_SOURCE;
  channel: string;
  action: 'select';
  element: { tagName: string; id?: string; text?: string };
}

export function previewSelectionScript(channel: string): string {
  return `(() => {
    const channel = ${JSON.stringify(channel)};
    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target.closest('[data-loam-id],button,a,[role="button"],input,select,textarea') : null;
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      const message = {
        source: ${JSON.stringify(PREVIEW_SELECTION_SOURCE)},
        channel,
        action: 'select',
        element: {
          tagName: target.tagName.toLowerCase(),
          ...(target.id ? { id: target.id } : {}),
          text: (target.textContent || '').trim().slice(0, 200),
        },
      };
      parent.postMessage(message, location.origin);
    }, true);
  })();`;
}

export function parsePreviewSelectionMessage(value: unknown, channel: string, origin?: string): PreviewSelectionMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (message.source !== PREVIEW_SELECTION_SOURCE || message.channel !== channel || message.action !== 'select') return null;
  if (origin && message.origin !== undefined && message.origin !== origin) return null;
  const element = message.element;
  if (!element || typeof element !== 'object' || Array.isArray(element)) return null;
  const record = element as Record<string, unknown>;
  if (typeof record.tagName !== 'string' || !record.tagName) return null;
  return {
    source: PREVIEW_SELECTION_SOURCE,
    channel,
    action: 'select',
    element: {
      tagName: record.tagName,
      ...(typeof record.id === 'string' ? { id: record.id } : {}),
      ...(typeof record.text === 'string' ? { text: record.text.slice(0, 200) } : {}),
    },
  };
}
