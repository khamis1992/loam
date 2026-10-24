/**
 * Neo N11 (web): the text a node carries into a prompt.
 *
 * This mirrors `src/graph/nodeText.ts` on the server, because the canvas has to
 * show the *same* string the model will quote: if the panel read `title` while
 * the directive quoted `summary`, the user would edit one and be answered from
 * the other. Kept deliberately dependency-free so both packages can use it.
 */

/** Node payload fields that carry prose, most specific first. */
const PROSE_KEYS = ['text', 'title', 'label', 'summary', 'query', 'answer', 'reason', 'message', 'content'] as const;

/** Payload fields that are not prose at all (ids, counters, digests). */
const META_KEYS = [
  'stepId',
  'seedId',
  'tool',
  'kind',
  'sizeBytes',
  'sha256',
  'ok',
  'arm',
  'total',
  'index',
  'fanoutId',
  'branchNodeIds',
  'completedCount',
  'remainingEstimate',
] as const;

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  if (typeof field !== 'string' || !field.trim()) return undefined;
  // A field holding the id of something is not prose about that thing.
  if ((META_KEYS as readonly string[]).includes(key)) return undefined;
  return field.trim();
}

/** The prose a node contributes to a prompt (its "output"). */
export function nodeText(node: { type: string; data?: unknown }): string {
  const parts: string[] = [];
  const push = (value: string | undefined): void => {
    if (value && !parts.includes(value)) parts.push(value);
  };
  for (const key of PROSE_KEYS) push(readString(node.data, key));
  if (parts.length === 0) push(`${node.type}`);
  return parts.join(' — ');
}

/** True when the node has prose worth quoting or editing. */
export function hasNodeText(node: { type: string; data?: unknown }): boolean {
  return PROSE_KEYS.some((key) => readString(node.data, key) !== undefined);
}

/** The payload fields an edit may rewrite, so an edit never invents a shape. */
export function editableFields(data: unknown): Record<string, unknown> {
  if (typeof data !== 'object' || data === null) return {};
  const record = data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of PROSE_KEYS) {
    const value = record[key];
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/** Rewrite the prose of a payload, keeping every other field untouched. */
export function withEditedText(data: unknown, text: string): Record<string, unknown> {
  const base = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
  const fields = editableFields(base);
  const key = Object.keys(fields)[0] ?? 'text';
  return { ...base, [key]: text };
}

/** An abbreviated form of the text, for a marker that must stay short. */
export function excerpt(text: string, max = 200): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One entry of a node's edit history, as the server records it. */
export interface NodeEditRecord {
  previous: string;
  text: string;
  at: number;
}

/** A node's edit history, oldest last; malformed entries are skipped. */
export function readEditHistory(data: unknown): NodeEditRecord[] {
  if (typeof data !== 'object' || data === null) return [];
  const raw = (data as Record<string, unknown>).edits;
  if (!Array.isArray(raw)) return [];
  const out: NodeEditRecord[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.text !== 'string') continue;
    out.push({
      previous: typeof record.previous === 'string' ? record.previous : '',
      text: record.text,
      at: typeof record.at === 'number' ? record.at : 0,
    });
  }
  return out;
}

/** True when a payload was marked stale by an edit to another node. */
export function isStale(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false;
  return (data as Record<string, unknown>).stale === true;
}
