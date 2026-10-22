import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PinnedAgentGrid } from '../PinnedAgentGrid';
import type { AgentCardAgent } from '../AgentCard';

const make = (id: string, name: string, extra: Partial<AgentCardAgent> = {}): AgentCardAgent => ({
  id,
  name,
  ...extra,
});

const agents: AgentCardAgent[] = [
  make('a', 'Aster', { mode: 'research', avatarColor: 'blue' }),
  make('b', 'Beta', { mode: 'coding', avatarColor: 'green' }),
  make('c', 'Comet', { description: 'Reads long documents carefully', avatarColor: 'violet' }),
];

const renderGrid = (overrides: Partial<React.ComponentProps<typeof PinnedAgentGrid>> = {}) => {
  const onSelect = vi.fn();
  const onContextMenu = vi.fn();
  const onReorder = vi.fn();
  const props = {
    agents,
    onSelect,
    onContextMenu,
    onReorder,
    ...overrides,
  };
  return { ...render(<PinnedAgentGrid {...props} />), onSelect, onContextMenu, onReorder };
};

const tileIds = () => screen.getAllByRole('button').map((b) => b.getAttribute('data-pinned-id'));

describe('PinnedAgentGrid rendering', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders pinned agents as a 3-column grid of avatar tiles', () => {
    renderGrid();
    const grid = document.querySelector('.grid.grid-cols-3');
    expect(grid).toBeInTheDocument();
    expect(tileIds()).toEqual(['a', 'b', 'c']);
    expect(screen.getAllByRole('img')).toHaveLength(3);
  });

  it('puts the agent name under the avatar and shows the role subtitle', () => {
    renderGrid();
    expect(screen.getByText('Aster')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByText('Comet')).toBeInTheDocument();
    // Role falls back to the description when no mode chip exists.
    expect(screen.getByText('research')).toBeInTheDocument();
    expect(screen.getByText('coding')).toBeInTheDocument();
    expect(screen.getByText('Reads long documents carefully')).toBeInTheDocument();
  });

  it('renders large 48px avatars', () => {
    renderGrid();
    const avatar = screen.getByRole('img', { name: 'Aster' });
    expect(avatar).toHaveStyle({ width: '48px', height: '48px' });
  });

  it('fills the selected tile with the grey selected style', () => {
    renderGrid({ selectedId: 'b' });
    const selected = screen.getByRole('button', { name: /Beta/ });
    expect(selected).toHaveAttribute('aria-current', 'true');
    expect(selected).toHaveClass('bg-fill-tsp');
    expect(selected).toHaveClass('rounded-control');
    const others = screen.getByRole('button', { name: /Aster/ });
    expect(others).not.toHaveClass('bg-fill-tsp');
    expect(others).toHaveClass('hover:bg-fill-hover');
  });

  it('shows an unread dot on the avatar corner only for unread agents', () => {
    renderGrid({ unreadById: { b: { count: 2 } } });
    expect(screen.getByTitle('2 unread')).toBeInTheDocument();
    expect(screen.getAllByTitle('2 unread')).toHaveLength(1);
  });

  it('keeps the context menu wired to each tile', () => {
    const { onContextMenu } = renderGrid();
    fireEvent.contextMenu(screen.getByRole('button', { name: /Comet/ }));
    expect(onContextMenu).toHaveBeenCalledTimes(1);
  });
});

describe('PinnedAgentGrid pin ordering', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('selects an agent on click', () => {
    const { onSelect } = renderGrid();
    fireEvent.click(screen.getByRole('button', { name: /Aster/ }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
  });

  it('reorders with Alt+ArrowUp / Alt+ArrowDown and persists the new order', () => {
    const { onReorder } = renderGrid();
    fireEvent.keyDown(screen.getByRole('button', { name: /Beta/ }), { key: 'ArrowUp', altKey: true });
    expect(onReorder).toHaveBeenCalledWith(['b', 'a', 'c']);
    expect(tileIds()).toEqual(['b', 'a', 'c']);

    fireEvent.keyDown(screen.getByRole('button', { name: /Aster/ }), { key: 'ArrowDown', altKey: true });
    expect(onReorder).toHaveBeenCalledWith(['b', 'c', 'a']);
    expect(tileIds()).toEqual(['b', 'c', 'a']);
  });

  it('ignores reorder shortcuts without Alt and at the list edges', () => {
    const { onReorder } = renderGrid();
    fireEvent.keyDown(screen.getByRole('button', { name: /Beta/ }), { key: 'ArrowUp' });
    expect(onReorder).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('button', { name: /Aster/ }), { key: 'ArrowUp', altKey: true });
    expect(onReorder).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('button', { name: /Comet/ }), { key: 'ArrowDown', altKey: true });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('reorders tiles with pointer drag and suppresses the trailing click', () => {
    // jsdom has no elementFromPoint; stub it to return the drop target tile.
    const hadElementFromPoint = 'elementFromPoint' in document;
    const original = document.elementFromPoint;
    const spy = vi.fn(() => screen.getByRole('button', { name: /Beta/ }) as HTMLElement);
    document.elementFromPoint = spy as unknown as typeof document.elementFromPoint;
    try {
      const { onReorder, onSelect } = renderGrid();
      const aster = screen.getByRole('button', { name: /Aster/ });
      fireEvent.pointerDown(aster, { button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(window, { clientX: 60, clientY: 60 });
      fireEvent.pointerUp(window);
      expect(onReorder).toHaveBeenCalledWith(['b', 'a', 'c']);
      expect(tileIds()).toEqual(['b', 'a', 'c']);
      fireEvent.click(aster);
      expect(onSelect).not.toHaveBeenCalled();
    } finally {
      if (hadElementFromPoint) {
        document.elementFromPoint = original;
      } else {
        delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
      }
    }
  });

  it('follows the persisted order when the agents prop changes', async () => {
    const { rerender } = renderGrid();
    rerender(
      <PinnedAgentGrid
        agents={[agents[1], agents[2], agents[0]]}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
        onReorder={vi.fn()}
      />,
    );
    await waitFor(() => expect(tileIds()).toEqual(['b', 'c', 'a']));
  });
});
