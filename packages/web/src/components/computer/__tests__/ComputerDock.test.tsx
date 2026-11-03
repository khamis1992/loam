// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatEvent, PlanUpdateEvent, ToolUsedEvent } from '@shared/socket';
import { humanizeToolName } from '@/components/chat/toolLabels';
import { t } from '@/i18n/t';

const API = 'http://127.0.0.1:3939';

vi.mock('@/services/rpc', () => ({
  getApiBase: () => API,
  getApiHeaders: async () => ({}),
}));

import { ComputerDock } from '../ComputerDock';

function toolEvent(id: string, tool = 'terminal'): ToolUsedEvent {
  return { id, timestamp: Date.now(), type: 'toolUsed', tool, actionId: id, status: 'running' } as unknown as ToolUsedEvent;
}

function planEvent(tasks: { title: string; status: string }[]): PlanUpdateEvent {
  return {
    id: 'plan-1', timestamp: Date.now(), type: 'planUpdate',
    tasks: tasks.map((t, i) => ({ ...t, startedAt: i })),
  } as unknown as PlanUpdateEvent;
}

describe('ComputerDock', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ frame: null, available: false }), { status: 200 })));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('renders nothing when there are no tool events yet', () => {
    const { container } = render(
      <ComputerDock sessionId="s1" taskId={null} events={[]} onOpen={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the current tool label and a plan-relative step counter', () => {
    const events: ChatEvent[] = [
      planEvent([{ title: 'Scan', status: 'done' }, { title: 'Probe', status: 'doing' }, { title: 'Report', status: 'doing' }]),
      toolEvent('t1'),
    ];
    render(<ComputerDock sessionId="s1" taskId={null} events={events} onOpen={() => {}} />);
    expect(screen.getByTestId('computer-dock')).toHaveTextContent(humanizeToolName('terminal'));
    expect(screen.getByTestId('computer-dock')).toHaveTextContent(t('Step {n} of {total}', { n: 2, total: 3 }));
  });

  it('falls back to a tool-count step label when no plan exists', () => {
    const events: ChatEvent[] = [toolEvent('t1'), toolEvent('t2', 'browser')];
    render(<ComputerDock sessionId="s1" taskId={null} events={events} onOpen={() => {}} />);
    expect(screen.getByTestId('computer-dock')).toHaveTextContent(humanizeToolName('browser'));
    expect(screen.getByTestId('computer-dock')).toHaveTextContent(t('Step {n}', { n: 2 }));
  });

  it('opens the panel on the matching tool when clicked or activated', async () => {
    const onOpen = vi.fn();
    const events: ChatEvent[] = [toolEvent('t1'), toolEvent('t2', 'browser')];
    render(<ComputerDock sessionId="s1" taskId={null} events={events} onOpen={onOpen} />);
    const dock = screen.getByTestId('computer-dock');
    fireEvent.click(dock);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 't2', type: 'toolUsed' }));
    fireEvent.keyDown(dock, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('renders the live thumbnail once a frame arrives (≤2s lag)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ frame: { source: 'screen', data: 'AAAA', mediaType: 'image/jpeg', at: 1, width: 4, height: 3, url: null, title: null } }),
      { status: 200 },
    )));
    const events: ChatEvent[] = [toolEvent('t1')];
    const { container } = render(<ComputerDock sessionId="s1" taskId="task-9" events={events} onOpen={() => {}} />);
    // alt="" thumbnails are presentational (no img role) — query the element directly.
    const img = await waitFor(() => {
      const el = container.querySelector('img');
      if (!el) throw new Error('thumbnail not rendered yet');
      return el;
    }, { timeout: 2500 });
    expect(img).toHaveAttribute('src', 'data:image/jpeg;base64,AAAA');
  });
});
