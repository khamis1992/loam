import { describe, it, expect } from 'vitest';
import { KEYBINDINGS, KEYBINDING_GROUPS, bindingsByGroup, displayKeys, isApplePlatform } from '../keybindings';
import en from '@/i18n/en.json';
import ar from '@/i18n/ar.json';

describe('keybindings registry', () => {
  it('has unique ids', () => {
    const ids = KEYBINDINGS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every binding belongs to a declared group', () => {
    const groupIds = new Set(KEYBINDING_GROUPS.map((g) => g.id));
    for (const binding of KEYBINDINGS) {
      expect(groupIds.has(binding.group)).toBe(true);
    }
  });

  it('every group has at least one binding', () => {
    for (const group of KEYBINDING_GROUPS) {
      expect(bindingsByGroup(group.id).length).toBeGreaterThan(0);
    }
  });

  it('registers the Ctrl+K search shortcut that works today', () => {
    const openSearch = KEYBINDINGS.find((b) => b.id === 'general.open-search');
    expect(openSearch).toBeDefined();
    expect(openSearch?.keys).toBe('Ctrl+K');
    expect(openSearch?.group).toBe('general');
  });

  it('bindingsByGroup returns only that group in registry order', () => {
    const chat = bindingsByGroup('chat');
    expect(chat.map((b) => b.id)).toEqual(['chat.send', 'chat.newline']);
  });

  it('displayKeys picks macKeys on Apple platforms and falls back otherwise', () => {
    const ctrlBinding = KEYBINDINGS.find((b) => b.id === 'general.open-search')!;
    expect(displayKeys(ctrlBinding, true)).toBe('⌘K');
    expect(displayKeys(ctrlBinding, false)).toBe('Ctrl+K');
    const escBinding = KEYBINDINGS.find((b) => b.id === 'general.close')!;
    expect(displayKeys(escBinding, true)).toBe('Esc');
  });

  it('isApplePlatform is deterministic in jsdom (not Apple)', () => {
    expect(isApplePlatform()).toBe(false);
  });

  it('every description and group title has en+ar catalog keys', () => {
    const enCatalog: Record<string, string> = en;
    const arCatalog: Record<string, string> = ar;
    for (const binding of KEYBINDINGS) {
      expect(enCatalog[binding.description]).toBeTruthy();
      expect(arCatalog[binding.description]).toBeTruthy();
    }
    for (const group of KEYBINDING_GROUPS) {
      expect(enCatalog[group.title]).toBeTruthy();
      expect(arCatalog[group.title]).toBeTruthy();
    }
  });
});
