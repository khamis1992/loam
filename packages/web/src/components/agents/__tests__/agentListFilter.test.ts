import { describe, expect, it } from 'vitest';
import {
  foldName,
  lastActivityKey,
  matchesSearch,
  searchAgents,
  sortByLastActivity,
  splitHidden,
  sumUnread,
  type SidebarAgent,
} from '../agentListFilter';

const make = (id: string, name: string, extra: Partial<SidebarAgent> = {}): SidebarAgent => ({
  id,
  name,
  emoji: '🤖',
  ...extra,
});

describe('foldName', () => {
  it('lowercases and strips diacritics', () => {
    expect(foldName('Café')).toBe('cafe');
    expect(foldName('Zoë')).toBe('zoe');
    expect(foldName('ÉCOLE')).toBe('ecole');
  });

  it('leaves already-plain names alone', () => {
    expect(foldName('Plain Agent')).toBe('plain agent');
    expect(foldName('')).toBe('');
  });
});

describe('foldName — Arabic and decomposed input', () => {
  it('strips Arabic harakat/tashkeel from vocalised names', () => {
    expect(foldName('مُحَمَّد')).toBe('محمد');
    expect(foldName('عَرَبِيّ')).toBe('عربي');
  });

  it('folds decomposed Latin input (NFD) to plain ASCII', () => {
    expect(foldName('Cafe\u0301')).toBe('cafe');
    expect(foldName('Zoe\u0308')).toBe('zoe');
  });

  it('leaves Arabic letters without case folding untouched', () => {
    expect(foldName('وكيل')).toBe('وكيل');
  });
});

describe('matchesSearch / searchAgents', () => {
  const agents = [
    make('1', 'Café Bearer'),
    make('2', 'Zoë Checker', { description: 'Hello Wörld' }),
    make('3', 'Plain Bot'),
  ];

  it('empty search matches everything', () => {
    expect(searchAgents(agents, '')).toHaveLength(3);
    expect(searchAgents(agents, '   ')).toHaveLength(3);
  });

  it('matches names ignoring case and diacritics', () => {
    expect(searchAgents(agents, 'cafe')).toEqual([agents[0]]);
    expect(searchAgents(agents, 'CAFÉ')).toEqual([agents[0]]);
    expect(searchAgents(agents, 'zoe CH')).toEqual([agents[1]]);
  });

  it('falls back to matching the description', () => {
    expect(searchAgents(agents, 'world')).toEqual([agents[1]]);
  });

  it('returns [] when nothing matches', () => {
    expect(searchAgents(agents, 'zzz')).toEqual([]);
  });
});

describe('Arabic search', () => {
  const agents = [
    make('1', 'مُحَمَّد', { description: 'وكيل الاختبارات' }),
    make('2', 'عربي', { description: 'مرحبا' }),
    make('3', 'Plain Bot'),
  ];

  it('matches an unvocalised Arabic query against a vocalised name', () => {
    expect(searchAgents(agents, 'محمد')).toEqual([agents[0]]);
  });

  it('matches Arabic names and descriptions ignoring diacritics', () => {
    expect(searchAgents(agents, 'عربي')).toEqual([agents[1]]);
    expect(searchAgents(agents, 'اختبارات')).toEqual([agents[0]]);
  });

  it('returns [] for an Arabic query that matches nothing', () => {
    expect(searchAgents(agents, 'غير موجود')).toEqual([]);
  });
});

describe('splitHidden', () => {
  const agents = [
    make('1', 'A'),
    make('2', 'B', { hiddenAt: '2026-01-01T00:00:00Z' }),
    make('3', 'C'),
    make('4', 'D', { hiddenAt: '2026-02-02T00:00:00Z' }),
  ];

  it('splits into visible and hidden lists preserving order', () => {
    const { visible, hidden } = splitHidden(agents);
    expect(visible.map((a) => a.id)).toEqual(['1', '3']);
    expect(hidden.map((a) => a.id)).toEqual(['2', '4']);
  });

  it('is a no-op split when no agent is hidden', () => {
    const { visible, hidden } = splitHidden([make('1', 'A')]);
    expect(visible).toHaveLength(1);
    expect(hidden).toHaveLength(0);
  });

  it('keeps hidden agents in the hidden list after filtering', () => {
    const filtered = searchAgents(agents, 'b');
    expect(filtered.map((a) => a.id)).toEqual(['2']);
    const { visible, hidden } = splitHidden(filtered);
    expect(visible).toEqual([]);
    expect(hidden.map((a) => a.id)).toEqual(['2']);
  });
});

describe('sumUnread', () => {
  const unread = { a: { count: 2 }, b: { count: 1 } };

  it('sums unread counts for the given agent ids', () => {
    expect(sumUnread(['a', 'b'], unread)).toBe(3);
  });

  it('treats missing ids as 0', () => {
    expect(sumUnread(['a', 'zzz'], unread)).toBe(2);
  });

  it('stubs to 0 when no unread source is wired (or ids are empty)', () => {
    expect(sumUnread(['a'], undefined)).toBe(0);
    expect(sumUnread([], unread)).toBe(0);
  });
});

describe('lastActivityKey / sortByLastActivity', () => {
  it('uses the thread activity when present, else updatedAt then createdAt', () => {
    expect(lastActivityKey(make('a', 'A', { lastActivityAt: 123 }))).toBe(123);
    expect(lastActivityKey(make('a', 'A', { updatedAt: '2026-03-01T00:00:00.000Z' })))
      .toBe(Date.parse('2026-03-01T00:00:00.000Z'));
    expect(lastActivityKey(make('a', 'A', { createdAt: '2026-01-01T00:00:00.000Z' })))
      .toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    // updatedAt wins over createdAt for the same agent.
    expect(lastActivityKey(make('a', 'A', {
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    }))).toBe(Date.parse('2026-05-01T00:00:00.000Z'));
    expect(lastActivityKey(make('a', 'A'))).toBe(0);
  });

  it('orders rows by last activity, most recent first', () => {
    const agents = [
      make('a', 'A', { lastActivityAt: 100 }),
      make('b', 'B', { lastActivityAt: 300 }),
      make('c', 'C', { lastActivityAt: 200 }),
    ];
    expect(sortByLastActivity(agents).map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  it('places agents without any timestamp last and keeps equal keys stable', () => {
    const agents = [
      make('none', 'None'),
      make('hot', 'Hot', { lastActivityAt: 1000 }),
      make('first', 'First', { lastActivityAt: 5 }),
      make('second', 'Second', { lastActivityAt: 5 }),
    ];
    expect(sortByLastActivity(agents).map((x) => x.id)).toEqual(['hot', 'first', 'second', 'none']);
  });

  it('returns a new array and never mutates the input order', () => {
    const agents = [
      make('a', 'A', { lastActivityAt: 1 }),
      make('b', 'B', { lastActivityAt: 2 }),
    ];
    const sorted = sortByLastActivity(agents);
    expect(sorted).not.toBe(agents);
    expect(agents.map((x) => x.id)).toEqual(['a', 'b']);
    expect(sorted.map((x) => x.id)).toEqual(['b', 'a']);
  });
});
