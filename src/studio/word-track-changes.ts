// NOTICE: Original clean-room TypeScript inspired by WordCraft/Word-style
// tracked changes and review comments (insert/delete revision runs carrying an
// author id and timestamp, threaded comments with replies, accept/reject).
// This is a pure in-memory data model; no OOXML and no third-party code.

export class TrackChangesError extends Error { constructor(message: string) { super(message); } }

export interface RevisionAuthor { id: string; name: string }
export type RunType = 'base' | 'insert' | 'delete';
export interface TrackedRun {
  id: string;
  type: RunType;
  text: string;
  authorId?: string;   // set for insert/delete runs (the tracked change)
  timestamp?: string;  // ISO string supplied by the caller
  prior?: { type: RunType; authorId?: string; timestamp?: string }; // kept when an insert/delete run is marked deleted
}
export interface TrackedParagraph { id: string; runs: TrackedRun[] }
export interface CommentItem { id: string; authorId: string; text: string; timestamp: string; parentId: string | null }
export interface CommentThread {
  id: string;
  paragraphId: string;
  anchor: { offset: number; length: number }; // offset/length into the visible text at creation time
  comments: CommentItem[];
  resolved: boolean;
}
export interface TrackedDocument {
  authors: Record<string, RevisionAuthor>;
  paragraphs: TrackedParagraph[];
  threads: CommentThread[];
}

let counter = 0;
const uid = (prefix: string) => `${prefix}${(++counter).toString(36)}`;
const fail = (message: string): never => { throw new TrackChangesError(message); };
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function createTrackedDocument(paragraphTexts: unknown = []): TrackedDocument {
  const list = Array.isArray(paragraphTexts) ? paragraphTexts : fail('Expected an array of paragraph strings');
  if (list.length > 2000) fail('Too many paragraphs');
  const paragraphs = list.map((text: unknown) => {
    const value = typeof text === 'string' ? text : fail('Invalid paragraph text');
    if (value.length > 100000) fail('Paragraph text too long');
    return { id: uid('p'), runs: value ? [{ id: uid('r'), type: 'base' as RunType, text: value }] : [] };
  });
  return { authors: {}, paragraphs, threads: [] };
}

export function registerAuthor(doc: TrackedDocument, author: RevisionAuthor): TrackedDocument {
  if (!author || typeof author.id !== 'string' || !author.id || typeof author.name !== 'string' || !author.name) fail('Invalid author');
  if (author.id.length > 100 || author.name.length > 200) fail('Author id/name too long');
  const next = clone(doc);
  const existing = next.authors[author.id];
  if (existing && existing.name !== author.name) fail('Author id already registered with a different name');
  next.authors[author.id] = { ...author };
  return next;
}

function requireAuthor(doc: TrackedDocument, authorId: string): void {
  if (!doc.authors[authorId]) fail('Unknown author: ' + authorId);
}
function requireParagraph(doc: TrackedDocument, paragraphId: string): TrackedParagraph {
  return doc.paragraphs.find((p) => p.id === paragraphId) ?? fail('Unknown paragraph: ' + paragraphId);
}
function isChange(run: TrackedRun): boolean { return run.type === 'insert' || run.type === 'delete'; }
function visibleLength(runs: TrackedRun[]): number { return runs.reduce((n, r) => n + (r.type === 'delete' ? 0 : r.text.length), 0); }

// Split the run list so that `offset` lands on a run boundary; returns the
// boundary index. Offsets count visible characters only (delete runs skipped).
function splitAt(runs: TrackedRun[], offset: number, id: (run: TrackedRun) => TrackedRun): number {
  let seen = 0;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    if (run.type === 'delete') continue;
    if (seen === offset) return i;
    const end = seen + run.text.length;
    if (offset < end) {
      const cut = offset - seen;
      runs.splice(i, 1, { ...run, text: run.text.slice(0, cut) }, id({ ...run, text: run.text.slice(cut) }));
      return i + 1;
    }
    seen = end;
  }
  if (seen === offset) return runs.length;
  return fail('Offset outside paragraph');
}

export interface ChangeOptions { authorId: string; timestamp?: string }

