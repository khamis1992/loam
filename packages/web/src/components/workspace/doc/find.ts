/** Pure find/replace helpers for the doc editor: the contenteditable DOM is modeled as the
 *  concatenation of its text nodes, so matches and replacements can span node boundaries
 *  without execCommand (jsdom has none, which keeps these unit-testable).
 *
 *  All functions treat the concatenated `text` of a TextIndex as the search surface and
 *  express positions as absolute offsets into it; DOM writes go through the node list
 *  recorded in the index, so an index stays valid until its DOM is mutated. */

export interface TextIndex {
  /** The root's text nodes in document order (empty nodes skipped). */
  nodes: Text[];
  /** Concatenated text of all nodes. */
  text: string;
  /** Absolute offset of each node inside `text`. */
  starts: number[];
}

/** Walk the root and record every text node with its offset in the concatenated text. */
export function buildTextIndex(root: Node): TextIndex {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue) nodes.push(node as Text);
  }
  const starts: number[] = [];
  let length = 0;
  for (const node of nodes) {
    starts.push(length);
    length += node.nodeValue!.length;
  }
  return { nodes, text: nodes.map((node) => node.nodeValue!).join(''), starts };
}

/** Absolute offsets of every non-overlapping occurrence of `query` (case-insensitive by
 *  default). An empty query matches nothing. */
export function findMatches(index: TextIndex, query: string, caseSensitive = false): number[] {
  if (!query) return [];
  const haystack = caseSensitive ? index.text : index.text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const offsets: number[] = [];
  let from = 0;
  for (;;) {
    const found = haystack.indexOf(needle, from);
    if (found < 0) return offsets;
    offsets.push(found);
    from = found + needle.length;
  }
}

/** Position of the next match at or after `fromOffset` in the offsets list, wrapping to
 *  the first match past the end. Returns -1 when there are no matches. */
export function stepMatch(offsets: number[], fromOffset: number): number {
  if (!offsets.length) return -1;
  const next = offsets.findIndex((offset) => offset >= fromOffset);
  return next >= 0 ? next : 0;
}

/** Replace the occurrence that starts exactly at `offset` and spans `length` characters,
 *  joining the pieces across every node the match touches (the replacement text lands in
 *  the first touched node). Returns false when the offset does not intersect any node. */
export function replaceMatchAt(index: TextIndex, offset: number, length: number, replacement: string): boolean {
  if (offset < 0 || length < 0 || offset + length > index.text.length) return false;
  let touched = false;
  for (let i = 0; i < index.nodes.length; i++) {
    const node = index.nodes[i]!;
    const start = index.starts[i]!;
    const sliceStart = Math.max(0, offset - start);
    const sliceEnd = Math.min(node.nodeValue!.length, offset + length - start);
    if (sliceStart >= sliceEnd) continue;
    node.nodeValue = node.nodeValue!.slice(0, sliceStart) + (touched ? '' : replacement) + node.nodeValue!.slice(sliceEnd);
    touched = true;
  }
  return touched;
}

/** Replace every occurrence of `query` with `replacement`. Matches are applied from the
 *  last to the first so earlier offsets stay valid while the DOM mutates; the index must
 *  be rebuilt afterwards. Returns the number of replacements applied. */
export function replaceAllMatches(index: TextIndex, query: string, replacement: string, caseSensitive = false): number {
  const offsets = findMatches(index, query, caseSensitive);
  for (let i = offsets.length - 1; i >= 0; i--) replaceMatchAt(index, offsets[i]!, query.length, replacement);
  return offsets.length;
}

/** Select [offset, offset+length) across node boundaries and scroll it into view so the
 *  user sees the current match. Returns false when the range does not intersect text. */
export function selectMatch(index: TextIndex, offset: number, length: number): boolean {
  if (offset < 0 || length < 0 || offset + length > index.text.length) return false;
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;
  for (let i = 0; i < index.nodes.length; i++) {
    const node = index.nodes[i]!;
    const start = index.starts[i]!;
    const nodeLength = node.nodeValue!.length;
    if (!startNode && offset >= start && offset <= start + nodeLength) {
      startNode = node;
      startOffset = offset - start;
    }
    if (offset + length >= start && offset + length <= start + nodeLength) {
      endNode = node;
      endOffset = offset + length - start;
      break;
    }
  }
  if (!startNode || !endNode) return false;
  try {
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    (startNode.parentElement ?? null)?.scrollIntoView?.({ block: 'center' });
    return true;
  } catch {
    return false;
  }
}

/** Whitespace-delimited word count (Arabic and Latin text alike). */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}
