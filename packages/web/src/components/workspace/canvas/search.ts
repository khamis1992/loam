/**
 * Neo N18: search across canvas nodes, as a pure function.
 *
 * Mirrors `src/graph/search.ts` on the server. The server runs it over the whole
 * run (it owns the graph), and the canvas runs it over the nodes it holds, so a
 * result is the same shape whichever side produced it: a node plus the spans that
 * matched, with offsets into the node's *original* text so the panel highlights
 * the characters the user actually sees.
 */

/** The text fields a node is searched through, most specific first. */
export const NODE_SEARCH_FIELDS = [
  'title',
  'query',
  'url',
  'path',
  'summary',
  'reason',
  'message',
  'text',
  'verdict',
  'tool',
  'name',
  'stepId',
] as const;

/** One hit inside one field of one node. */
export interface NodeMatch {
  nodeId: string;
  /** The field the hit was found in, so the result can say where. */
  field: string;
  /** Character offset of the hit inside the field's original value. */
  start: number;
  /** Length of the hit in the original value (a folded hit can be longer). */
  length: number;
  /** The matched text, verbatim from the node. */
  snippet: string;
}

/** A node plus the hits that matched it. */
export interface CanvasSearchHit {
  nodeId: string;
  nodeType: string;
  nodeStatus: string;
  /** The node's display title, for the result row. */
  title: string;
  matches: NodeMatch[];
}

export interface CanvasSearchOptions {
  /** Case-insensitive by default; `false` makes the search exact. */
  ignoreCase?: boolean;
  /** Strip accents so "naïve" finds "naive". On by default. */
  fold?: boolean;
  /** Cap on returned nodes, so a one-character query cannot flood the canvas. */
  limit?: number;
  /** Only search nodes of these types; empty means every type. */
  types?: readonly string[];
}

export const DEFAULT_SEARCH_LIMIT = 50;

/** Normalise text for comparison: case, accents and whitespace. */
export function normaliseText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Combining marks (diacritics) that NFKD splits off a base letter. */
const COMBINING_MARKS = /[\u0300-\u036f]/;

/** Text folded for comparison, plus where each folded character came from. */
interface FoldedText {
  text: string;
  /** Index in the original value of the character behind each folded character. */
  raw: number[];
}

/**
 * Fold a field's value for comparison while remembering the original offset of
 * every folded character. That mapping is what lets a match be reported as an
 * offset into the *original* text: an accent-insensitive search for "cafe" must
 * still return a span covering "Café", not the four letters of the folded string.
 */
function foldText(value: string, fold: boolean, ignoreCase: boolean): FoldedText {
  const source = fold ? value.normalize('NFKD') : value;
  let text = '';
  const raw: number[] = [];
  let pendingSpace = -1;
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    if (fold && COMBINING_MARKS.test(character)) continue;
    if (/\s/.test(character)) {
      // A whitespace run collapses to one space; leading and trailing runs are
      // dropped, so a value compares like a trimmed one.
      if (pendingSpace === -1) pendingSpace = index;
      continue;
    }
    if (pendingSpace !== -1) {
      if (text.length > 0) {
        text += ' ';
        raw.push(pendingSpace);
      }
      pendingSpace = -1;
    }
    const produced = ignoreCase ? character.toLowerCase() : character;
    for (const letter of produced) {
      text += letter;
      raw.push(index);
    }
  }
  return { text, raw };
}

