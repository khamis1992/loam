import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';

import { EventList } from '../EventList';
import {
  createHibernationTestHook,
  isHibernationHookAvailable,
  resolveHibernationReady,
  type HibernationHookController,
} from '../hibernationTestHook';
import {
  getDerivedChatState,
  hasDerivedChatState,
  resetDerivedChatState,
} from '../hibernationStore';
import type { ChatEvent } from '@shared/socket';

const message = (id: string, content: string): ChatEvent => ({
  id,
  type: 'chat',
  timestamp: 0,
  sender: 'assistant',
  messageType: 'text',
  content,
  attachments: [],
  deliveryKind: 'result',
} as unknown as ChatEvent);

const manyEvents = (count: number) =>
  Array.from({ length: count }, (_, i) => message(`e${i}`, `message body ${i}`.repeat(4)));

beforeEach(() => {
  resetDerivedChatState();
  delete (window as unknown as { __loamHibernation?: unknown }).__loamHibernation;
  vi.restoreAllMocks();
});

describe('EventList hibernation', () => {
  it('renders every message row when active', () => {
    render(<EventList events={manyEvents(5)} sessionId="s1" />);
    expect(screen.getByTestId('event-list')).toHaveAttribute('data-hibernated', 'false');
    expect(screen.getByText(/message body 0/)).toBeInTheDocument();
    expect(screen.getByText(/message body 4/)).toBeInTheDocument();
  });

  it('unmounts the rendered transcript and shows the status frame when hibernated', () => {
    render(<EventList events={manyEvents(2000)} sessionId="s1" hibernated />);

    const list = screen.getByTestId('event-list');
    expect(list).toHaveAttribute('data-hibernated', 'true');
    // The canonical count is preserved so the fold can be rebuilt on wake.
    expect(list).toHaveAttribute('data-event-count', '2000');
    // No rendered message rows remain.
    expect(screen.queryByText(/message body 0/)).toBeNull();
    expect(screen.queryByText(/message body 1999/)).toBeNull();
    expect(list.querySelectorAll('li')).toHaveLength(1);
  });

  it('keeps the canonical events reachable from props (they are not mutated)', () => {
    const events = manyEvents(3);
    const { rerender } = render(<EventList events={events} sessionId="s1" />);
    rerender(<EventList events={events} sessionId="s1" hibernated />);
    expect(events).toHaveLength(3);
  });
});

