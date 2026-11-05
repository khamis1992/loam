import { describe, expect, it } from 'vitest';
import { parsePreviewSelectionMessage, previewSelectionScript, PREVIEW_SELECTION_SOURCE } from '../previewSelection';

describe('preview element selection', () => {
  it('builds an own frame script with a channel and same-origin delivery', () => {
    const script = previewSelectionScript('preview-1');
    expect(script).toContain('preview-1');
    expect(script).toContain('parent.postMessage(message, location.origin)');
    expect(script).not.toContain("parent.postMessage(message, '*')");
  });

  it('rejects messages from other channels and malformed payloads', () => {
    const message = { source: PREVIEW_SELECTION_SOURCE, channel: 'preview-1', action: 'select', element: { tagName: 'button', text: 'Reserve' } };
    expect(parsePreviewSelectionMessage(message, 'preview-1')).toEqual(message);
    expect(parsePreviewSelectionMessage(message, 'preview-2')).toBeNull();
    expect(parsePreviewSelectionMessage({ ...message, element: null }, 'preview-1')).toBeNull();
    expect(parsePreviewSelectionMessage({ ...message, action: 'navigate' }, 'preview-1')).toBeNull();
  });
});