/** Read a string field from an unknown node payload. */
function readField(data: unknown, field: string): string {
  if (typeof data !== 'object' || data === null) return '';
  const value = (data as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : '';
}

/** Every string field of a node, with the key it came from. */
function nodeFields(node: { data?: unknown; type: string }): Array<{ field: string; value: string }> {
  const fields = NODE_SEARCH_FIELDS.map((field) => ({ field, value: readField(node.data, field) })).filter(
    (entry) => entry.value.length > 0,
  );
  // The node type is searchable too: "search" or "webpage" is a legitimate query.
  if (node.type) fields.push({ field: 'type' as (typeof NODE_SEARCH_FIELDS)[number], value: node.type });
  return fields;
}

/** The title a result row shows, falling back to the node type. */
function hitTitle(node: { data?: unknown; type: string }): string {
  for (const field of NODE_SEARCH_FIELDS) {
    const value = readField(node.data, field);
    if (value) return value;
  }
  return node.type;
}

/** Find every non-overlapping occurrence of `needle` in a folded field. */
function findSpans(folded: FoldedText, original: string, needle: string): NodeMatch[] {
  const spans: NodeMatch[] = [];
  if (!needle) return spans;
  let from = 0;
  for (;;) {
    const index = folded.text.indexOf(needle, from);
    if (index === -1) break;
    // Translate the folded span back to the original text, so `snippet` is the
    // text the user sees rather than the folded copy.
    const start = folded.raw[index]!;
    const last = folded.raw[index + needle.length - 1]!;
    const end = last + 1;
    spans.push({ nodeId: '', field: '', start, length: end - start, snippet: original.slice(start, end) });
    from = index + needle.length;
    if (spans.length >= 10) break;
  }
  return spans;
}

/** True when a node passes the type filter, when one is set. */
function typeAllowed(node: { type: string }, types: readonly string[] | undefined): boolean {
  if (!types || types.length === 0) return true;
  return types.includes(node.type);
}

/**
 * Search a run's nodes. Returns the nodes that matched, each with the spans that
 * matched, in the order they were given so results are stable between searches.
 */
export function searchCanvasNodes<
  T extends { id: string; type: string; status: string; data?: unknown; position?: number },
>(nodes: T[], term: string, options: CanvasSearchOptions = {}): CanvasSearchHit[] {
  const ignoreCase = options.ignoreCase ?? true;
  const fold = options.fold ?? true;
  const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  const needle = foldText(term, fold, ignoreCase).text;
  if (!needle) return [];
  const hits: CanvasSearchHit[] = [];
  for (const node of nodes) {
    if (!typeAllowed(node, options.types)) continue;
    const matches: NodeMatch[] = [];
    for (const { field, value } of nodeFields(node)) {
      const folded = foldText(value, fold, ignoreCase);
      for (const span of findSpans(folded, value, needle)) {
        // `nodeId` is applied first and `field` last: `span` is built field-less,
        // and the empty `nodeId` it starts with must not overwrite the real one.
        matches.push({ ...span, nodeId: node.id, field });
      }
      if (matches.length >= 20) break;
    }
    if (matches.length === 0) continue;
    hits.push({ nodeId: node.id, nodeType: node.type, nodeStatus: node.status, title: hitTitle(node), matches });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** The node ids a search matched, for highlighting on the canvas. */
export function searchMatches(hits: CanvasSearchHit[]): Set<string> {
  return new Set(hits.map((hit) => hit.nodeId));
}

/** Split a value into segments, marking the ones a search matched. */
export function highlightSegments(
  value: string,
  matches: NodeMatch[],
): Array<{ text: string; match: boolean }> {
  const spans = matches
    .filter((match) => match.start >= 0 && match.length > 0)
    .map((match) => ({ start: match.start, end: match.start + match.length }))
    .sort((a, b) => a.start - b.start);
  const segments: Array<{ text: string; match: boolean }> = [];
  let cursor = 0;
  for (const span of spans) {
    const start = Math.max(span.start, cursor);
    if (start >= value.length) break;
    if (start > cursor) segments.push({ text: value.slice(cursor, start), match: false });
    segments.push({ text: value.slice(start, Math.min(span.end, value.length)), match: true });
    cursor = Math.min(span.end, value.length);
  }
  if (cursor < value.length) segments.push({ text: value.slice(cursor), match: false });
  return segments;
}

/**
 * Highlight a node's card with one hit's spans.
 *
 * A card shows two fields (its title and its subtitle), but one hit names the
 * field it matched, so the offsets of that hit have to be applied to the right
 * line: applying a subtitle's offsets to the title would wrap the wrong
 * characters in a highlight. Hits from any other field are ignored, because the
 * card does not render them.
 */
export function highlightField(
  value: string,
  field: string,
  matches: NodeMatch[],
): Array<{ text: string; match: boolean }> {
  const fieldMatches = matches.filter((match) => match.field === field);
  if (fieldMatches.length === 0) return [{ text: value, match: false }];
  return highlightSegments(value, fieldMatches);
}