export function insertText(doc: TrackedDocument, paragraphId: string, offset: number, text: string, opts: ChangeOptions): TrackedDocument {
  if (typeof text !== 'string' || !text || text.length > 100000) fail('Invalid inserted text');
  if (!Number.isInteger(offset) || offset < 0) fail('Invalid offset');
  const next = clone(doc);
  requireAuthor(next, opts.authorId);
  const paragraph = requireParagraph(next, paragraphId);
  if (offset > visibleLength(paragraph.runs)) fail('Offset outside paragraph');
  const index = splitAt(paragraph.runs, offset, (r) => { const copy = { ...r }; copy.id = uid('r'); return copy; });
  paragraph.runs.splice(index, 0, { id: uid('r'), type: 'insert', text, authorId: opts.authorId, timestamp: opts.timestamp ?? new Date().toISOString() });
  return next;
}

export function deleteText(doc: TrackedDocument, paragraphId: string, offset: number, length: number, opts: ChangeOptions): TrackedDocument {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length <= 0) fail('Invalid delete range');
  const next = clone(doc);
  requireAuthor(next, opts.authorId);
  const paragraph = requireParagraph(next, paragraphId);
  const visible = visibleLength(paragraph.runs);
  if (offset + length > visible) fail('Delete range outside paragraph');
  const split = (at: number) => splitAt(paragraph.runs, at, (r) => { const copy = { ...r }; copy.id = uid('r'); return copy; });
  const start = split(offset);
  const end = split(offset + length);
  for (const run of paragraph.runs.slice(start, end)) {
    if (run.type === 'delete' || !run.text) continue;
    run.prior = { type: run.type, authorId: run.authorId, timestamp: run.timestamp };
    run.type = 'delete';
    run.authorId = opts.authorId;
    run.timestamp = opts.timestamp ?? new Date().toISOString();
  }
  return next;
}

function findChange(doc: TrackedDocument, changeId: string): TrackedRun {
  for (const paragraph of doc.paragraphs) {
    const run = paragraph.runs.find((r) => r.id === changeId);
    if (run) return run;
  }
  return fail('Unknown tracked change: ' + changeId);
}
export function getChange(doc: TrackedDocument, changeId: string): TrackedRun | undefined {
  try { return findChange(doc, changeId); } catch { return undefined; }
}

// Accept: inserted text becomes normal text; deleted text is removed.
export function acceptChange(doc: TrackedDocument, changeId: string): TrackedDocument {
  const next = clone(doc);
  const run = findChange(next, changeId);
  if (!isChange(run)) fail('Not a tracked change: ' + changeId);
  if (run.type === 'insert') { run.type = 'base'; delete run.authorId; delete run.timestamp; delete run.prior; }
  else paragraphRemoveRun(next, changeId);
  return next;
}
// Reject: inserted text is removed; deleted text is restored to its prior state.
export function rejectChange(doc: TrackedDocument, changeId: string): TrackedDocument {
  const next = clone(doc);
  const run = findChange(next, changeId);
  if (!isChange(run)) fail('Not a tracked change: ' + changeId);
  if (run.type === 'insert') paragraphRemoveRun(next, changeId);
  else {
    const prior = run.prior ?? { type: 'base' as RunType };
    run.type = prior.type;
    if (prior.type === 'base') { delete run.authorId; delete run.timestamp; }
    else { run.authorId = prior.authorId; run.timestamp = prior.timestamp; }
    delete run.prior;
  }
  return next;
}
function paragraphRemoveRun(doc: TrackedDocument, runId: string): void {
  for (const paragraph of doc.paragraphs) {
    const index = paragraph.runs.findIndex((r) => r.id === runId);
    if (index >= 0) { paragraph.runs.splice(index, 1); return; }
  }
  fail('Unknown tracked change: ' + runId);
}

export function acceptAll(doc: TrackedDocument): TrackedDocument {
  const next = clone(doc);
  for (const paragraph of next.paragraphs) {
    paragraph.runs = paragraph.runs.filter((r) => r.type !== 'delete');
    for (const run of paragraph.runs) if (run.type === 'insert') { run.type = 'base'; delete run.authorId; delete run.timestamp; }
  }
  return next;
}
export function rejectAll(doc: TrackedDocument): TrackedDocument {
  const next = clone(doc);
  for (const paragraph of next.paragraphs) {
    const kept: TrackedRun[] = [];
    for (const run of paragraph.runs) {
      if (run.type === 'insert') continue;
      if (run.type === 'delete') {
        const prior = run.prior;
        if (prior && prior.type !== 'base') continue; // text inserted then deleted inside the change window: undo both
        run.type = 'base';
        delete run.authorId;
        delete run.timestamp;
        delete run.prior;
      }
      kept.push(run);
    }
    paragraph.runs = kept;
  }
  return next;
}

