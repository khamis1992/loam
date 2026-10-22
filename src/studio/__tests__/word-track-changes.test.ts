import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  TrackChangesError,
  createTrackedDocument,
  registerAuthor,
  insertText,
  deleteText,
  acceptChange,
  rejectChange,
  acceptAll,
  rejectAll,
  pendingChanges,
  paragraphText,
  documentText,
  changeStats,
  getChange,
  addCommentThread,
  replyToComment,
  setThreadResolved,
  removeComment,
  threadReplies,
} from '../word-track-changes.js';

const TIME = '2026-10-21T00:00:00.000Z';
function base() {
  let doc = createTrackedDocument(['Hello world', 'Second paragraph']);
  doc = registerAuthor(doc, { id: 'a1', name: 'Amal' });
  doc = registerAuthor(doc, { id: 'a2', name: 'Bilal' });
  return doc;
}

describe('tracked changes', () => {
  it('inserts and deletes runs with author and time, keeping originals', () => {
    const doc0 = base();
    const p0 = doc0.paragraphs[0]!.id;
    const doc1 = insertText(doc0, p0, 5, ' big', { authorId: 'a1', timestamp: TIME });
    const doc2 = deleteText(doc1, p0, 10, 5, { authorId: 'a2', timestamp: TIME });
    assert.deepStrictEqual(documentText(doc2, 'final'), ['Hello big ', 'Second paragraph']);
    assert.deepStrictEqual(documentText(doc2, 'original'), ['Hello world', 'Second paragraph']);
    const changes = pendingChanges(doc2);
    assert.strictEqual(changes.length, 2);
    assert.strictEqual(changes[0]!.type, 'insert');
    assert.strictEqual(changes[0]!.authorId, 'a1');
    assert.strictEqual(changes[0]!.timestamp, TIME);
    assert.strictEqual(changes[1]!.type, 'delete');
    assert.strictEqual(changes[1]!.text, 'world');
    // purity: earlier documents are untouched
    assert.deepStrictEqual(documentText(doc0), ['Hello world', 'Second paragraph']);
    assert.deepStrictEqual(documentText(doc1, 'final'), ['Hello big world', 'Second paragraph']);
  });
  it('accepts an insertion and a deletion', () => {
    let doc = base();
    const p = doc.paragraphs[0]!.id;
    doc = insertText(doc, p, 0, 'Oh ', { authorId: 'a1', timestamp: TIME });
    doc = deleteText(doc, p, 3, 6, { authorId: 'a1', timestamp: TIME }); // 'Hello '
    const ins = doc.paragraphs[0]!.runs.find((r) => r.type === 'insert')!;
    const del = doc.paragraphs[0]!.runs.find((r) => r.type === 'delete')!;
    doc = acceptChange(doc, ins.id);
    doc = acceptChange(doc, del.id);
    assert.deepStrictEqual(documentText(doc), ['Oh world', 'Second paragraph']);
    assert.strictEqual(pendingChanges(doc).length, 0);
    assert.throws(() => acceptChange(doc, ins.id), TrackChangesError);
  });
  it('rejects an insertion and restores a deletion', () => {
    let doc = base();
    const p = doc.paragraphs[0]!.id;
    doc = insertText(doc, p, 11, '!', { authorId: 'a2', timestamp: TIME });
    doc = deleteText(doc, p, 6, 5, { authorId: 'a2', timestamp: TIME });
    for (const c of pendingChanges(doc)) doc = rejectChange(doc, c.id);
    assert.deepStrictEqual(documentText(doc), ['Hello world', 'Second paragraph']);
    assert.strictEqual(pendingChanges(doc).length, 0);
  });
  it('rejecting a deletion of an insertion restores the pending insert', () => {
    let doc = base();
    const p = doc.paragraphs[0]!.id;
    doc = insertText(doc, p, 5, ' there', { authorId: 'a1', timestamp: TIME });
    const ins = pendingChanges(doc)[0]!;
    doc = deleteText(doc, p, 5, 6, { authorId: 'a2', timestamp: TIME });
    const del = pendingChanges(doc)[0]!;
    assert.strictEqual(del.prior?.type, 'insert');
    assert.strictEqual(del.prior?.authorId, 'a1');
    doc = rejectChange(doc, del.id);
    assert.strictEqual(pendingChanges(doc).length, 1);
    assert.strictEqual(pendingChanges(doc)[0]!.id, ins.id);
    assert.deepStrictEqual(documentText(doc, 'final'), ['Hello there world', 'Second paragraph']);
  });
  it('acceptAll and rejectAll', () => {
    let doc = base();
    const p = doc.paragraphs[0]!.id;
    doc = insertText(doc, p, 5, ' there', { authorId: 'a1', timestamp: TIME });
    doc = deleteText(doc, p, 6, 5, { authorId: 'a2', timestamp: TIME });
    assert.deepStrictEqual(changeStats(doc), { a1: { inserts: 1, deletes: 0 }, a2: { inserts: 0, deletes: 1 } });
    assert.deepStrictEqual(documentText(acceptAll(doc)), ['Hello  world', 'Second paragraph']);
    assert.deepStrictEqual(documentText(rejectAll(doc)), ['Hello world', 'Second paragraph']);
    assert.strictEqual(pendingChanges(acceptAll(doc)).length, 0);
    assert.strictEqual(pendingChanges(rejectAll(doc)).length, 0);
  });
  it('splits multi-run ranges correctly', () => {
    let doc = base();
    const p = doc.paragraphs[0]!.id;
    doc = insertText(doc, p, 5, ' BRAVE', { authorId: 'a1', timestamp: TIME });
    doc = insertText(doc, p, 0, '>> ', { authorId: 'a2', timestamp: TIME });
    doc = deleteText(doc, p, 0, 8, { authorId: 'a1', timestamp: TIME }); // '>> Hello'
    assert.deepStrictEqual(documentText(doc, 'final'), [' BRAVE world', 'Second paragraph']);
    assert.strictEqual(pendingChanges(doc).filter((r) => r.type === 'delete').length, 2);
    assert.ok(getChange(doc, pendingChanges(doc)[0]!.id));
    assert.strictEqual(getChange(doc, 'nope'), undefined);
  });
  it('validates inputs', () => {
    let doc = base();
    const p = doc.paragraphs[0]!.id;
    assert.throws(() => insertText(doc, p, 0, '', { authorId: 'a1', timestamp: TIME }), TrackChangesError);
    assert.throws(() => insertText(doc, p, 0, 'x', { authorId: 'ghost', timestamp: TIME }), TrackChangesError);
    assert.throws(() => insertText(doc, 'nope', 0, 'x', { authorId: 'a1', timestamp: TIME }), TrackChangesError);
    assert.throws(() => insertText(doc, p, 99, 'x', { authorId: 'a1', timestamp: TIME }), TrackChangesError);
    assert.throws(() => deleteText(doc, p, 0, 0, { authorId: 'a1', timestamp: TIME }), TrackChangesError);
    assert.throws(() => deleteText(doc, p, 5, 999, { authorId: 'a1', timestamp: TIME }), TrackChangesError);
    assert.throws(() => registerAuthor(doc, { id: 'a1', name: 'Other' }), TrackChangesError);
    doc = registerAuthor(doc, { id: 'a1', name: 'Amal' }); // idempotent
    assert.strictEqual(doc.authors.a1!.name, 'Amal');
    assert.throws(() => createTrackedDocument('not an array'), TrackChangesError);
  });
});

