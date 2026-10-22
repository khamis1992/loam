import { describe, it, expect } from 'vitest';
import { isToggleAgentInfoPaneEvent } from '../agentInfoPaneShortcut';

describe('isToggleAgentInfoPaneEvent (Cmd/Ctrl+Shift+I)', () => {
  it('matches Ctrl+Shift+I', () => {
    expect(isToggleAgentInfoPaneEvent({ ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, key: 'i' })).toBe(true);
    expect(isToggleAgentInfoPaneEvent({ ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, key: 'I' })).toBe(true);
  });

  it('matches Cmd+Shift+I on macOS', () => {
    expect(isToggleAgentInfoPaneEvent({ ctrlKey: false, metaKey: true, shiftKey: true, altKey: false, key: 'i' })).toBe(true);
  });

  it('ignores Shift+I without Cmd/Ctrl', () => {
    expect(isToggleAgentInfoPaneEvent({ ctrlKey: false, metaKey: false, shiftKey: true, altKey: false, key: 'i' })).toBe(false);
  });

  it('ignores Ctrl+I without Shift and Alt variants', () => {
    expect(isToggleAgentInfoPaneEvent({ ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, key: 'i' })).toBe(false);
    expect(isToggleAgentInfoPaneEvent({ ctrlKey: true, metaKey: false, shiftKey: true, altKey: true, key: 'i' })).toBe(false);
  });

  it('ignores unrelated keys', () => {
    expect(isToggleAgentInfoPaneEvent({ ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, key: 'k' })).toBe(false);
  });
});
