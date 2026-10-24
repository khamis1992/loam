/**
 * Neo N18: search across canvas nodes (web side).
 *
 * Mirrors the server's `src/graph/__tests__/search.test.ts`: the panel runs the
 * same algorithm over the nodes it holds, so the two must agree on what a match
 * is and where it is. Playwright is not available here, so the pure function is
 * pinned instead of the highlighted cards.
 */
import { describe, expect, it } from 'vitest';

import { highlightField, highlightSegments, normaliseText, searchCanvasNodes, searchMatches } from '../search';

interface Node {
  id: string;
  type: string;
  status: string;
  data?: Record<string, unknown>;
  position?: number;
}

function node(id: string, data: Record<string, unknown>, type = 'recipe_step', status = 'finished'): Node {
  return { id, type, status, data, position: Number(id.replace(/\D/g, '')) || 0 };
}

describe('canvas search normalisation', () => {
  it('folds case, accents and whitespace', () => {
    expect(normaliseText('  Café   AU LAIT ')).toBe('cafe au lait');
    expect(normaliseText('naïve')).toBe('naive');
    expect(normaliseText('')).toBe('');
  });
});

describe('canvas node search', () => {
  const nodes: Node[] = [
    node('1', { title: 'Gather sources', query: 'quarterly revenue', tool: 'web_search' }, 'search', 'running'),
    node('2', { title: 'Draft the report', path: 'report.md' }, 'document', 'finished'),
    node('3', { title: 'Fetch the page', url: 'https://example.com/quarterly' }, 'webpage', 'failed'),
    node('4', { title: 'Unrelated step' }),
    node('5', { summary: 'Café au lait sources' }),
  ];

  it('finds nodes by any searchable field, in graph order', () => {
    const hits = searchCanvasNodes(nodes, 'quarterly');
    expect(hits.map((hit) => hit.nodeId)).toEqual(['1', '3']);
    // The first hit matched the `query` field, the second the `url`.
    expect(hits.map((hit) => hit.matches[0]!.field)).toEqual(['query', 'url']);
    expect(hits[0]!.matches[0]!.snippet).toBe('quarterly');
  });

  it('reports the exact span of every match, including repeats', () => {
    const hits = searchCanvasNodes(nodes, 'report');
    expect(hits.map((hit) => hit.nodeId)).toEqual(['2']);
    expect(hits[0]!.matches.map((match) => [match.field, match.start, match.length])).toEqual([
      // Offsets are in the node's original text, not the folded copy: folding
      // collapses whitespace, so "report" starts at 10 in "Draft the report".
      ['title', 10, 6],
      ['path', 0, 6],
    ]);
  });

  it('maps a folded span back to the accented characters it came from', () => {
    const hits = searchCanvasNodes(nodes, 'cafe');
    expect(hits.map((hit) => hit.nodeId)).toEqual(['5']);
    const match = hits[0]!.matches[0]!;
    expect({ start: match.start, length: match.length }).toEqual({ start: 0, length: 4 });
    expect(match.snippet).toBe('Café');
  });

  it('matches case-insensitively and accent-insensitively by default', () => {
    expect(searchCanvasNodes(nodes, 'CAFÉ').map((hit) => hit.nodeId)).toEqual(['5']);
    expect(searchCanvasNodes(nodes, 'cafe').map((hit) => hit.nodeId)).toEqual(['5']);
  });

  it('finds a node by its type, because "webpage" is a legitimate query', () => {
    expect(searchCanvasNodes(nodes, 'webpage').map((hit) => hit.nodeId)).toEqual(['3']);
  });

  it('returns nothing for an empty or unknown term', () => {
    expect(searchCanvasNodes(nodes, '')).toEqual([]);
    expect(searchCanvasNodes(nodes, '   ')).toEqual([]);
    expect(searchCanvasNodes(nodes, 'zzzz')).toEqual([]);
  });

  it('honours the limit and the type filter', () => {
    const many = Array.from({ length: 10 }, (_, index) => node(String(index + 1), { title: `report ${index}` }));
    expect(searchCanvasNodes(many, 'report', { limit: 3 })).toHaveLength(3);
    expect(searchCanvasNodes(nodes, 'report', { types: ['search'] })).toEqual([]);
    expect(searchCanvasNodes(nodes, 'report', { types: ['document'] }).map((hit) => hit.nodeId)).toEqual(['2']);
  });

  it('gives the canvas the set of matched nodes in one call', () => {
    const hits = searchCanvasNodes(nodes, 'quarterly');
    expect([...searchMatches(hits)]).toEqual(['1', '3']);
  });
});

describe('search highlighting', () => {
  it('splits a value into matched and unmatched segments', () => {
    const [hit] = searchCanvasNodes([node('1', { title: 'Draft the report' })], 'report');
    const segments = highlightSegments('Draft the report', hit!.matches);
    expect(segments).toEqual([
      { text: 'Draft the ', match: false },
      { text: 'report', match: true },
    ]);
  });

  it('returns the whole value unmatched when nothing hit it', () => {
    expect(highlightSegments('Draft the report', [])).toEqual([{ text: 'Draft the report', match: false }]);
  });

  it('applies a hit to the field it named, not to the card line that shows it', () => {
    // A card shows two lines, so the same offsets must not be applied to both:
    // the subtitle's spans belong to the subtitle.
    const [hit] = searchCanvasNodes([node('1', { title: 'Gather quarterly sources', url: 'https://example.com/report' })], 'example');
    expect(highlightField('Gather quarterly sources', 'title', hit!.matches)).toEqual([
      { text: 'Gather quarterly sources', match: false },
    ]);
    expect(highlightField('https://example.com/report', 'url', hit!.matches)).toEqual([
      { text: 'https://', match: false },
      { text: 'example', match: true },
      { text: '.com/report', match: false },
    ]);
  });
});
