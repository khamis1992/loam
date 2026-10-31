/** د3 — live collaboration core: rooms of editors over the tracked-changes
 *  model (packages/shared/src/trackChanges.ts shape — mirrored here so the
 *  server owns its own pure ops; both sides are pinned by matching tests).
 *
 *  Each room keys by the doc's sidecar hash (sha1 of the workspace-relative
 *  path, same keying as docTrackIO). The room holds the canonical
 *  TrackedDocument, a monotonic sequence, and the connected members. Clients
 *  send EditIntent-style ops (insert/delete at a visible-text offset); the
 *  server applies them attributed to the remote author, bumps the sequence,
 *  broadcasts to the other members, and persists through the track sidecar.
 *  A stale op (paragraph changed since the sender's baseSeq) is rejected with
 *  the current paragraph so the client can re-apply as another tracked change.
 */
import { createHash } from "node:crypto";
// Room keys are non-cryptographic identity hashes of the doc path (SHA-256;
// the sidecar on disk keeps its own keying inside docTrackIO).

export interface RevisionAuthor { id: string; name: string }

export interface TrackedRun {
  id: string;
  type: "base" | "insert" | "delete";
  text: string;
  authorId?: string;
  timestamp?: string;
}

export interface TrackedParagraph { id: string; runs: TrackedRun[] }

export interface TrackedDocument {
  paragraphs: TrackedParagraph[];
  authors?: Record<string, RevisionAuthor>;
  threads?: unknown[];
}

export type CollabOp =
  | { kind: "insert"; paragraphId: string; offset: number; text: string }
  | { kind: "delete"; paragraphId: string; offset: number; direction: "backward" | "forward" };

export interface RoomMember {
  clientId: string;
  name: string;
  color: string;
  lastSeen: number;
}

export interface CollabPatchEvent {
  seq: number;
  clientId: string;
  op: CollabOp;
  /** The canonical paragraph AFTER the op, so clients can reconcile cheaply. */
  paragraph: TrackedParagraph;
}

const MEMBER_COLORS = ["#0081f2", "#5eb92d", "#ffbf36", "#c98bea", "#35c2d1", "#eb4d4d"];
const MEMBER_TTL_MS = 45_000;
const LOG_CAP = 200;

export function roomKeyFor(rel: string): string {
  return createHash("sha256").update(rel).digest("hex");
}

/** Visible (non-deleted) text length of a paragraph — mirrors the web model. */
export function visibleLength(paragraph: TrackedParagraph): number {
  return paragraph.runs.reduce((n, run) => (run.type === "delete" ? n : n + run.text.length), 0);
}

function findParagraph(doc: TrackedDocument, paragraphId: string): TrackedParagraph | null {
  return doc.paragraphs.find((p) => p.id === paragraphId) ?? null;
}

function newRunId(): string {
  return `r-${Math.random().toString(36).slice(2, 10)}`;
}

/** Split runs at a visible-text offset, returning [before, after] run clones. */
function splitAt(paragraph: TrackedParagraph, offset: number): { before: TrackedRun[]; after: TrackedRun[] } {
  const before: TrackedRun[] = [];
  const after: TrackedRun[] = [];
  let seen = 0;
  for (const run of paragraph.runs) {
    const len = run.type === "delete" ? 0 : run.text.length;
    if (seen >= offset || len === 0) {
      after.push(run);
      continue;
    }
    if (seen + len <= offset) {
      before.push(run);
      seen += len;
      continue;
    }
    const cut = offset - seen;
    before.push({ ...run, text: run.text.slice(0, cut) });
    after.push({ ...run, id: newRunId(), text: run.text.slice(cut) });
    seen += len;
  }
  return { before, after };
}