export type TrackView = 'final' | 'original';
export function paragraphText(paragraph: TrackedParagraph, view: TrackView = 'final'): string {
  return paragraph.runs
    .filter((r) => view === 'final' ? r.type !== 'delete' : r.type !== 'insert')
    .map((r) => r.text)
    .join('');
}
export function documentText(doc: TrackedDocument, view: TrackView = 'final'): string[] {
  return doc.paragraphs.map((p) => paragraphText(p, view));
}
export function pendingChanges(doc: TrackedDocument): TrackedRun[] {
  return doc.paragraphs.flatMap((p) => p.runs.filter(isChange));
}
export function changeStats(doc: TrackedDocument): Record<string, { inserts: number; deletes: number }> {
  const stats: Record<string, { inserts: number; deletes: number }> = {};
  for (const run of pendingChanges(doc)) {
    const author = run.authorId ?? 'unknown';
    stats[author] ??= { inserts: 0, deletes: 0 };
    if (run.type === 'insert') stats[author]!.inserts++; else stats[author]!.deletes++;
  }
  return stats;
}

// ---- comment threads with replies ----

export function addCommentThread(doc: TrackedDocument, paragraphId: string, offset: number, length: number, opts: ChangeOptions & { text: string }): TrackedDocument {
  if (typeof opts.text !== 'string' || !opts.text.trim() || opts.text.length > 10000) fail('Invalid comment text');
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 0) fail('Invalid comment anchor');
  const next = clone(doc);
  requireAuthor(next, opts.authorId);
  const paragraph = requireParagraph(next, paragraphId);
  const visible = visibleLength(paragraph.runs);
  if (offset + length > visible) fail('Comment anchor outside paragraph');
  next.threads.push({
    id: uid('t'),
    paragraphId,
    anchor: { offset, length },
    resolved: false,
    comments: [{ id: uid('c'), authorId: opts.authorId, text: opts.text, timestamp: opts.timestamp ?? new Date().toISOString(), parentId: null }],
  });
  return next;
}

export function replyToComment(doc: TrackedDocument, threadId: string, parentId: string, opts: ChangeOptions & { text: string }): TrackedDocument {
  if (typeof opts.text !== 'string' || !opts.text.trim() || opts.text.length > 10000) fail('Invalid reply text');
  const next = clone(doc);
  requireAuthor(next, opts.authorId);
  const thread = next.threads.find((t) => t.id === threadId) ?? fail('Unknown comment thread: ' + threadId);
  const parent = thread.comments.find((c) => c.id === parentId) ?? fail('Unknown comment: ' + parentId);
  if (thread.comments.length > 200) fail('Comment thread too large');
  thread.comments.push({ id: uid('c'), authorId: opts.authorId, text: opts.text, timestamp: opts.timestamp ?? new Date().toISOString(), parentId: parent.id });
  return next;
}

export function setThreadResolved(doc: TrackedDocument, threadId: string, resolved: boolean): TrackedDocument {
  const next = clone(doc);
  const thread = next.threads.find((t) => t.id === threadId) ?? fail('Unknown comment thread: ' + threadId);
  thread.resolved = Boolean(resolved);
  return next;
}

// Remove one comment and its whole reply subtree; drop the thread if emptied.
export function removeComment(doc: TrackedDocument, threadId: string, commentId: string): TrackedDocument {
  const next = clone(doc);
  const index = next.threads.findIndex((t) => t.id === threadId);
  if (index < 0) fail('Unknown comment thread: ' + threadId);
  const thread = next.threads[index]!;
  const doomed = new Set<string>([commentId]);
  if (!thread.comments.some((c) => c.id === commentId)) fail('Unknown comment: ' + commentId);
  for (let grew = true; grew;) {
    grew = false;
    for (const comment of thread.comments) {
      if (comment.parentId && doomed.has(comment.parentId) && !doomed.has(comment.id)) { doomed.add(comment.id); grew = true; }
    }
  }
  thread.comments = thread.comments.filter((c) => !doomed.has(c.id));
  if (!thread.comments.length) next.threads.splice(index, 1);
  return next;
}

export function threadReplies(thread: CommentThread, commentId: string): CommentItem[] {
  return thread.comments.filter((c) => c.parentId === commentId);
}
