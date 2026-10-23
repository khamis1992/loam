import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// The Composer reads connectors/skills from the backend on mount; keep it quiet.
vi.mock('@/services/rpc', () => ({
  getApiBase: () => 'http://localhost:8787',
  getApiHeaders: async () => ({}),
}));
vi.mock('@/services/projectContextApi', () => ({
  fetchProjectBranch: async () => ({ branch: 'main' }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

import { Composer } from '../Composer';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('Composer Knowledge Garden chip (N3)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/connectors')) return json({ connectors: [] });
      if (url.includes('/api/skills')) return json({ skills: [] });
      if (url.includes('/api/mcp/status')) return json({ servers: [] });
      return json({});
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function renderComposer(props: Partial<React.ComponentProps<typeof Composer>> = {}) {
    const onToggleKnowledge = props.onToggleKnowledge ?? vi.fn();
    render(
      <Composer
        onSend={vi.fn()}
        onToggleKnowledge={onToggleKnowledge}
        {...props}
      />,
    );
    return { onToggleKnowledge };
  }

  it('renders the chip and reports the off state', () => {
    renderComposer({ knowledgeOn: false });
    const chip = screen.getByRole('button', { name: /Knowledge Garden/ });
    expect(chip).toBeTruthy();
    expect(chip.getAttribute('aria-pressed')).toBe('false');
  });

  it('reports the on state when the run opted into the garden', () => {
    renderComposer({ knowledgeOn: true });
    const chip = screen.getByRole('button', { name: /Knowledge Garden/ });
    expect(chip.getAttribute('aria-pressed')).toBe('true');
  });

  it('fires the toggle handler when the user switches it', () => {
    const { onToggleKnowledge } = renderComposer({ knowledgeOn: false });
    fireEvent.click(screen.getByRole('button', { name: /Knowledge Garden/ }));
    expect(onToggleKnowledge).toHaveBeenCalledTimes(1);
  });

  it('keeps the sibling approve-for-me chip independent of the garden chip', () => {
    renderComposer({ knowledgeOn: false, approveForMe: false });
    const garden = screen.getByRole('button', { name: /Knowledge Garden/ });
    const approve = screen.getByRole('button', { name: /Approve for me/ });
    // Two distinct controls: the garden chip must not drive the approve chip.
    expect(garden).not.toBe(approve);
    expect(garden.getAttribute('aria-pressed')).toBe('false');
    expect(approve.getAttribute('aria-pressed')).toBe('false');
    // Toggling the garden chip leaves the approve chip untouched.
    fireEvent.click(garden);
    expect(approve.getAttribute('aria-pressed')).toBe('false');
  });
});
