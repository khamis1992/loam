/**
 * Cross-session file-touch notifications (jcode J8, "Swarm file-touch
 * notifications").
 *
 * Adapted from jcode (MIT) — spec: ref/SWARM_ARCHITECTURE.md "File Touch and
 * Intent" and ref/JCODE_RE.md task J8. jcode notifies a session when another
 * session writes a file it has already read, so a stale read is caught instead
 * of silently producing a conflicting edit.
 *
 * Loam runs several agent sessions against one repository (sub-agents,
 * delegated tasks, orchestrator workers, swarm stages). This module is that
 * notice queue:
 *
 *   - `noteRead(sessionId, abs, content)`  records what a session has read
 *   - `noteWrite(sessionId, abs, content)` publishes a notice to every OTHER
 *     session whose snapshot of the path differs from the new content, with a
 *     short line diff
 *   - `drainNotices(sessionId)`            hands the queued notices to a
 *     session at its next turn
 *
 * Notices are deduped per (session, path): repeated edits by the same writer
 * update the pending notice instead of flooding the reader. A writer never
 * notifies itself, a write that changes nothing produces no notice, and a
 * reader who re-read the file after the edit is not told about it.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Line-level result of comparing the content a session read with the new content. */
export interface FileTouchDiff {
  added: number;
  removed: number;
  /** Up to a few removed lines, oldest first (prefixed with `-` by the caller). */
  removedLines: string[];
  /** Up to a few added lines, oldest first (prefixed with `+` by the caller). */
  addedLines: string[];
}

/** One queued notice: "session B read this path, and session A changed it". */
export interface FileTouchNotice {
  /** Absolute path of the touched file. */
  path: string;
  /** Path relative to the workspace root (absolute when the file is outside it). */
  relPath: string;
  /** Session id of the writer. */
  writer: string;
  /** How many writes were collapsed into this notice (dedupe). */
  edits: number;
  /** Short line-diff summary, e.g. `+2/-1`. */
  summary: string;
  /** A few changed lines, each prefixed with `-` or `+`. */
  preview: string[];
  /** ISO timestamp of the most recent collapsed write. */
  at: string;
}

/** Above this line count a full LCS diff is skipped for a cheap multiset count. */
const MAX_DIFF_LINES = 300;
/** Bound the per-session queue so a dead session cannot grow it without limit. */
const MAX_PENDING_PER_SESSION = 50;
/** Bound the path table; the oldest entries are dropped first. */
const MAX_TRACKED_PATHS = 5000;
/** A session whose newest pending notice is older than this is treated as gone. */
const PENDING_TTL_MS = 60 * 60 * 1000;
/** Bound the number of live workspace registries (one per repository root). */
const MAX_REGISTRIES = 50;
/** Above this size a reader's snapshot is remembered only as a digest, not text. */
const MAX_STORE_CONTENT_CHARS = 256_000;

interface ReaderEntry {
  /** Digest of the exact content this session last saw. */
  hash: string;
  /** The content itself, kept so a notice can be diffed against what the
   *  reader actually saw. Omitted for very large files to bound memory. */
  content?: string;
}

interface PathEntry {
  /** Last content observed for this path (read or written), used as the diff
   *  base when a reader's own snapshot is not retained. */
  content: string;
  /** Sessions that read this path, mapped to the exact content they saw. */
  readers: Map<string, ReaderEntry>;
}

/** Content digest. SHA-256, not a short rolling hash: the notice logic treats
 *  "same digest" as "the reader already holds this content", so a collision
 *  would silently suppress a real change. */
