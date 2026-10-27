import { describe, expect, it } from 'vitest';
import {
  buildTextIndex, countWords, findMatches, replaceAllMatches, replaceMatchAt, stepMatch, selectMatch,
} from '../find';

function rootOf(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

describe('doc find helpers', () => {
  it('builds a text index across element boundaries and skips empty nodes', () => {
    const root = rootOf('<p>Hel<b>lo W</b><span></span>orld</p>');
    const index = buildTextIndex(root);
    expect(index.text).toBe('Hello World');
    expect(index.nodes.map((node) => node.data)).toEqual(['Hel', 'lo W', 'orld']);
    expect(index.starts).toEqual([0, 3, 7]);
  });

  it('finds case-insensitive matches that span node boundaries', () => {
    const index = buildTextIndex(rootOf('<p>Hel<b>lo W</b>orld</p>'));
    // "Wo" starts in the <b> node and ends in the trailing text node.
    expect(findMatches(index, 'WO')).toEqual([6]);
    expect(findMatches(index, 'o W')).toEqual([4]);
    expect(findMatches(index, 'hello world')).toEqual([0]);
    expect(findMatches(index, '')).toEqual([]);
    // case-sensitive finds nothing when the case differs
    expect(findMatches(index, 'WO', true)).toEqual([]);
    expect(findMatches(index, 'lo W', true)).toEqual([3]);
  });

  it('reports every non-overlapping occurrence', () => {
    const index = buildTextIndex(rootOf('<p>ab abab</p>'));
    expect(findMatches(index, 'ab')).toEqual([0, 3, 5]);
  });

  it('steps through matches and wraps around', () => {
    const offsets = [3, 10, 20];
    expect(stepMatch(offsets, 0)).toBe(0);
    expect(stepMatch(offsets, 4)).toBe(1);
    expect(stepMatch(offsets, 21)).toBe(0);
    expect(stepMatch(offsets, 20)).toBe(2);
    expect(stepMatch([], 0)).toBe(-1);
  });

  it('replaces a match that spans two nodes, splicing each node', () => {
    const root = rootOf('<p>Hel<b>lo W</b>orld</p>');
    const index = buildTextIndex(root);
    expect(replaceMatchAt(index, 6, 2, 'X')).toBe(true);
    // the replacement lands in the first touched node, later nodes only lose their slice
    expect(index.nodes.map((node) => node.data)).toEqual(['Hel', 'lo X', 'rld']);
    expect(buildTextIndex(root).text).toBe('Hello Xrld');
    expect(replaceMatchAt(index, 100, 1, 'X')).toBe(false);
  });

  it('replace-all applies every case-insensitive match across nodes and counts them', () => {
    const root = rootOf('<p>Ab c</p><p>aB</p>');
    const index = buildTextIndex(root);
    expect(replaceAllMatches(index, 'ab', 'X')).toBe(2);
    expect(index.nodes.map((node) => node.data)).toEqual(['X c', 'X']);
    expect(buildTextIndex(root).text).toBe('X cX');
  });

  it('selects a cross-node match as a DOM range', () => {
    const root = rootOf('<p>Hel<b>lo W</b>orld</p>');
    document.body.appendChild(root);
    try {
      const index = buildTextIndex(root);
      expect(selectMatch(index, 6, 2)).toBe(true);
      const selection = window.getSelection();
      expect(selection?.rangeCount).toBe(1);
      expect(selection?.getRangeAt(0).toString()).toBe('Wo');
      expect(selectMatch(index, -1, 2)).toBe(false);
    } finally {
      root.remove();
    }
  });

  it('counts whitespace-delimited words in Latin and Arabic text', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   ')).toBe(0);
    expect(countWords('Hello  world')).toBe(2);
    expect(countWords('  مرحبا بالعالم  ')).toBe(2);
  });
});
