/**
 * Neo N11: the text a node carries into a prompt.
 *
 * A node's payload is a bag of fields whose meaning depends on the node type (a
 * document's `title`, a search's `query`, a branch's `label`), so the canvas
 * cannot hard-code "the output". It reads the same fields the N16 recall index
 * ranks on, in the same order, so editing a node by hand and letting the model
 * quote it back are two views of one string.
 *
 * Kept in its own module because both the editing ops and the N5 selector hook
 * need it, and neither should reach into the other's internals.
 */

/** Node payload fields that carry prose, most specific first. */
const PROSE_KEYS = ["text", "title", "label", "summary", "query", "answer", "reason", "message", "content"] as const;

/** Payload fields that locate an artefact rather than describe it. */
const LOCATION_KEYS = ["url", "path", "mime"] as const;

/** Payload fields that are not prose at all (ids, counters, digests). */
const META_KEYS = [
  "stepId",
  "seedId",
  "tool",
  "kind",
  "sizeBytes",
  "sha256",
  "ok",
  "arm",
  "total",
  "index",
  "fanoutId",
  "branchNodeIds",
  "completedCount",
  "remainingEstimate",
] as const;

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  if (typeof field !== "string" || !field.trim()) return undefined;
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
  return parts.join(" — ");
}

/** True when the node has prose worth quoting or editing. */
export function hasNodeText(node: { type: string; data?: unknown }): boolean {
  return PROSE_KEYS.some((key) => readString(node.data, key) !== undefined);
}

/** Where a node's artefact lives, for a prompt that must point at a file. */
export function nodeLocation(node: { data?: unknown }): string | undefined {
  for (const key of LOCATION_KEYS) {
    const value = readString(node.data, key);
    if (value) return value;
  }
  return undefined;
}

/** The payload fields an edit may rewrite, so an edit never invents a shape. */
export function editableFields(data: unknown): Record<string, unknown> {
  if (typeof data !== "object" || data === null) return {};
  const record = data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of PROSE_KEYS) {
    const value = record[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** Rewrite the prose of a payload, keeping every other field untouched. */
export function withEditedText(data: unknown, text: string): Record<string, unknown> {
  const base = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  const fields = editableFields(base);
  const key = Object.keys(fields)[0] ?? "text";
  return { ...base, [key]: text };
}

/** An abbreviated form of the text, for a marker that must stay short. */
export function excerpt(text: string, max = 200): string {
  const flat = text.trim().replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
