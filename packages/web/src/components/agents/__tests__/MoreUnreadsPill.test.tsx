import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { Provider } from 'react-redux';

const { API } = vi.hoisted(() => ({ API: 'http://localhost:8787' }));
vi.mock('@/services/rpc', () => ({ getApiBase: () => API, getApiHeaders: async () => ({}) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { store } from '@/store';
import { nextUnreadIndex } from '../agentListFilter';
import { AgentSidebarList } from '../AgentSidebarList';
import type { AgentCardAgent } from '../AgentCard';

type IOEntry = { target: Element; isIntersecting: boolean };

/** Minimal IntersectionObserver stand-in that records observe() targets. */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  callback: IntersectionObserverCallback;
  root: Element | Document | null;
  observed: Element[] = [];
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.root = options?.root ?? null;
    FakeIntersectionObserver.instances.push(this);
  }
  observe(target: Element) { this.observed.push(target); }
  unobserve(target: Element) { this.observed = this.observed.filter((t) => t !== target); }
  disconnect() { this.observed = []; }
  takeRecords(): IntersectionObserverEntry[] { return []; }
  trigger(entries: IOEntry[]) {
    const mapped = entries.map((e) => ({ target: e.target, isIntersecting: e.isIntersecting })) as IntersectionObserverEntry[];
    this.callback(mapped, this as unknown as IntersectionObserver);
  }
}

const makeAgent = (id: string, name: string): AgentCardAgent => ({ id, name, emoji: '🤖' });

const noop = () => undefined;

function renderSidebar(
  agents: AgentCardAgent[],
  unreadById?: Record<string, { count: number }>,
) {
  return render(
    <Provider store={store}>
      <AgentSidebarList
        agents={agents}
        onSelect={noop}
        onNew={noop}
        onEdit={noop}
        onDuplicate={noop}
        onArchive={noop}
        unreadById={unreadById}
      />
    </Provider>,
  );
}

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  // A never-resolving fetch keeps the async sidebar effects from settling after
  // the test, which would otherwise trigger act() warnings.
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('nextUnreadIndex', () => {
  it('returns -1 for an empty list or when nothing is unread', () => {
    expect(nextUnreadIndex([], 0)).toBe(-1);
    expect(nextUnreadIndex([false, false], -1)).toBe(-1);
  });

  it('finds the first unread from the start (from = -1)', () => {
    expect(nextUnreadIndex([false, true, false], -1)).toBe(1);
    expect(nextUnreadIndex([true, false, false], -1)).toBe(0);
  });

  it('advances to the next unread after the anchor', () => {
    expect(nextUnreadIndex([true, false, true], 0)).toBe(2);
  });

  it('wraps back to the top when nothing is unread after the anchor', () => {
    expect(nextUnreadIndex([true, false, false], 2)).toBe(0);
    expect(nextUnreadIndex([true, false, false], 1)).toBe(0);
  });

  it('treats an out-of-range anchor as "start from the beginning"', () => {
    expect(nextUnreadIndex([false, true], 99)).toBe(1);
    expect(nextUnreadIndex([false, true], -5)).toBe(1);
  });

  it('returns the anchor when it is the only unread row', () => {
    expect(nextUnreadIndex([false, true, false], 1)).toBe(1);
  });
});

describe('AgentSidebarList chrome + More unreads pill', () => {
  it('renders the Agents header with a search toggle and a new-agent button', () => {
    renderSidebar([makeAgent('a', 'Alpha')]);
    expect(screen.getByText('Agents', { exact: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search agents' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New agent' })).toBeInTheDocument();
    // Search field is hidden until the search icon is toggled.
    expect(screen.queryByPlaceholderText('Search agents')).toBeNull();
    expect(screen.getByText('Marketplace')).toBeInTheDocument();
  });

  it('toggles and focuses the search field via the header search icon', () => {
    renderSidebar([makeAgent('a', 'Alpha')]);
    fireEvent.click(screen.getByRole('button', { name: 'Search agents' }));
    const input = screen.getByPlaceholderText('Search agents');
    expect(input).toBeInTheDocument();
    expect(input).toHaveFocus();
    // Clicking again with an empty query hides the field.
    fireEvent.click(screen.getByRole('button', { name: 'Search agents' }));
    expect(screen.queryByPlaceholderText('Search agents')).toBeNull();
  });

  it('hides the More unreads pill while every unread row is visible', () => {
    renderSidebar(
      [makeAgent('a', 'Alpha'), makeAgent('b', 'Beta')],
      { b: { count: 1 } },
    );
    expect(screen.queryByRole('button', { name: 'More unreads' })).toBeNull();
    const observer = FakeIntersectionObserver.instances.at(-1)!;
    const row = observer.observed[0];
    act(() => observer.trigger([{ target: row, isIntersecting: true }]));
    expect(screen.queryByRole('button', { name: 'More unreads' })).toBeNull();
  });

  it('shows the pill when an unread row is scrolled out of view and jumps to it', () => {
    renderSidebar(
      [makeAgent('a', 'Alpha'), makeAgent('b', 'Beta'), makeAgent('c', 'Gamma')],
      { b: { count: 1 } },
    );
    const observer = FakeIntersectionObserver.instances.at(-1)!;
    act(() => observer.trigger([{ target: observer.observed[0], isIntersecting: false }]));
    const pill = screen.getByRole('button', { name: 'More unreads' });
    expect(pill).toBeInTheDocument();
    fireEvent.click(pill);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('cycles to the next unread row on repeated clicks', () => {
    const agents = [makeAgent('a', 'Alpha'), makeAgent('b', 'Beta'), makeAgent('c', 'Gamma')];
    const { rerender } = renderSidebar(agents, { b: { count: 1 } });
    let observer = FakeIntersectionObserver.instances.at(-1)!;
    act(() => observer.trigger([{ target: observer.observed[0], isIntersecting: false }]));
    fireEvent.click(screen.getByRole('button', { name: 'More unreads' }));

    // A second agent becomes unread; the pill re-appears and advances past the first.
    rerender(
      <Provider store={store}>
        <AgentSidebarList
          agents={agents}
          onSelect={noop}
          onNew={noop}
          onEdit={noop}
          onDuplicate={noop}
          onArchive={noop}
          unreadById={{ b: { count: 1 }, c: { count: 2 } }}
        />
      </Provider>,
    );
    observer = FakeIntersectionObserver.instances.at(-1)!;
    // Beta visible, Gamma scrolled out -> pill visible.
    act(() => observer.trigger([
      { target: observer.observed[0], isIntersecting: true },
      { target: observer.observed[1], isIntersecting: false },
    ]));
    fireEvent.click(screen.getByRole('button', { name: 'More unreads' }));
    const lastCall = vi.mocked(Element.prototype.scrollIntoView).mock.calls.at(-1);
    expect(lastCall).toBeTruthy();
    // The jump target is the Gamma row (the second unread), not Beta again.
    const calls = vi.mocked(Element.prototype.scrollIntoView).mock.calls;
    expect(calls.length).toBe(2);
  });
});

describe('AgentSidebarList footer', () => {
  it('renders the user initials avatar and the Connect apps pill', () => {
    renderSidebar([makeAgent('a', 'Alpha')]);
    expect(screen.getByText('DU')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect apps' })).toBeInTheDocument();
  });
});
