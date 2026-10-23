/**
 * Neo N18: the canvas annotation store.
 *
 * The run graph (N1) records what the *agent* did. Everything the *user* adds to
 * the canvas — a colour tag on a node, a comment, a free note floating on the
 * surface — is an annotation, kept here in its own table so it never overwrites
 * an agent-authored payload and survives a server restart.
 *
 * Storage is the same `entities` table every other module uses (see
 * `src/server/sqliteStore.ts`). Nothing here talks to the network or to a model.
 */
import { allEntities, database, onDatabaseReset, removeEntity, transaction } from "../server/sqliteStore.js";

/**
 * The colours a node can carry. Kept as a closed vocabulary rather than a raw
 * string, so the canvas, the server and the tests agree on the palette and an
 * unknown colour from a hand-edited payload is dropped instead of painted.
 */
export const CANVAS_TAG_COLOURS = ["none", "blue", "green", "amber", "red", "violet"] as const;
export type CanvasTagColour = (typeof CANVAS_TAG_COLOURS)[number];

/** Hard ceiling per run: a colour tag is a label, not a log. */
export const MAX_COLOUR_TAGS_PER_RUN = 500;
/** Hard ceiling on one comment, so a paste cannot swamp the store. */
export const MAX_COMMENT_BYTES = 4_000;
/** Hard ceiling on the whole annotation map of one run. */
export const MAX_ANNOTATIONS_BYTES = 256_000;
/** How many notes one run may hold; keeps a runaway canvas from growing forever. */
export const MAX_FREE_NOTES_PER_RUN = 200;

/** The colour tags a run carries, keyed by node id. */
export interface CanvasColourTags {
  /** node id -> colour. Absent means "no tag". */
  tags: Record<string, CanvasTagColour>;
}

/** One comment thread on a node, oldest first. */
export interface CanvasComment {
  id: string;
  /** Who wrote it. `user` for the human; an agent id when a tool adds one. */
  author: string;
  text: string;
  /** Wall-clock milliseconds. */
  created: number;
}

/** Comments for a run, keyed by node id (a node with none has no entry). */
export interface CanvasComments {
  /** node id -> thread, oldest first. */
  comments: Record<string, CanvasComment[]>;
}

/** A note the user placed on the canvas surface, with no node of its own. */
export interface CanvasFreeNote {
  id: string;
  text: string;
  /** Graph-space position, so the note keeps its place across reloads. */
  x: number;
  y: number;
  /** Optional colour tag, for a note the user wants to stand out. */
  colour: CanvasTagColour;
  created: number;
  updated: number;
}

/** Free notes for a run, in creation order. */
export interface CanvasFreeNotes {
  notes: CanvasFreeNote[];
}

export const CANVAS_TAGS_ENTITY = "canvas_colour_tags";
export const CANVAS_COMMENTS_ENTITY = "canvas_comments";
export const CANVAS_NOTES_ENTITY = "canvas_free_notes";

/**
 * Persist one annotation map under a fixed entity id.
 *
 * `putEntity` takes the id and payload separately, so the map is stored whole
 * rather than nested inside the entity's own `id` field.
 * The row still records `run_id` (the entity id) alongside the payload, so a
 * reload knows which run a row belongs to without parsing the map itself.
 */
function putEntity(kind: string, id: string, payload: unknown): void {
  transaction(() => {
    database()
      .prepare(
        "INSERT INTO entities(kind,id,payload) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload",
      )
      .run(kind, id, JSON.stringify({ run_id: id, payload }));
  });
}

export class CanvasAnnotationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanvasAnnotationError";
  }
}

/** True when a value is one of the palette colours. */
export function isCanvasTagColour(value: unknown): value is CanvasTagColour {
  return typeof value === "string" && (CANVAS_TAG_COLOURS as readonly string[]).includes(value);
}

function clampInt(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Read a string field from an unknown payload; empty string when unusable. */
function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Coerce an unknown payload into the colour map. A malformed colour is dropped
 * (the node simply has no tag) rather than kept as junk.
 */
export function coerceColourTags(value: unknown): CanvasColourTags {
  const tags: Record<string, CanvasTagColour> = {};
  if (typeof value !== "object" || value === null) return { tags };
  const raw = (value as { tags?: unknown }).tags;
  if (typeof raw !== "object" || raw === null) return { tags };
  for (const [nodeId, colour] of Object.entries(raw as Record<string, unknown>)) {
    if (!nodeId || !isCanvasTagColour(colour)) continue;
    tags[nodeId] = colour;
  }
  return { tags };
}

/** Coerce an unknown payload into the comment map, dropping unusable threads. */
export function coerceComments(value: unknown): CanvasComments {
  const comments: Record<string, CanvasComment[]> = {};
  if (typeof value !== "object" || value === null) return { comments };
  const raw = (value as { comments?: unknown }).comments;
  if (typeof raw !== "object" || raw === null) return { comments };
  for (const [nodeId, thread] of Object.entries(raw as Record<string, unknown>)) {
    if (!nodeId || !Array.isArray(thread)) continue;
    const clean: CanvasComment[] = [];
    for (const entry of thread) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const text = readString(record.text).slice(0, MAX_COMMENT_BYTES);
      if (!text) continue;
      clean.push({
        id: readString(record.id) || `c-${clean.length}`,
        author: readString(record.author) || "user",
        text,
        created: clampInt(record.created, Date.now()),
      });
    }
    if (clean.length > 0) comments[nodeId] = clean;
  }
  return { comments };
}

