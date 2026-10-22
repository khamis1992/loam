import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import {
  AgentAvatar,
  AVATAR_COLORS,
  AVATAR_PALETTE,
  normalizeAvatarColor,
  resolveAvatarColor,
} from '../AgentAvatar';

const AGENT_IDS = Array.from({ length: 20 }, (_, i) => `agent_${i + 1}`);

/** The shape fill color of the rendered avatar (the `<g fill>` on the SVG). */
function fillOf(container: HTMLElement): string {
  return container.querySelector('svg g')?.getAttribute('fill') ?? '';
}

/** The centered mark drawn inside the avatar. */
function markOf(container: HTMLElement): string {
  return container.querySelector('svg text')?.textContent ?? '';
}

describe('AgentAvatar color palette', () => {
  it('exposes 16 Grok-Bot-like color tokens', () => {
    expect(AVATAR_COLORS).toHaveLength(16);
    for (const token of AVATAR_COLORS) {
      expect(AVATAR_PALETTE[token].base).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('maps the grey alias onto the canonical gray token', () => {
    expect(normalizeAvatarColor('grey')).toBe('gray');
    expect(normalizeAvatarColor('SLATE')).toBe('slate');
    expect(normalizeAvatarColor('nope')).toBeUndefined();
  });

  it('derives a deterministic color from the agent id', () => {
    expect(resolveAvatarColor('agent_7')).toBe(resolveAvatarColor('agent_7'));
    expect(resolveAvatarColor('agent_7')).not.toBe(resolveAvatarColor('agent_8'));
  });

  it('spreads 20 different ids across at least 12 distinct colors', () => {
    const fills = AGENT_IDS.map((id) => {
      const { container } = render(<AgentAvatar name="Agent" id={id} />);
      return fillOf(container);
    });
    expect(new Set(fills).size).toBeGreaterThanOrEqual(12);
  });

  it('keeps colors distinct for same-named agents with different ids', () => {
    const { container: a } = render(<AgentAvatar name="Agent" id="agent_a" />);
    const { container: b } = render(<AgentAvatar name="Agent" id="agent_b" />);
    expect(fillOf(a)).not.toBe(fillOf(b));
  });
});

describe('AgentAvatar explicit avatar color', () => {
  it('respects an explicit avatarColor over the hash', () => {
    const { container } = render(<AgentAvatar name="Agent" id="agent_1" avatarColor="teal" />);
    expect(fillOf(container)).toBe(AVATAR_PALETTE.teal.base);
  });

  it('respects an aliased avatarColor token', () => {
    const { container } = render(<AgentAvatar name="Agent" id="agent_1" avatarColor="grey" />);
    expect(fillOf(container)).toBe(AVATAR_PALETTE.gray.base);
  });

  it('falls back to the hashed color when the token is unknown', () => {
    const { container } = render(<AgentAvatar name="Agent" id="agent_3" avatarColor="chartreuse" />);
    expect(fillOf(container)).toBe(AVATAR_PALETTE[resolveAvatarColor('agent_3')].base);
  });
});

describe('AgentAvatar emoji mark', () => {
  it('does not let the default robot emoji override the color', () => {
    const { container } = render(<AgentAvatar name="Agent" id="agent_5" emoji="🤖" />);
    expect(fillOf(container)).toBe(AVATAR_PALETTE[resolveAvatarColor('agent_5')].base);
    expect(markOf(container)).toBe('A');
  });

  it('renders a custom emoji on top of the colored mark', () => {
    const { container } = render(<AgentAvatar name="Agent" id="agent_5" emoji="🦊" />);
    expect(fillOf(container)).toBe(AVATAR_PALETTE[resolveAvatarColor('agent_5')].base);
    expect(markOf(container)).toBe('🦊');
  });

  it('uses the name monogram when no emoji is provided', () => {
    const { container } = render(<AgentAvatar name="Omar" id="agent_5" />);
    expect(markOf(container)).toBe('O');
  });
});