function hash(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function preview(lines: string[], max = 3): string[] {
  return lines.slice(0, max);
}

/**
 * Line diff via LCS. Falls back to a multiset count for very large files, where
 * the quadratic table would cost more than the notice is worth.
 */
export function diffLines(oldText: string, newText: string): FileTouchDiff {
  if (oldText === newText) return { added: 0, removed: 0, removedLines: [], addedLines: [] };
  const a = oldText.split(/\r?\n/);
  const b = newText.split(/\r?\n/);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    const counts = new Map<string, number>();
    for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
    const addedLines: string[] = [];
    for (const line of b) {
      const left = counts.get(line) ?? 0;
      if (left > 0) counts.set(line, left - 1);
      else addedLines.push(line);
    }
    let removed = 0;
    const removedLines: string[] = [];
    for (const [line, left] of counts) {
      removed += left;
      for (let i = 0; i < left; i++) removedLines.push(line);
    }
    return { added: addedLines.length, removed, removedLines: preview(removedLines), addedLines: preview(addedLines) };
  }

  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  const removedLines: string[] = [];
  const addedLines: string[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      addedLines.push(b[j - 1]!);
      j--;
    } else {
      removedLines.push(a[i - 1]!);
      i--;
    }
  }
  removedLines.reverse();
  addedLines.reverse();
  return { added: addedLines.length, removed: removedLines.length, removedLines: preview(removedLines), addedLines: preview(addedLines) };
}

/** `+2/-1` — the short summary a notice carries. */
export function formatDiffSummary(diff: FileTouchDiff): string {
  return `+${diff.added}/-${diff.removed}`;
}

/** Prefix changed lines so the model can read the notice at a glance. */
export function formatDiffPreview(diff: FileTouchDiff): string[] {
  return [...diff.removedLines.map((line) => `- ${line}`), ...diff.addedLines.map((line) => `+ ${line}`)];
}

/**
 * One repository root's touch state. A session reads a path, another session
 * writes it, and every other reader whose snapshot differs gets one notice.
 */
export class FileTouchRegistry {
  private readonly entries = new Map<string, PathEntry>();
  private readonly pending = new Map<string, FileTouchNotice[]>();

  constructor(private readonly workspace: string) {}

  /** Record that `sessionId` read `abs` (content optional when already known). */
  noteRead(sessionId: string, abs: string, content?: string): void {
    const key = path.resolve(abs);
    const entry = this.entryFor(key);
    const next = content !== undefined ? content : readText(key);
    entry.content = next;
    entry.readers.set(sessionId, snapshotOf(next));
    // A reader that catches up has a current view of this path, so any notice
    // queued for it is stale and must not be delivered.
    this.clearNotices(sessionId, key);
  }

  /**
   * Record that `sessionId` wrote `abs`. Every OTHER session whose snapshot of
   * the path differs from the new content is queued a notice carrying the diff
   * against the content that session actually read (not merely the previous
   * write), so repeated edits collapse into one accurate summary.
   */
  noteWrite(sessionId: string, abs: string, content?: string): FileTouchNotice[] {
    const key = path.resolve(abs);
    const entry = this.entryFor(key);
    // The content before this write is the diff base for a reader whose own
    // snapshot was too large to retain. Captured BEFORE entry.content is
    // overwritten, otherwise that reader would be diffed against the new
    // content and silently never notified.
    const previous = entry.content;
    const next = content !== undefined ? content : readText(key);
    entry.content = next;

    const nextHash = hash(next);
    const produced: FileTouchNotice[] = [];
    for (const [reader, seen] of entry.readers) {
      // No self-notices, and no notice for a reader whose snapshot already
      // matches the new content (it re-read the file after the edit).
      if (reader === sessionId || seen.hash === nextHash) continue;
      const base = seen.content ?? previous;
      const diff = diffLines(base, next);
      if (diff.added === 0 && diff.removed === 0) continue;
      produced.push(this.enqueue(reader, this.noticeFor(key, sessionId, diff)));
    }
    // The writer now holds the current content, so it is not notified later.
    entry.readers.set(sessionId, snapshotOf(next));
    return produced;
  }

  /** Record that `sessionId` removed `abs`: readers are told the file is gone. */
  noteDelete(sessionId: string, abs: string): FileTouchNotice[] {
    const key = path.resolve(abs);
    const entry = this.entries.get(key);
    if (!entry) return [];
    const lines = entry.content.split(/\r?\n/);
    const diff: FileTouchDiff = { added: 0, removed: lines.length, removedLines: preview(lines), addedLines: [] };
    entry.readers.delete(sessionId);
    const produced: FileTouchNotice[] = [];
    for (const reader of entry.readers.keys()) {
      if (reader === sessionId) continue;
      produced.push(this.enqueue(reader, this.noticeFor(key, sessionId, diff, "deleted")));
    }
    if (entry.readers.size === 0) this.entries.delete(key);
    return produced;
  }

