import { afterEach, describe, expect, it, vi } from 'vitest';
import { openCraftPresenter } from './presenter';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('openCraftPresenter', () => {
  it('opens a separate presenter window', () => {
    const focus = vi.fn();
    const open = vi.spyOn(window, 'open').mockReturnValue({ focus } as unknown as Window);
    const fallback = vi.fn();
    const result = openCraftPresenter('slides', fallback);

    expect(open).toHaveBeenCalledWith('loamcraft://deckcraft/index.html?loam=1', '_blank', 'width=1280,height=720');
    expect(focus).toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
    expect(result).toBe('window');
  });

  it('falls back to the inline fullscreen when popups are blocked', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const fallback = vi.fn();
    expect(openCraftPresenter('slides', fallback)).toBe('fullscreen');
    expect(fallback).toHaveBeenCalled();
  });
});
