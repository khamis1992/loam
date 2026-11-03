// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatEvent, ToolUsedEvent } from '@shared/socket';
import { deriveTimelineSteps } from '@/components/chat/StepTimeline';

vi.mock('@/services/rpc', () => ({
  getApiBase: () => 'http://127.0.0.1:3939',
  getApiHeaders: async () => ({}),
}));
vi.mock('@/services/desktopApis', () => ({
  desktopEvents: { terminal: { onEvent: () => () => {} }, emit: vi.fn(), on: vi.fn() },
}));

import { ComputerPanel } from '../ComputerPanel';

function toolEvent(id: string, tool = 'terminal'): ToolUsedEvent {
  return { id, timestamp: Date.now(), type: 'toolUsed', tool, actionId: id, status: 'done' } as unknown as ToolUsedEvent;
}

function setup(nSteps: number, eventIndex = 0) {
  const events: ChatEvent[] = Array.from({ length: nSteps }, (_, i) => toolEvent(`t${i + 1}`));
  const steps = deriveTimelineSteps(events);
  const onSelectStep = vi.fn();
  const utils = render(
    <ComputerPanel
      event={events[eventIndex] as ToolUsedEvent}
      sessionId="s1"
      onClose={() => {}}
      steps={steps}
      onSelectStep={onSelectStep}
      live
    />,
  );
  return { onSelectStep, ...utils };
}

describe('ComputerPanel timeline scrubber (H2)', () => {
  afterEach(cleanup);

  it('hides the scrubber footer when there are fewer than two steps', () => {
    const { queryByTestId } = setup(1);
    expect(queryByTestId('computer-scrubber')).toBeNull();
  });

  it('shows position and steps forward from the first step', () => {
    const { onSelectStep } = setup(3, 0);
    expect(screen.getByTestId('computer-scrubber-position')).toHaveTextContent('1/3');
    const range = screen.getByTestId('computer-scrubber-range') as HTMLInputElement;
    expect(range.value).toBe('0');
    fireEvent.click(screen.getByRole('button', { name: 'Next step' }));
    expect(onSelectStep).toHaveBeenLastCalledWith(expect.objectContaining({ actionId: 't2' }));
    fireEvent.change(range, { target: { value: '2' } });
    expect(onSelectStep).toHaveBeenLastCalledWith(expect.objectContaining({ actionId: 't3' }));
  });

  it('shows the «مباشر» button when scrubbed back and jumps to the newest step', () => {
    const { onSelectStep } = setup(3, 0);
    const live = screen.getByTestId('computer-jump-live');
    expect(live).toBeTruthy();
    fireEvent.click(live);
    expect(onSelectStep).toHaveBeenLastCalledWith(expect.objectContaining({ actionId: 't3' }));
  });

  it('disables back at the first step and forward at the last step', () => {
    const { rerender } = setup(3, 0);
    expect(screen.getByRole('button', { name: 'Previous step' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Next step' }).hasAttribute('disabled')).toBe(false);
    cleanup();
    setup(3, 2);
    expect(screen.getByRole('button', { name: 'Next step' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Previous step' }).hasAttribute('disabled')).toBe(false);
  });
});
