import { describe, expect, it } from 'vitest';
import * as shared from '@shared/trackChanges';

/** The single source of truth for the model is packages/shared/src/trackChanges.ts
 *  (src/studio/word-track-changes.ts re-exports it). The web feature imports it
 *  through the @shared alias; make sure that resolves and behaves. */
describe('shared track-changes model via @shared alias', () => {
  it('re-exports the full model surface', () => {
    for (const name of [
      'TrackChangesError', 'createTrackedDocument', 'registerAuthor', 'insertText', 'deleteText',
      'acceptChange', 'rejectChange', 'acceptAll', 'rejectAll', 'pendingChanges', 'paragraphText',
      'documentText', 'changeStats', 'getChange', 'addCommentThread', 'replyToComment',
      'setThreadResolved', 'removeComment', 'threadReplies',
    ]) {
      expect(shared, `${name} must be exported`).toHaveProperty(name);
    }
  });

  it('runs a tracked edit through the aliased module', () => {
    let doc = shared.createTrackedDocument(['Hello world']);
    doc = shared.registerAuthor(doc, { id: 'local', name: 'مستخدم لوم' });
    doc = shared.insertText(doc, doc.paragraphs[0]!.id, 5, ' big', { authorId: 'local', timestamp: '2026-10-27T00:00:00.000Z' });
    expect(shared.documentText(doc)).toEqual(['Hello big world']);
    expect(shared.pendingChanges(doc)).toHaveLength(1);
  });
});
