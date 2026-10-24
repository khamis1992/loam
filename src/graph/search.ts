/**
 * Neo N18: search across canvas nodes, as a pure function.
 *
 * A run can hold tens of thousands of nodes, and the canvas is the surface the
 * user scans when something went wrong three hours ago. Search has to work over
 * the whole run, not just the nodes currently rendered, so it lives on the server
 * where the graph is stored and runs without a DOM.
 *
 * Matching is case-insensitive and accent-insensitive ("café" finds "cafe"),
 * which matters for the accented text the agent copies into nodes.
 * Every match reports the exact span inside the field it was found in, so the
 * canvas can highlight the hit instead of only pointing at the node.
 */

/** The text fields a node is searched through, most specific first. */
export const NODE_SEARCH_FIELDS = [
  "title",
  "query",
  "url",
  "path",
  "summary",
  "reason",
  "message",
  "text",
  "verdict",
  "tool",
  "name",
  "stepId",
] as const;

/** The field names a node is searched through, plus the synthetic "type" field. */
type SearchField = (typeof NODE_SEARCH_FIELDS)[number] | "type";

/** One hit inside one field of one node. */
export interface NodeMatch {
  nodeId: string;
  /** The field the hit was found in, so the canvas can show where. */
  field: SearchField;
  /** Character offset of the hit inside the field's value. */
  start: number;
  /** Length of the hit. */
  length: number;
  /** The matched text, verbatim from the node. */
  snippet: string;
}

/** A node plus the hits that matched it, ordered for display. */
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
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
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
 * offset into the *original* text, so the canvas highlights the real characters:
 * an accent-insensitive search for "cafe" must still return a span covering
 * "Café", not the four letters of the folded string.
 */
function foldText(value: string, fold: boolean, ignoreCase: boolean): FoldedText {
  const source = fold ? value.normalize("NFKD") : value;
  let text = "";
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
        text += " ";
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
  if (typeof data !== "object" || data === null) return "";
  const value = (data as Record<string, unknown>)[field];
  return typeof value === "string" ? value : "";
}

/** Every string field of a node, with the key it came from. */
function nodeFields(node: { data?: unknown; type: string }): Array<{ field: SearchField; value: string }> {
  const fields: Array<{ field: SearchField; value: string }> = NODE_SEARCH_FIELDS.map((field) => ({
    field,
    value: readField(node.data, field),
  })).filter((entry) => entry.value.length > 0);
  // The node type is searchable too: "search" or "webpage" is a legitimate query.
  if (node.type) fields.push({ field: "type", value: node.type });
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

/** The span a match covers, before the node and field it belongs to are known. */
interface Span {
  start: number;
  length: number;
  snippet: string;
}

/** Find every non-overlapping occurrence of `needle` in a folded field. */
function findSpans(folded: FoldedText, original: string, needle: string): Span[] {
  const spans: Span[] = [];
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
    spans.push({ start, length: end - start, snippet: original.slice(start, end) });
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
 * matched, in graph order so the results are stable between searches.
 */
export function searchCanvasNodes<T extends { id: string; type: string; status: string; data?: unknown; position?: number }>(
  nodes: T[],
  term: string,
  options: CanvasSearchOptions = {},
): CanvasSearchHit[] {
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