describe('hibernationTestHook', () => {
  const setup = () => {
    const hibernated = new Set<string>();
    const dispatched: unknown[] = [];
    const hook: HibernationHookController = createHibernationTestHook({
      dispatch: (action) => { dispatched.push(action); },
      isHibernated: (id) => hibernated.has(id),
      setHibernated: (id, value) => { if (value) hibernated.add(id); else hibernated.delete(id); },
      hibernateDaemon: async () => undefined,
      wakeDaemon: async () => undefined,
    });
    return { hook, dispatched, isHibernated: (id: string) => hibernated.has(id) };
  };

  it('reports unavailable until a view attaches it', () => {
    expect(isHibernationHookAvailable()).toBe(false);
  });

  it('resolves ready() once a view attaches it', async () => {
    const { hook } = setup();
    const pending = hook.ready();
    (window as unknown as { __loamHibernation?: HibernationHookController }).__loamHibernation = hook;
    resolveHibernationReady();
    await expect(pending).resolves.toBeUndefined();
    expect(isHibernationHookAvailable()).toBe(true);
  });

  it('injectEvents appends canonical events and builds the derived fold', () => {
    const { hook, dispatched } = setup();
    hook.injectEvents('s1', manyEvents(4));
    // One appendEvent per canonical event.
    expect(dispatched).toHaveLength(4);
    expect(hasDerivedChatState('s1')).toBe(true);
    expect(getDerivedChatState('s1')?.entries).toBe(4);
    expect(hook.getState('s1').sessionId).toBe('s1');
  });

  it('hibernate releases the derived fold and flips the flag', async () => {
    const { hook, isHibernated } = setup();
    hook.injectEvents('s1', manyEvents(4));
    expect(isHibernated('s1')).toBe(false);

    const result = await hook.hibernate('s1');
    expect(result).toMatchObject({ released: true, entries: 4 });
    expect(result.bytes).toBeGreaterThan(0);
    expect(hasDerivedChatState('s1')).toBe(false);
    expect(isHibernated('s1')).toBe(true);
    expect(hook.getState('s1').hibernated).toBe(true);
  });

  it('wake clears the flag without touching the canonical events', async () => {
    const { hook, isHibernated } = setup();
    hook.injectEvents('s1', manyEvents(2));
    await hook.hibernate('s1');
    expect(isHibernated('s1')).toBe(true);

    await hook.wake('s1');
    expect(isHibernated('s1')).toBe(false);
    expect(hook.getState('s1').hibernated).toBe(false);
  });

  it('surfaces a daemon refusal as a store error instead of a silent release', async () => {
    const dispatched: unknown[] = [];
    const hook = createHibernationTestHook({
      dispatch: (action) => { dispatched.push(action); },
      isHibernated: () => false,
      setHibernated: () => undefined,
      hibernateDaemon: async () => { throw new Error('active-work'); },
    });
    hook.injectEvents('s1', manyEvents(2));

    await expect(hook.hibernate('s1')).rejects.toThrow('active-work');
    expect(hasDerivedChatState('s1')).toBe(true);
    expect(dispatched.some((a) => (a as { type?: string }).type === 'chat/setError')).toBe(true);
  });

  it('reset drops every session and clears the current session', async () => {
    const { hook } = setup();
    hook.injectEvents('s1', manyEvents(1));
    hook.injectEvents('s2', manyEvents(1));
    hook.reset();
    expect(hasDerivedChatState('s1')).toBe(false);
    expect(hook.getState().sessionId).toBeNull();
  });

  it('drives a real EventList unmount through the hook', async () => {
    const { hook } = setup();
    const events = manyEvents(300);
    const { rerender } = render(<EventList events={events} sessionId="s1" />);
    expect(screen.getByText(/message body 0/)).toBeInTheDocument();

    await act(async () => {
      hook.injectEvents('s1', events);
      await hook.hibernate('s1');
    });
    rerender(<EventList events={events} sessionId="s1" hibernated />);
    expect(screen.getByTestId('event-list')).toHaveAttribute('data-hibernated', 'true');
    expect(screen.queryByText(/message body 0/)).toBeNull();
  });

  it('opens a ~2000-message chat fixture, triggers hibernation via test hook, and wake preserves draft', async () => {
    const { hook } = setup();
    const events = manyEvents(2000);
    let draft = 'persisted user draft';
    const onFirstInput = vi.fn((next: string) => { draft = next; });

    const { rerender } = render(
      <div>
        <EventList events={events} sessionId="s1" />
      </div>,
    );
    expect(screen.getByTestId('event-list')).toHaveAttribute('data-hibernated', 'false');
    expect(screen.getByText(/message body 0/)).toBeInTheDocument();

    await act(async () => {
      hook.injectEvents('s1', events);
      await hook.hibernate('s1');
    });

    rerender(
      <div>
        <EventList events={events} sessionId="s1" hibernated />
      </div>,
    );
    const list = screen.getByTestId('event-list');
    expect(list).toHaveAttribute('data-hibernated', 'true');
    expect(list).toHaveAttribute('data-event-count', '2000');
    expect(screen.queryByText(/message body 0/)).toBeNull();

    await act(async () => {
      await hook.wake('s1');
      onFirstInput(draft);
    });

    rerender(
      <div>
        <EventList events={events} sessionId="s1" hibernated={false} />
      </div>,
    );
    expect(screen.getByTestId('event-list')).toHaveAttribute('data-hibernated', 'false');
    expect(screen.getByText(/message body 0/)).toBeInTheDocument();
    expect(draft).toBe('persisted user draft');
  }, 15_000);
});