/** Insert text at a visible-text offset as a tracked run by `authorId`. */
function applyInsert(doc: TrackedDocument, paragraphId: string, offset: number, text: string, authorId: string, timestamp: string): TrackedParagraph | null {
  const paragraph = findParagraph(doc, paragraphId);
  if (!paragraph) return null;
  const total = visibleLength(paragraph);
  if (offset < 0 || offset > total) return null;
  const { before, after } = splitAt(paragraph, offset);
  const run: TrackedRun = { id: newRunId(), type: "insert", text, authorId, timestamp };
  paragraph.runs = [...before, run, ...after];
  return paragraph;
}

/** Mark one visible character deleted (tracked) by `authorId`. */
function applyDelete(doc: TrackedDocument, paragraphId: string, offset: number, direction: "backward" | "forward", authorId: string, timestamp: string): TrackedParagraph | null {
  const paragraph = findParagraph(doc, paragraphId);
  if (!paragraph) return null;
  const total = visibleLength(paragraph);
  const target = direction === "backward" ? offset - 1 : offset;
  if (target < 0 || target >= total) return null;
  const { before, after } = splitAt(paragraph, target);
  // `after` starts with the run holding the target character (its first
  // visible run); mark the first character of that run deleted.
  const index = after.findIndex((run) => run.type !== "delete" && run.text.length > 0);
  if (index === -1) return null;
  const run = after[index]!;
  const deleted: TrackedRun = { id: newRunId(), type: "delete", text: run.text.slice(0, 1), authorId, timestamp };
  const rest: TrackedRun = run.text.length > 1 ? { ...run, id: newRunId(), text: run.text.slice(1) } : run;
  const rebuilt = [...before, ...after.slice(0, index), deleted, ...(rest === run ? [] : [rest]), ...after.slice(index + 1)];
  paragraph.runs = rebuilt;
  return paragraph;
}

export function assertDocShape(value: unknown): asserts value is TrackedDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("doc must be an object");
  const doc = value as Record<string, unknown>;
  if (!Array.isArray(doc.paragraphs)) throw new Error("doc.paragraphs must be an array");
}

interface Room {
  key: string;
  rel: string;
  doc: TrackedDocument;
  seq: number;
  members: Map<string, RoomMember>;
  /** Recent patches for late joiners (bounded). */
  log: CollabPatchEvent[];
  /** Paragraph ids touched since a given seq, for staleness checks. */
  touchedSince: Array<{ seq: number; paragraphId: string }>;
  streams: Set<(event: string, data: unknown) => void>;
}

export class CollabRooms {
  private rooms = new Map<string, Room>();

