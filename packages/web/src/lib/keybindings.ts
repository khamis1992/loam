/**
 * Static registry of keyboard shortcuts that work in the app today.
 * Kept truthful to actual handlers (Sidebar, SearchDialog, Composer,
 * workspace sheet Editor); the Settings > Shortcuts pane renders this list.
 */

export type KeybindingGroupId = 'general' | 'search' | 'chat' | 'spreadsheet';

export interface Keybinding {
  /** Stable identifier, e.g. 'search.open'. */
  id: string;
  /** Registry group used to render sections. */
  group: KeybindingGroupId;
  /** Display combo on Windows/Linux, e.g. 'Ctrl+K'. */
  keys: string;
  /** Display combo on macOS, e.g. '⌘K'; falls back to `keys`. */
  macKeys?: string;
  /** English source string; also the i18n key passed to t(). */
  description: string;
}

export interface KeybindingGroup {
  id: KeybindingGroupId;
  /** English source string; also the i18n key passed to t(). */
  title: string;
}

export const KEYBINDING_GROUPS: readonly KeybindingGroup[] = [
  { id: 'general', title: 'General' },
  { id: 'search', title: 'Search' },
  { id: 'chat', title: 'Chat' },
  { id: 'spreadsheet', title: 'Spreadsheet' },
];

export const KEYBINDINGS: readonly Keybinding[] = [
  // General
  { id: 'general.open-search', group: 'general', keys: 'Ctrl+K', macKeys: '⌘K', description: 'Open search' },
  { id: 'general.close', group: 'general', keys: 'Esc', description: 'Close dialogs and menus' },
  // Search
  { id: 'search.next', group: 'search', keys: '↓', description: 'Move to the next result' },
  { id: 'search.previous', group: 'search', keys: '↑', description: 'Move to the previous result' },
  { id: 'search.open-result', group: 'search', keys: 'Enter', description: 'Open the selected result' },
  // Chat
  { id: 'chat.send', group: 'chat', keys: 'Enter', description: 'Send message' },
  { id: 'chat.newline', group: 'chat', keys: 'Shift+Enter', description: 'New line in message' },
  // Spreadsheet
  { id: 'sheet.save', group: 'spreadsheet', keys: 'Ctrl+S', macKeys: '⌘S', description: 'Save sheet' },
  { id: 'sheet.move', group: 'spreadsheet', keys: '↑ ↓ ← →', description: 'Move cell selection' },
  { id: 'sheet.next-column', group: 'spreadsheet', keys: 'Tab', description: 'Move to the next column' },
  { id: 'sheet.edit', group: 'spreadsheet', keys: 'Enter', description: 'Edit the selected cell' },
  { id: 'sheet.clear', group: 'spreadsheet', keys: 'Delete', description: 'Clear the selected cell' },
];

/** True when running on an Apple platform (⌘ replaces Ctrl). */
export function isApplePlatform(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    /mac|iphone|ipad|ipod/i.test(navigator.userAgent || navigator.platform || '')
  );
}

/** Display combo for the current platform. */
export function displayKeys(binding: Keybinding, apple = isApplePlatform()): string {
  return apple && binding.macKeys ? binding.macKeys : binding.keys;
}

/** All bindings of one group, in registry order. */
export function bindingsByGroup(group: KeybindingGroupId): readonly Keybinding[] {
  return KEYBINDINGS.filter((b) => b.group === group);
}
