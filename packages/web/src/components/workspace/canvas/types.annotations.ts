/**
 * Neo N18: the Canvas annotation contract.
 *
 * The graph (N1/N2) records what the agent did; annotations record what the *user*
 * said about it. These types mirror the server's `src/server/canvasNotes.ts` and
 * the routes in `src/server/routes/graph.ts`, so the panel and the server cannot
 * drift apart. Everything here is plain data: no DOM, no network.
 */

/** The colours a node or note can carry (mirrors CANVAS_TAG_COLOURS). */
export const CANVAS_TAG_COLOURS = ['none', 'blue', 'green', 'amber', 'red', 'violet'] as const;
export type CanvasTagColour = (typeof CANVAS_TAG_COLOURS)[number];

/** One comment on a node's thread. */
export interface CanvasComment {
  id: string;
  author: string;
  text: string;
  /** Wall-clock milliseconds. */
  created: number;
}

/** A note the user placed on the canvas surface, with no node of its own. */
export interface CanvasFreeNote {
  id: string;
  text: string;
  /** Graph-space position, so the note keeps its place across reloads. */
  x: number;
  y: number;
  colour: CanvasTagColour;
  created: number;
  updated: number;
}

/** The whole annotation layer of one run, as the canvas reads it. */
export interface CanvasAnnotations {
  runId: string;
  /** node id -> colour. Absent means "no tag". */
  tags: Record<string, CanvasTagColour>;
  /** node id -> thread, oldest first. A node with none has no entry. */
  comments: Record<string, CanvasComment[]>;
  notes: CanvasFreeNote[];
}

/** A body accepted by `PATCH /nodes/:nodeId/colour`. */
export interface CanvasColourPatch {
  colour: CanvasTagColour;
}

/** A body accepted by `POST /nodes/:nodeId/comments`. */
export interface CanvasCommentDraft {
  text: string;
  author?: string;
}

/** A body accepted by `POST /notes`. */
export interface CanvasNoteDraft {
  text: string;
  x: number;
  y: number;
  colour?: CanvasTagColour;
}

/** A body accepted by `PATCH /notes/:noteId`; a move and an edit travel together. */
export interface CanvasNotePatch {
  text?: string;
  x?: number;
  y?: number;
  colour?: CanvasTagColour;
}

export const isCanvasTagColour = (value: unknown): value is CanvasTagColour =>
  typeof value === 'string' && (CANVAS_TAG_COLOURS as readonly string[]).includes(value);

/**
 * The design token each tag colour paints with. The palette is the annotation
 * model; these are the tokens the web app resolves it to, so a colour is never a
 * raw hex and the palette follows the theme in both light and dark.
 */
export const CANVAS_TAG_COLOUR_CSS: Record<CanvasTagColour, string> = {
  none: 'var(--text-tertiary)',
  blue: 'var(--icon-blue)',
  green: 'var(--function-success)',
  amber: 'var(--function-warning)',
  red: 'var(--function-error)',
  violet: 'var(--function-merged)',
};

/** Read a string field from an unknown payload; empty string when unusable. */
function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Coerce a comment thread, dropping entries that carry no text. */
function coerceComments(value: unknown): Record<string, CanvasComment[]> {
  const threads: Record<string, CanvasComment[]> = {};
  if (typeof value !== 'object' || value === null) return threads;
  for (const [nodeId, thread] of Object.entries(value as Record<string, unknown>)) {
    if (!nodeId || !Array.isArray(thread)) continue;
    const clean = thread
      .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
      .map((entry) => ({
        id: readString(entry.id),
        author: readString(entry.author) || 'user',
        text: readString(entry.text),
        created: typeof entry.created === 'number' && Number.isFinite(entry.created) ? entry.created : 0,
      }))
      .filter((comment) => comment.text.length > 0);
    if (clean.length > 0) threads[nodeId] = clean;
  }
  return threads;
}

/** Coerce the free-note list, keeping the palette's colours only. */
function coerceNotes(value: unknown): CanvasFreeNote[] {
  if (!Array.isArray(value)) return [];
  const notes: CanvasFreeNote[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const text = readString(record.text);
    if (!text) continue;
    const created = typeof record.created === 'number' && Number.isFinite(record.created) ? record.created : 0;
    notes.push({
      id: readString(record.id),
      text,
      x: typeof record.x === 'number' && Number.isFinite(record.x) ? record.x : 0,
      y: typeof record.y === 'number' && Number.isFinite(record.y) ? record.y : 0,
      colour: isCanvasTagColour(record.colour) ? record.colour : 'none',
      created,
      updated: typeof record.updated === 'number' && Number.isFinite(record.updated) ? record.updated : created,
    });
  }
  return notes;
}

/** Coerce the colour map, dropping any colour outside the palette. */
function coerceTags(value: unknown): Record<string, CanvasTagColour> {
  const tags: Record<string, CanvasTagColour> = {};
  if (typeof value !== 'object' || value === null) return tags;
  for (const [nodeId, colour] of Object.entries(value as Record<string, unknown>)) {
    if (nodeId && isCanvasTagColour(colour)) tags[nodeId] = colour;
  }
  return tags;
}

/** Coerce an unknown payload into the annotation layer; undefined when unusable. */
export function coerceCanvasAnnotations(value: unknown): CanvasAnnotations | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.runId !== 'string') return undefined;
  return {
    runId: raw.runId,
    tags: coerceTags(raw.tags),
    comments: coerceComments(raw.comments),
    notes: coerceNotes(raw.notes),
  };
}

/** An empty layer for a run that has no annotations yet. */
export function emptyCanvasAnnotations(runId: string): CanvasAnnotations {
  return { runId, tags: {}, comments: {}, notes: [] };
}