  /** Open (or attach to) a room with the given canonical document. */
  join(rel: string, doc: TrackedDocument, clientId: string, name: string): { key: string; seq: number; members: RoomMember[]; color: string } {
    assertDocShape(doc);
    const key = roomKeyFor(rel);
    const room = this.rooms.get(key) ?? {
      key, rel, doc, seq: 0, members: new Map(), log: [], touchedSince: [], streams: new Set(),
    };
    this.rooms.set(key, room);
    if (room.members.size >= MEMBER_COLORS.length) {
      // Recycle the oldest idle member's color slot if the palette is exhausted.
      const oldest = [...room.members.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
      if (oldest && Date.now() - oldest.lastSeen > MEMBER_TTL_MS) room.members.delete(oldest.clientId);
    }
    const usedColors = new Set([...room.members.values()].map((m) => m.color));
    const color = MEMBER_COLORS.find((c) => !usedColors.has(c)) ?? MEMBER_COLORS[0]!;
    room.members.set(clientId, { clientId, name, color, lastSeen: Date.now() });
    this.broadcastPresence(room);
    return { key, seq: room.seq, members: this.memberList(room), color };
  }

  leave(rel: string, clientId: string): boolean {
    const room = this.rooms.get(roomKeyFor(rel));
    if (!room) return false;
    const had = room.members.delete(clientId);
    if (had) this.broadcastPresence(room);
    if (room.members.size === 0 && room.streams.size === 0) this.rooms.delete(room.key);
    return had;
  }

  heartbeat(rel: string, clientId: string): void {
    const room = this.rooms.get(roomKeyFor(rel));
    const member = room?.members.get(clientId);
    if (member) member.lastSeen = Date.now();
  }

  members(rel: string): RoomMember[] {
    const room = this.rooms.get(roomKeyFor(rel));
    return room ? this.memberList(room) : [];
  }

  /** Subscribe a stream; returns an unsubscribe. */
  subscribe(rel: string, emit: (event: string, data: unknown) => void): () => void {
    const room = this.rooms.get(roomKeyFor(rel));
    if (!room) return () => undefined;
    room.streams.add(emit);
    return () => room.streams.delete(emit);
  }

  /** Apply a remote op as a tracked change by the op's author. */
  apply(
    rel: string,
    clientId: string,
    op: CollabOp,
    baseSeq: number,
  ): { ok: true; seq: number; paragraph: TrackedParagraph } | { ok: false; reason: "stale" | "invalid"; paragraph: TrackedParagraph | null; seq: number } {
    const room = this.rooms.get(roomKeyFor(rel));
    if (!room) return { ok: false, reason: "invalid", paragraph: null, seq: 0 };
    const member = room.members.get(clientId);
    if (!member) return { ok: false, reason: "invalid", paragraph: null, seq: room.seq };

    const stale = room.touchedSince.some((t) => t.seq > baseSeq && t.paragraphId === op.paragraphId);
    if (stale) {
      const paragraph = findParagraph(room.doc, op.paragraphId);
      return { ok: false, reason: "stale", paragraph, seq: room.seq };
    }

    const timestamp = new Date().toISOString();
    const authorId = clientId;
    if (!room.doc.authors) room.doc.authors = {};
    if (!room.doc.authors[authorId]) room.doc.authors[authorId] = { id: authorId, name: member.name };

    const paragraph =
      op.kind === "insert"
        ? applyInsert(room.doc, op.paragraphId, op.offset, op.text, authorId, timestamp)
        : applyDelete(room.doc, op.paragraphId, op.offset, op.direction, authorId, timestamp);
    if (!paragraph) return { ok: false, reason: "invalid", paragraph: findParagraph(room.doc, op.paragraphId), seq: room.seq };

    room.seq += 1;
    room.touchedSince.push({ seq: room.seq, paragraphId: op.paragraphId });
    if (room.touchedSince.length > LOG_CAP) room.touchedSince.splice(0, room.touchedSince.length - LOG_CAP);
    const event: CollabPatchEvent = { seq: room.seq, clientId, op, paragraph: structuredClone(paragraph) };
    room.log.push(event);
    if (room.log.length > LOG_CAP) room.log.splice(0, room.log.length - LOG_CAP);
    for (const emit of room.streams) emit("patch", event);
    return { ok: true, seq: room.seq, paragraph: event.paragraph };
  }

  /** Canonical document (for sidecar persistence by the route layer). */
  document(rel: string): TrackedDocument | null {
    return this.rooms.get(roomKeyFor(rel))?.doc ?? null;
  }

  /** Patches after `afterSeq`, for stream catch-up. */
  catchUp(rel: string, afterSeq: number): CollabPatchEvent[] {
    const room = this.rooms.get(roomKeyFor(rel));
    return room ? room.log.filter((e) => e.seq > afterSeq) : [];
  }

  /** Drop members idle past the TTL (called on a timer by the route layer). */
  reapIdle(): void {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      let removed = false;
      for (const member of [...room.members.values()]) {
        if (now - member.lastSeen > MEMBER_TTL_MS) {
          room.members.delete(member.clientId);
          removed = true;
        }
      }
      if (removed) this.broadcastPresence(room);
      if (room.members.size === 0 && room.streams.size === 0) this.rooms.delete(room.key);
    }
  }

  private memberList(room: Room): RoomMember[] {
    return [...room.members.values()].map((m) => ({ ...m }));
  }

  private broadcastPresence(room: Room): void {
    const members = this.memberList(room);
    for (const emit of room.streams) emit("presence", { members });
  }
}

/** Process-wide store. */
export const collabRooms = new CollabRooms();
