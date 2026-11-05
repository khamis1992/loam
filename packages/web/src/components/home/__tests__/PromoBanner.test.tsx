import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PromoBanner } from '../PromoBanner';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('PromoBanner', () => {
  it('rotates between video and game development and opens the selected target', () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    render(<PromoBanner onSelect={onSelect} />);

    fireEvent.click(screen.getByRole('button', { name: 'Create your Video' }));
    expect(onSelect).toHaveBeenCalledWith('video');

    act(() => { vi.advanceTimersByTime(6000); });
    fireEvent.click(screen.getByRole('button', { name: 'Game development' }));
    expect(onSelect).toHaveBeenCalledWith('game-development');

    act(() => { vi.advanceTimersByTime(6000); });
    expect(screen.getByRole('button', { name: 'Create your Video' })).toBeTruthy();
  });
});