/** Coerce an unknown payload into the free-note list. */
export function coerceFreeNotes(value: unknown): CanvasFreeNotes {
  const notes: CanvasFreeNote[] = [];
  if (typeof value !== "object" || value === null) return { notes };
  const raw = (value as { notes?: unknown }).notes;
  if (!Array.isArray(raw)) return { notes };
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const text = readString(record.text).slice(0, MAX_COMMENT_BYTES);
    if (!text) continue;
    const created = clampInt(record.created, Date.now());
    notes.push({
      id: readString(record.id),
      text,
      x: clampInt(record.x),
      y: clampInt(record.y),
      colour: isCanvasTagColour(record.colour) ? record.colour : "none",
      created,
      updated: clampInt(record.updated, created),
    });
  }
  return { notes };
}

/** The whole annotation layer of one run, as the canvas reads it. */
export interface CanvasAnnotations {
  runId: string;
  tags: Record<string, CanvasTagColour>;
  comments: Record<string, CanvasComment[]>;
  notes: CanvasFreeNote[];
}

export function emptyAnnotations(runId: string): CanvasAnnotations {
  return { runId, tags: {}, comments: {}, notes: [] };
}

/** Append/update/delete access to one run's annotations. */
export class CanvasAnnotationStore {
  private readonly tags = new Map<string, CanvasColourTags>();
  private readonly comments = new Map<string, CanvasComments>();
  private readonly notes = new Map<string, CanvasFreeNotes>();
  private loaded = false;

  constructor() {
    // A test that swaps the database file must also drop this cache.
    onDatabaseReset(() => this.reset());
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    for (const row of allEntities<{ run_id: string; payload: unknown }>(CANVAS_TAGS_ENTITY)) {
      this.tags.set(row.run_id, coerceColourTags(row.payload));
    }
    for (const row of allEntities<{ run_id: string; payload: unknown }>(CANVAS_COMMENTS_ENTITY)) {
      this.comments.set(row.run_id, coerceComments(row.payload));
    }
    for (const row of allEntities<{ run_id: string; payload: unknown }>(CANVAS_NOTES_ENTITY)) {
      this.notes.set(row.run_id, coerceFreeNotes(row.payload));
    }
    this.loaded = true;
  }

  /** Forget the cached rows; called when the database connection is reset. */
  reset(): void {
    this.tags.clear();
    this.comments.clear();
    this.notes.clear();
    this.loaded = false;
  }

  private readTags(runId: string): CanvasColourTags {
    this.ensureLoaded();
    return this.tags.get(runId) ?? { tags: {} };
  }

  private readComments(runId: string): CanvasComments {
    this.ensureLoaded();
    return this.comments.get(runId) ?? { comments: {} };
  }

  private readNotes(runId: string): CanvasFreeNotes {
    this.ensureLoaded();
    return this.notes.get(runId) ?? { notes: [] };
  }

  private writeTags(runId: string, value: CanvasColourTags): void {
    putEntity(CANVAS_TAGS_ENTITY, runId, value);
    this.tags.set(runId, value);
  }

  private writeComments(runId: string, value: CanvasComments): void {
    putEntity(CANVAS_COMMENTS_ENTITY, runId, value);
    this.comments.set(runId, value);
  }

  private writeNotes(runId: string, value: CanvasFreeNotes): void {
    putEntity(CANVAS_NOTES_ENTITY, runId, value);
    this.notes.set(runId, value);
  }

  /** Everything the canvas needs for one run. */
  getAnnotations(runId: string): CanvasAnnotations {
    return {
      runId,
      tags: { ...this.readTags(runId).tags },
      comments: Object.fromEntries(
        Object.entries(this.readComments(runId).comments).map(([nodeId, thread]) => [nodeId, [...thread]]),
      ),
      notes: this.readNotes(runId).notes.map((note) => ({ ...note })),
    };
  }

  /**
   * Set (or clear, with "none") one node's colour tag. The run must own the node,
   * so a hand-crafted id can never tag another task's graph.
   */
  setColour(runId: string, nodeId: string, colour: CanvasTagColour, nodeExists: (id: string) => boolean): CanvasTagColour {
    if (!nodeExists(nodeId)) throw new CanvasAnnotationError(`node not found in this run: ${nodeId}`);
    const current = this.readTags(runId);
    const tags = { ...current.tags };
    if (colour === "none") delete tags[nodeId];
    else tags[nodeId] = colour;
    if (Object.keys(tags).length > MAX_COLOUR_TAGS_PER_RUN) {
      throw new CanvasAnnotationError("colour tag limit reached for this run");
    }
    this.writeTags(runId, { tags });
    return colour;
  }

