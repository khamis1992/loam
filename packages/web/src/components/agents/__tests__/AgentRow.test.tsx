import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  AgentRow,
  agentRoleChip,
  agentRowDotState,
  type AgentRowProps,
} from '../AgentRow';
import { t } from '@/i18n/t';

const baseAgent = { id: 'agent_1', name: 'QA Verifier Bot' };

function renderRow(overrides: Partial<AgentRowProps> = {}) {
  const onClick = vi.fn();
  const onContextMenu = vi.fn();
  const props: AgentRowProps = {
    agent: { ...baseAgent },
    onClick,
    onContextMenu,
    ...overrides,
  };
  const utils = render(<AgentRow {...props} />);
  return { ...utils, onClick, onContextMenu };
}

describe('agentRoleChip', () => {
  it('prefers the mode, then the work mode, and is undefined when neither is set', () => {
    expect(agentRoleChip({ mode: 'build', workMode: 'loam' })).toBe('build');
    expect(agentRoleChip({ workMode: 'loam' })).toBe('loam');
    expect(agentRoleChip({ mode: '   ', workMode: 'loam' })).toBe('loam');
    expect(agentRoleChip({})).toBeUndefined();
  });
});

describe('agentRowDotState', () => {
  it('lets waiting win over unread, which wins over idle', () => {
    expect(agentRowDotState(true, 0)).toBe('waiting');
    expect(agentRowDotState(true, 5)).toBe('waiting');
    expect(agentRowDotState(false, 5)).toBe('unread');
    expect(agentRowDotState(false, 0)).toBe('idle');
  });
});

describe('AgentRow', () => {
  it('renders a 32px avatar labelled with the agent name', () => {
    const { container } = renderRow();
    const avatar = screen.getByRole('img', { name: 'QA Verifier Bot' });
    expect(avatar).toBeTruthy();
    expect((avatar as HTMLElement).style.width).toBe('32px');
    expect(container.querySelector('[data-agent-dot]')).toBeNull();
  });

  it('shows the last-message snippet as a single grey line', () => {
    const { container } = renderRow({ subtitle: 'All three posts from yesterday' });
    const snippet = container.querySelector('[data-agent-snippet]') as HTMLElement;
    expect(snippet).toBeTruthy();
    expect(snippet.getAttribute('data-agent-snippet')).toBe('last');
    expect(snippet.textContent).toBe('All three posts from yesterday');
    expect(snippet.className).toContain('text-text-tertiary');
    expect(snippet.className).toContain('truncate');
  });

  it('omits the snippet line when there is nothing to preview', () => {
    const { container } = renderRow();
    expect(container.querySelector('[data-agent-snippet]')).toBeNull();
  });

  it('renders the small grey role chip next to the name', () => {
    const { container } = renderRow({ agent: { ...baseAgent, mode: 'build' } });
    const chip = container.querySelector('[data-agent-chip]') as HTMLElement;
    expect(chip).toBeTruthy();
    expect(chip.getAttribute('data-agent-chip')).toBe('build');
    expect(chip.textContent).toBe('build');
    expect(chip.className).toContain('text-text-tertiary');
  });

  it('renders no role chip when the agent has no mode or work mode', () => {
    const { container } = renderRow();
    expect(container.querySelector('[data-agent-chip]')).toBeNull();
  });

  it('styles the snippet and dot orange when the agent waits for the user', () => {
    const { container } = renderRow({ subtitle: 'Sign in as...', waitingForYou: true });
    const snippet = container.querySelector('[data-agent-snippet]') as HTMLElement;
    expect(snippet.getAttribute('data-agent-snippet')).toBe('waiting');
    expect(snippet.textContent).toBe(t('Waiting for you: {message}', { message: 'Sign in as...' }));
    expect(snippet.className).toContain('text-func-warning');
    const dot = container.querySelector('[data-agent-dot]') as HTMLElement;
    expect(dot.getAttribute('data-agent-dot')).toBe('waiting');
    expect(dot.style.backgroundColor).toBe('var(--function-warning)');
  });

  it('shows a plain waiting label when there is no snippet yet', () => {
    const { container } = renderRow({ waitingForYou: true });
    expect(container.querySelector('[data-agent-snippet]')?.textContent).toBe(t('Waiting for you'));
  });

  it('renders a blue unread dot at the far right when there are unread messages', () => {
    const { container } = renderRow({ unreadCount: 3 });
    const dot = container.querySelector('[data-agent-dot]') as HTMLElement;
    expect(dot.getAttribute('data-agent-dot')).toBe('unread');
    expect(dot.style.backgroundColor).toBe('var(--icon-blue)');
    expect(dot.getAttribute('aria-label')).toBe(t('{count} unread', { count: 3 }));
  });

  it('prefers the waiting dot when both waiting and unread apply', () => {
    const { container } = renderRow({ waitingForYou: true, unreadCount: 3 });
    expect(container.querySelector('[data-agent-dot]')?.getAttribute('data-agent-dot')).toBe('waiting');
  });

  it('forwards clicks and context-menu events to the row callbacks', () => {
    const { onClick, onContextMenu } = renderRow();
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
    fireEvent.contextMenu(screen.getByRole('button'));
    expect(onContextMenu).toHaveBeenCalledTimes(1);
  });
});
