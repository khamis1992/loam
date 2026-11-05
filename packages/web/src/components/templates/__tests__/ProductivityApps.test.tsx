import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FocusTimerApp, HabitTrackerApp, KanbanApp } from '../ProductivityApps';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('FocusTimerApp', () => {
  it('starts, pauses, and resets the countdown', () => {
    vi.useFakeTimers();
    render(<FocusTimerApp />);

    expect(screen.getByTestId('focus-time').textContent).toBe('25:00');
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.getByTestId('focus-time').textContent).toBe('24:58');
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.getByTestId('focus-time').textContent).toBe('24:58');
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.getByTestId('focus-time').textContent).toBe('25:00');
  });
});

describe('HabitTrackerApp', () => {
  it('adds and toggles a habit', () => {
    render(<HabitTrackerApp />);

    fireEvent.change(screen.getByLabelText('New habit'), { target: { value: 'Morning walk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('Morning walk')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Morning walk' }));
    expect(localStorage.getItem('loam:habits')).toContain('Morning walk');
  });
});

describe('KanbanApp', () => {
  it('adds, moves, and deletes a task', () => {
    render(<KanbanApp />);

    fireEvent.change(screen.getByLabelText('New task'), { target: { value: 'Design review' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
    expect(screen.getByText('Design review')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Move Design review right' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move Design review right' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Design review' }));
    expect(screen.queryByText('Design review')).toBeNull();
  });
});