  /** Take (and clear) the notices queued for `sessionId`. */
  drainNotices(sessionId: string): FileTouchNotice[] {
    const notices = this.pending.get(sessionId) ?? [];
    this.pending.delete(sessionId);
    return notices;
  }

  /** Drop a session's queued notices for one path (its view is now current). */
  private clearNotices(sessionId: string, key: string): void {
    const queue = this.pending.get(sessionId);
    if (!queue) return;
    const kept = queue.filter((n) => n.path !== key);
    if (kept.length === 0) this.pending.delete(sessionId);
    else if (kept.length !== queue.length) this.pending.set(sessionId, kept);
  }

  /** Drop a session's queue and its reader marks (call when a run ends). */
  forgetSession(sessionId: string): void {
    this.pending.delete(sessionId);
    for (const [key, entry] of this.entries) {
      entry.readers.delete(sessionId);
      if (entry.readers.size === 0) this.entries.delete(key);
    }
  }

  /** Queued-notice count for one session (diagnostics/tests). */
  pendingCount(sessionId: string): number {
    return this.pending.get(sessionId)?.length ?? 0;
  }

  private noticeFor(key: string, writer: string, diff: FileTouchDiff, verb = "modified"): FileTouchNotice {
    const rel = path.relative(this.workspace, key);
    return {
      path: key,
      relPath: rel && !rel.startsWith("..") ? rel : key,
      writer,
      edits: 1,
      summary: verb === "deleted" ? "file deleted" : formatDiffSummary(diff),
      preview: verb === "deleted" ? [] : formatDiffPreview(diff),
      at: new Date().toISOString(),
    };
  }

  /** Collapse repeated writes to the same path into the pending notice. */
  private enqueue(sessionId: string, notice: FileTouchNotice): FileTouchNotice {
    this.pruneStale();
    const queue = this.pending.get(sessionId) ?? [];
    const existing = queue.find((n) => n.path === notice.path);
    if (existing) {
      existing.edits += 1;
      existing.summary = notice.summary;
      existing.preview = notice.preview;
      existing.at = notice.at;
      existing.writer = notice.writer;
      return existing;
    }
    queue.push(notice);
    if (queue.length > MAX_PENDING_PER_SESSION) queue.splice(0, queue.length - MAX_PENDING_PER_SESSION);
    this.pending.set(sessionId, queue);
    return notice;
  }

  /** A session that never drained its queue again is gone: drop its notices. */
  private pruneStale(): void {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [sessionId, queue] of this.pending) {
      const newest = queue.reduce((latest, n) => Math.max(latest, Date.parse(n.at)), 0);
      if (queue.length === 0 || (Number.isFinite(newest) && newest < cutoff)) this.pending.delete(sessionId);
    }
  }

  private entryFor(key: string): PathEntry {
    let entry = this.entries.get(key);
    if (entry) return entry;
    entry = { content: readText(key), readers: new Map<string, ReaderEntry>() };
    if (this.entries.size >= MAX_TRACKED_PATHS) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, entry);
    return entry;
  }
}

function readText(abs: string): string {
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return "";
  }
}

/** A reader's snapshot: the digest always, the text only when it is small
 *  enough to keep for diffing. */
function snapshotOf(content: string): ReaderEntry {
  return { hash: hash(content), ...(content.length <= MAX_STORE_CONTENT_CHARS ? { content } : {}) };
}

const registries = new Map<string, FileTouchRegistry>();

/** The one touch registry for a repository root, shared by its live sessions. */
export function fileTouchRegistry(workspace: string): FileTouchRegistry {
  const key = path.resolve(workspace);
  let registry = registries.get(key);
  if (!registry) {
    if (registries.size >= MAX_REGISTRIES) {
      const oldest = registries.keys().next().value;
      if (oldest !== undefined) registries.delete(oldest);
    }
    registry = new FileTouchRegistry(key);
    registries.set(key, registry);
  }
  return registry;
}

/** Drop one session everywhere (call when a run ends). */
export function forgetFileTouchSession(sessionId: string): void {
  for (const registry of registries.values()) registry.forgetSession(sessionId);
}
