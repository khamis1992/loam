import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ChatEvent, ToolUsedEvent } from '@shared/socket';
import { StepTimeline, deriveTimelineSteps } from '../StepTimeline';

function tool(actionId: string, tool: string, over: Partial<ToolUsedEvent> = {}): ToolUsedEvent {
  return {
    id: `e-${actionId}`,
    timestamp: 1_700_000_000_000,
    type: 'toolUsed',
    tool,
    actionId,
    status: 'success',
    ...over,
  };
}

function events(): ChatEvent[] {
  return [
    tool('a1', 'shell_run', { brief: 'npm test', status: 'running' }),
    tool('a1', 'shell_run', { status: 'success', message: { action: 'npm test' } }),
    tool('a2', 'file_edit', { brief: 'src/index.ts', argumentsDetail: { path: 'src/index.ts' } }),
    tool('a3', 'browser_click', { brief: 'Submit', status: 'running' }),
  ];
}

describe('StepTimeline', () => {
  it('derives one unified step per action from the event stream', () => {
    const steps = deriveTimelineSteps(events());
    expect(steps.map((s) => s.tool)).toEqual(['shell_run', 'file_edit', 'browser_click']);
    expect(steps[0]!.status).toBe('success');
    expect(steps[0]!.message?.action).toBe('npm test');
  });

  it('renders shell, file-edit and browser steps', () => {
    render(<StepTimeline events={events()} />);
    expect(screen.getByTestId('step-0')).toBeTruthy();
    expect(screen.getByTestId('step-1')).toBeTruthy();
    expect(screen.getByTestId('step-2')).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(3);
  });

  it('greys later steps and shows output when a step is clicked', () => {
    const onSelect = vi.fn();
    render(<StepTimeline events={events()} onSelect={onSelect} />);

    fireEvent.click(screen.getByTestId('step-1'));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0].tool).toBe('file_edit');

    expect(screen.getByTestId('step-1').getAttribute('aria-selected')).toBe('true');
    const future = screen.getByTestId('step-2');
    expect(future.getAttribute('aria-disabled')).toBe('true');
    expect(future.className).toContain('opacity-40');
    // The clicked step itself is not greyed.
    expect(screen.getByTestId('step-1').className).not.toContain('opacity-40');
  });

  it('shows the selected step state/output in the detail panel', () => {
    render(<StepTimeline events={events()} selectedActionId="a1" />);
    const detail = screen.getByTestId('step-detail');
    expect(detail.textContent).toContain('npm test');
  });

  it('renders nothing when there are no tool events', () => {
    const { container } = render(<StepTimeline events={[{ id: 'x', timestamp: 1, type: 'statusUpdate', agentStatus: 'running', brief: 'working' }]} />);
    expect(container.firstChild).toBeNull();
  });
});
