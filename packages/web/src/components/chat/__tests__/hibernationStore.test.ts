import { describe, it, expect, beforeEach } from 'vitest';

import {
  buildDerivedChatState,
  countDerivedEntries,
  estimateBytes,
  getDerivedChatState,
  hasDerivedChatState,
  releaseDerivedChatState,
  resetDerivedChatState,
  setDerivedChatState,
} from '../hibernationStore';

beforeEach(() => {
  resetDerivedChatState();
});

describe('estimateBytes', () => {
  it('counts a string by length and numbers by a fixed slot', () => {
    expect(estimateBytes('abc')).toBe(6);
    expect(estimateBytes(42)).toBe(8);
    expect(estimateBytes(null)).toBe(0);
    expect(estimateBytes(undefined)).toBe(0);
  });

  it('counts an array by its length and an object by its keys', () => {
    expect(estimateBytes([1, 2, 3])).toBe(192);
    expect(estimateBytes({ a: 1, b: 2 })).toBe(128);
  });
});

describe('countDerivedEntries', () => {
  it('is the folded list length', () => {
    expect(countDerivedEntries([{ a: 1 }, { b: 2 }])).toBe(2);
    expect(countDerivedEntries([])).toBe(0);
  });
});

describe('derived chat state registry', () => {
  it('stores one slot per session and releases only that session', () => {
    setDerivedChatState({ sessionId: 's1', entries: 3, bytes: 300 });
    setDerivedChatState({ sessionId: 's2', entries: 5, bytes: 500 });

    expect(hasDerivedChatState('s1')).toBe(true);
    expect(getDerivedChatState('s1')?.entries).toBe(3);

    const released = releaseDerivedChatState('s1');
    expect(released).toEqual({ sessionId: 's1', released: true, entries: 3, bytes: 300 });
    expect(hasDerivedChatState('s1')).toBe(false);
    // The other session's derived state survives.
    expect(hasDerivedChatState('s2')).toBe(true);
  });

  it('reports a no-op when the session has no derived state', () => {
    expect(releaseDerivedChatState('missing')).toEqual({
      sessionId: 'missing',
      released: false,
      entries: 0,
      bytes: 0,
    });
  });

  it('ignores a state without a session id', () => {
    setDerivedChatState({ sessionId: '', entries: 1, bytes: 1 });
    expect(hasDerivedChatState('')).toBe(false);
  });

  it('builds the fold the view renders from the canonical events', () => {
    const state = buildDerivedChatState('s1', [{ type: 'message', id: '1' } as never]);
    expect(state.sessionId).toBe('s1');
    expect(state.entries).toBe(1);
    expect(state.bytes).toBeGreaterThan(0);
    expect(state.collapsed).toHaveLength(1);
  });

  it('reset drops every session', () => {
    setDerivedChatState({ sessionId: 's1', entries: 1, bytes: 1 });
    resetDerivedChatState();
    expect(hasDerivedChatState('s1')).toBe(false);
  });
});