  /** Append one comment to a node's thread. */
  addComment(runId: string, nodeId: string, author: string, text: string, nodeExists: (id: string) => boolean): CanvasComment {
    if (!nodeExists(nodeId)) throw new CanvasAnnotationError(`node not found in this run: ${nodeId}`);
    const clean = text.trim().slice(0, MAX_COMMENT_BYTES);
    if (!clean) throw new CanvasAnnotationError("comment text is required");
    const current = this.readComments(runId);
    const thread = [...(current.comments[nodeId] ?? [])];
    const comment: CanvasComment = {
      id: `c-${runId}-${nodeId}-${thread.length}-${Date.now()}`,
      author: author.trim() || "user",
      text: clean,
      created: Date.now(),
    };
    thread.push(comment);
    const comments = { ...current.comments, [nodeId]: thread };
    this.writeComments(runId, { comments });
    return comment;
  }

  /** Remove one comment from a node's thread. */
  removeComment(runId: string, nodeId: string, commentId: string): boolean {
    const current = this.readComments(runId);
    const thread = current.comments[nodeId];
    if (!thread) return false;
    const next = thread.filter((comment) => comment.id !== commentId);
    if (next.length === thread.length) return false;
    const comments = { ...current.comments };
    if (next.length === 0) delete comments[nodeId];
    else comments[nodeId] = next;
    this.writeComments(runId, { comments });
    return true;
  }

  /** Create a free note on the canvas surface. */
  addNote(runId: string, text: string, x: number, y: number, colour: CanvasTagColour = "none"): CanvasFreeNote {
    const clean = text.trim().slice(0, MAX_COMMENT_BYTES);
    if (!clean) throw new CanvasAnnotationError("note text is required");
    const current = this.readNotes(runId);
    if (current.notes.length >= MAX_FREE_NOTES_PER_RUN) {
      throw new CanvasAnnotationError("free note limit reached for this run");
    }
    const now = Date.now();
    const note: CanvasFreeNote = {
      id: `note-${runId}-${now}-${current.notes.length}`,
      text: clean,
      x: Number.isFinite(x) ? Math.round(x) : 0,
      y: Number.isFinite(y) ? Math.round(y) : 0,
      colour: isCanvasTagColour(colour) ? colour : "none",
      created: now,
      updated: now,
    };
    this.writeNotes(runId, { notes: [...current.notes, note] });
    return note;
  }

  /** Move a free note to a new graph-space position. */
  moveNote(runId: string, noteId: string, x: number, y: number): CanvasFreeNote | undefined {
    const current = this.readNotes(runId);
    const index = current.notes.findIndex((note) => note.id === noteId);
    if (index === -1) return undefined;
    const notes = [...current.notes];
    notes[index] = {
      ...notes[index]!,
      x: Number.isFinite(x) ? Math.round(x) : notes[index]!.x,
      y: Number.isFinite(y) ? Math.round(y) : notes[index]!.y,
      updated: Date.now(),
    };
    this.writeNotes(runId, { notes });
    return notes[index];
  }

  /** Edit a free note's text and colour. */
  updateNote(
    runId: string,
    noteId: string,
    patch: { text?: string; colour?: CanvasTagColour },
  ): CanvasFreeNote | undefined {
    const current = this.readNotes(runId);
    const index = current.notes.findIndex((note) => note.id === noteId);
    if (index === -1) return undefined;
    const notes = [...current.notes];
    const next = { ...notes[index]! };
    if (patch.text !== undefined) {
      const clean = patch.text.trim().slice(0, MAX_COMMENT_BYTES);
      if (!clean) throw new CanvasAnnotationError("note text is required");
      next.text = clean;
    }
    if (patch.colour !== undefined) next.colour = isCanvasTagColour(patch.colour) ? patch.colour : next.colour;
    next.updated = Date.now();
    notes[index] = next;
    this.writeNotes(runId, { notes });
    return next;
  }

  /** Delete a free note. */
  removeNote(runId: string, noteId: string): boolean {
    const current = this.readNotes(runId);
    const next = current.notes.filter((note) => note.id !== noteId);
    if (next.length === current.notes.length) return false;
    this.writeNotes(runId, { notes: next });
    return true;
  }

  /** Drop every annotation of a run (used when a task is deleted). */
  clearRun(runId: string): void {
    for (const entity of [CANVAS_TAGS_ENTITY, CANVAS_COMMENTS_ENTITY, CANVAS_NOTES_ENTITY]) {
      removeEntity(entity, runId);
    }
    this.tags.delete(runId);
    this.comments.delete(runId);
    this.notes.delete(runId);
  }
}

let store: CanvasAnnotationStore | undefined;

/** The process-wide annotation store, shared by the routes and the tests. */
export function getCanvasAnnotationStore(): CanvasAnnotationStore {
  if (!store) store = new CanvasAnnotationStore();
  return store;
}

/** Drop the process-wide store; a test that swaps the data directory needs this. */
export function resetCanvasAnnotations(): void {
  store = undefined;
}