describe('comment threads', () => {
  function commented() {
    let doc = base();
    const p = doc.paragraphs[0]!.id;
    doc = addCommentThread(doc, p, 6, 5, { authorId: 'a1', text: 'Why world?', timestamp: TIME });
    return doc;
  }
  it('adds a thread and replies with parent links', () => {
    let doc = commented();
    const thread = doc.threads[0]!;
    assert.strictEqual(thread.anchor.offset, 6);
    assert.strictEqual(thread.comments.length, 1);
    const root = thread.comments[0]!;
    doc = replyToComment(doc, thread.id, root.id, { authorId: 'a2', text: 'Because it fits.', timestamp: TIME });
    doc = replyToComment(doc, thread.id, root.id, { authorId: 'a1', text: 'OK.', timestamp: TIME });
    const t2 = doc.threads[0]!;
    assert.strictEqual(t2.comments.length, 3);
    assert.strictEqual(t2.comments[1]!.parentId, root.id);
    assert.deepStrictEqual(threadReplies(t2, root.id).map((c) => c.id), [t2.comments[1]!.id, t2.comments[2]!.id]);
    assert.strictEqual(threadReplies(t2, t2.comments[1]!.id).length, 0);
  });
  it('removes a comment with its reply subtree and empty threads', () => {
    let doc = commented();
    const root = doc.threads[0]!.comments[0]!;
    doc = replyToComment(doc, doc.threads[0]!.id, root.id, { authorId: 'a2', text: 'Reply', timestamp: TIME });
    const reply = doc.threads[0]!.comments[1]!;
    doc = replyToComment(doc, doc.threads[0]!.id, reply.id, { authorId: 'a1', text: 'Nested', timestamp: TIME });
    doc = removeComment(doc, doc.threads[0]!.id, root.id);
    assert.strictEqual(doc.threads.length, 0);
  });
  it('resolves threads and keeps comments', () => {
    let doc = commented();
    const before = doc.threads[0]!.id;
    doc = setThreadResolved(doc, before, true);
    assert.strictEqual(doc.threads[0]!.resolved, true);
    assert.strictEqual(doc.threads[0]!.comments.length, 1);
  });
  it('validates comment input', () => {
    const doc = commented();
    const t = doc.threads[0]!;
    assert.throws(() => addCommentThread(doc, 'nope', 0, 1, { authorId: 'a1', text: 'x', timestamp: TIME }), TrackChangesError);
    assert.throws(() => addCommentThread(doc, t.paragraphId, 0, 999, { authorId: 'a1', text: 'x', timestamp: TIME }), TrackChangesError);
    assert.throws(() => addCommentThread(doc, t.paragraphId, 0, 1, { authorId: 'ghost', text: 'x', timestamp: TIME }), TrackChangesError);
    assert.throws(() => addCommentThread(doc, t.paragraphId, 0, 1, { authorId: 'a1', text: '  ', timestamp: TIME }), TrackChangesError);
    assert.throws(() => replyToComment(doc, 'nope', t.comments[0]!.id, { authorId: 'a1', text: 'x', timestamp: TIME }), TrackChangesError);
    assert.throws(() => replyToComment(doc, t.id, 'nope', { authorId: 'a1', text: 'x', timestamp: TIME }), TrackChangesError);
    assert.throws(() => setThreadResolved(doc, 'nope', true), TrackChangesError);
    assert.throws(() => removeComment(doc, t.id, 'nope'), TrackChangesError);
  });
  it('anchors into the visible text', () => {
    let doc = base();
    const p = doc.paragraphs[0]!.id;
    doc = insertText(doc, p, 5, ' big', { authorId: 'a1', timestamp: TIME });
    doc = addCommentThread(doc, p, 0, doc.paragraphs[0]!.runs.reduce((n, r) => n + (r.type === 'delete' ? 0 : r.text.length), 0), { authorId: 'a2', text: 'all visible', timestamp: TIME });
    assert.strictEqual(paragraphText(doc.paragraphs[0]!, 'final'), 'Hello big world');
    assert.strictEqual(doc.threads.length, 1);
  });
});
