import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TrackChangesPanel from '../TrackChangesPanel';
import {
  addCommentThread, createTrackedDocument, deleteText, insertText, pendingChanges,
  registerAuthor, replyToComment, type TrackedDocument,
} from '@shared/trackChanges';

const TIME = '2026-10-27T00:00:00.000Z';

function model(): TrackedDocument {
  let doc = createTrackedDocument(['Hello world', 'Second paragraph']);
  doc = registerAuthor(doc, { id: 'local', name: 'مستخدم لوم' });
  doc = insertText(doc, doc.paragraphs[0]!.id, 5, ' big', { authorId: 'local', timestamp: TIME });
  doc = deleteText(doc, doc.paragraphs[0]!.id, 10, 5, { authorId: 'local', timestamp: TIME });
  doc = addCommentThread(doc, doc.paragraphs[1]!.id, 0, 6, { authorId: 'local', text: 'لماذا هنا؟', timestamp: TIME });
  doc = replyToComment(doc, doc.threads[0]!.id, doc.threads[0]!.comments[0]!.id, { authorId: 'local', text: 'رد أولي', timestamp: TIME });
  return doc;
}

function harness(overrides: Partial<Parameters<typeof TrackChangesPanel>[0]> = {}) {
  const props = {
    doc: model(),
    notice: null,
    onAccept: vi.fn(),
    onReject: vi.fn(),
    onAcceptAll: vi.fn(),
    onRejectAll: vi.fn(),
    onCommentFromSelection: vi.fn(() => true),
    onReply: vi.fn(),
    onResolve: vi.fn(),
    onDeleteComment: vi.fn(),
    ...overrides,
  };
  return { props, view: render(<TrackChangesPanel {...props} />) };
}

describe('TrackChangesPanel', () => {
  it('lists pending inserts and deletes with author and time', () => {
    const { props } = harness();
    expect(screen.getAllByTitle('Accept')).toHaveLength(pendingChanges(props.doc).length);
    expect(screen.getByText('Insert')).toBeTruthy();
    expect(screen.getByText('Delete')).toBeTruthy();
    // author·time appears on each pending change (and again on comment items)
    expect(screen.getAllByText('مستخدم لوم · 2026-10-27 00:00').length).toBeGreaterThanOrEqual(pendingChanges(props.doc).length);
    expect(screen.getByText((_, element) => element?.textContent === ' big')).toBeTruthy();
    expect(screen.getByText('world')).toBeTruthy();
  });

  it('accepts and rejects individual changes through the callbacks', () => {
    const { props } = harness();
    const changes = pendingChanges(props.doc);
    fireEvent.click(screen.getAllByTitle('Accept')[0]!);
    fireEvent.click(screen.getAllByTitle('Reject')[1]!);
    expect(props.onAccept).toHaveBeenCalledWith(changes[0]!.id);
    expect(props.onReject).toHaveBeenCalledWith(changes[1]!.id);
  });

  it('fires bulk accept/reject', () => {
    const { props } = harness();
    fireEvent.click(screen.getByText('Accept all'));
    fireEvent.click(screen.getByText('Reject all'));
    expect(props.onAcceptAll).toHaveBeenCalledTimes(1);
    expect(props.onRejectAll).toHaveBeenCalledTimes(1);
  });

  it('shows the pending count and the empty state', () => {
    harness();
    expect(screen.getByText('2 pending')).toBeTruthy();
    let empty = createTrackedDocument(['x']);
    empty = registerAuthor(empty, { id: 'local', name: 'مستخدم لوم' });
    harness({ doc: empty });
    expect(screen.getByText('No pending changes')).toBeTruthy();
  });

  it('passes a typed comment to the selection callback and clears the draft', () => {
    const onCommentFromSelection = vi.fn(() => true);
    harness({ onCommentFromSelection });
    const input = screen.getAllByPlaceholderText('Write a reply…')[0]! as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'ملاحظة جديدة' } });
    fireEvent.click(screen.getByText('Comment'));
    expect(onCommentFromSelection).toHaveBeenCalledWith('ملاحظة جديدة');
    expect(input.value).toBe('');
  });

  it('keeps the comment draft when no text is selected (callback returns false)', () => {
    const onCommentFromSelection = vi.fn(() => false);
    harness({ onCommentFromSelection });
    const input = screen.getAllByPlaceholderText('Write a reply…')[0]! as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'ملاحظة' } });
    fireEvent.click(screen.getByText('Comment'));
    expect(onCommentFromSelection).toHaveBeenCalledWith('ملاحظة');
    expect(input.value).toBe('ملاحظة');
  });

  it('shows threads with replies and forwards reply/resolve/delete actions', () => {
    const { props } = harness();
    const thread = props.doc.threads[0]!;
    expect(screen.getByText('لماذا هنا؟')).toBeTruthy();
    expect(screen.getByText('رد أولي')).toBeTruthy();

    const replyInput = screen.getAllByPlaceholderText('Write a reply…')[1]! as HTMLInputElement;
    fireEvent.change(replyInput, { target: { value: 'رد ثانٍ' } });
    fireEvent.click(screen.getByText('Reply'));
    expect(props.onReply).toHaveBeenCalledWith(thread.id, thread.comments[0]!.id, 'رد ثانٍ');

    fireEvent.click(screen.getByLabelText('Resolved'));
    expect(props.onResolve).toHaveBeenCalledWith(thread.id, true);

    const deletes = screen.getAllByTitle('Delete comment');
    fireEvent.click(deletes[1]!); // reply delete
    expect(props.onDeleteComment).toHaveBeenCalledWith(thread.id, thread.comments[1]!.id);
  });

  it('renders the notice when present', () => {
    harness({ notice: 'Saved tracked changes no longer match this document — starting fresh.' });
    expect(screen.getByText('Saved tracked changes no longer match this document — starting fresh.')).toBeTruthy();
  });
});
