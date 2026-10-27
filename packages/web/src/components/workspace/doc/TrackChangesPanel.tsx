'use client';

/** Review side panel for the doc editor's track-changes mode: pending change
 *  list with per-change and bulk accept/reject, plus comment threads with
 *  replies, resolve and delete. Purely presentational — the editor owns the
 *  model and applies every mutation through the callbacks. */
import { useState } from 'react';
import { Check, ChevronDown, ChevronUp, MessageSquare, Undo2, X } from 'lucide-react';
import { t } from '@/i18n/t';
import {
  paragraphText, pendingChanges, threadReplies,
  type CommentThread, type TrackedDocument, type TrackedRun,
} from '@shared/trackChanges';

const snippet = (text: string, max = 40): string => (text.length > max ? `${text.slice(0, max)}…` : text);
const shortTime = (iso?: string): string => (iso ? iso.slice(0, 16).replace('T', ' ') : '');

export interface TrackChangesPanelProps {
  doc: TrackedDocument;
  notice?: string | null;
  onAccept: (changeId: string) => void;
  onReject: (changeId: string) => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  /** Reads the editor selection and anchors a new thread; false when no text is selected. */
  onCommentFromSelection: (text: string) => boolean;
  onReply: (threadId: string, parentId: string, text: string) => void;
  onResolve: (threadId: string, resolved: boolean) => void;
  onDeleteComment: (threadId: string, commentId: string) => void;
}

export default function TrackChangesPanel({
  doc, notice, onAccept, onReject, onAcceptAll, onRejectAll, onCommentFromSelection, onReply, onResolve, onDeleteComment,
}: TrackChangesPanelProps) {
  const [open, setOpen] = useState(true);
  const [commentDraft, setCommentDraft] = useState('');
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});

  const changes = pendingChanges(doc);
  const authorName = (change: TrackedRun): string => (change.authorId ? (doc.authors[change.authorId]?.name ?? change.authorId) : '');
  const anchoredText = (thread: CommentThread): string => {
    const paragraph = doc.paragraphs.find((p) => p.id === thread.paragraphId);
    if (!paragraph) return '';
    return paragraphText(paragraph).slice(thread.anchor.offset, thread.anchor.offset + thread.anchor.length);
  };
  const threadRoot = (thread: CommentThread) => thread.comments[0];

  const submitComment = (): void => {
    const text = commentDraft.trim();
    if (!text) return;
    if (onCommentFromSelection(text)) setCommentDraft('');
  };
  const submitReply = (thread: CommentThread): void => {
    const root = threadRoot(thread);
    const text = (replyDrafts[thread.id] ?? '').trim();
    if (!root || !text) return;
    onReply(thread.id, root.id, text);
    setReplyDrafts((current) => ({ ...current, [thread.id]: '' }));
  };

  return (
    <section className="border-t border-border-main bg-bg-menu text-text-primary" aria-label={t('Tracked changes')}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex min-h-9 w-full items-center gap-2 px-3 py-2 text-sm hover:bg-fill-hover"
      >
        <MessageSquare className="size-4 text-brand" />
        <span className="font-medium">{t('Tracked changes')}</span>
        <span className="rounded-control bg-fill-tsp px-1.5 text-[11px] text-text-secondary">
          {t('{count} pending', { count: changes.length })}
        </span>
        <span className="flex-1" />
        {open ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
      </button>
      {open && (
        <div className="flex max-h-[45vh] flex-col gap-3 overflow-y-auto border-t border-border-light p-3 text-sm">
          {notice ? <p role="status" className="text-[11px] text-text-secondary">{notice}</p> : null}

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-text-secondary">{t('Pending changes')}</span>
            <span className="flex-1" />
            <button type="button" onClick={onAcceptAll} disabled={!changes.length}
              className="min-h-8 rounded-control border border-border-main px-2 text-xs text-text-secondary hover:bg-fill-hover disabled:opacity-40">
              {t('Accept all')}
            </button>
            <button type="button" onClick={onRejectAll} disabled={!changes.length}
              className="min-h-8 rounded-control border border-border-main px-2 text-xs text-text-secondary hover:bg-fill-hover disabled:opacity-40">
              {t('Reject all')}
            </button>
          </div>

          {changes.length === 0 ? (
            <p className="text-xs text-text-tertiary">{t('No pending changes')}</p>
          ) : (
            <ul className="flex flex-col gap-1.5" aria-label={t('Pending changes')}>
              {changes.map((change) => (
                <li key={change.id} className="flex flex-wrap items-center gap-2 rounded-control border border-border-light px-2 py-1.5">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${change.type === 'insert' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                    {change.type === 'insert' ? t('Insert') : t('Delete')}
                  </span>
                  <span className="min-w-0 flex-1 truncate" dir="auto">{snippet(change.text)}</span>
                  <span className="text-[10px] text-text-tertiary">{authorName(change)} · {shortTime(change.timestamp)}</span>
                  <button type="button" onClick={() => onAccept(change.id)} title={t('Accept')} aria-label={`${t('Accept')} ${snippet(change.text, 12)}`}
                    className="min-h-7 rounded-control border border-border-main px-1.5 text-green-700 hover:bg-fill-hover">
                    <Check className="size-3.5" />
                  </button>
                  <button type="button" onClick={() => onReject(change.id)} title={t('Reject')} aria-label={`${t('Reject')} ${snippet(change.text, 12)}`}
                    className="min-h-7 rounded-control border border-border-main px-1.5 text-red-700 hover:bg-fill-hover">
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center gap-2 border-t border-border-light pt-2">
            <span className="text-xs font-medium text-text-secondary">{t('Comments')}</span>
          </div>
          <div className="flex items-center gap-2">
            <input
              value={commentDraft}
              onChange={(event) => setCommentDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submitComment(); } }}
              placeholder={t('Write a reply…')}
              className="h-8 flex-1 rounded-control border border-border-main bg-bg-main px-2 text-xs outline-none focus:border-brand"
            />
            <button type="button" onClick={submitComment} disabled={!commentDraft.trim()}
              className="min-h-8 rounded-control border border-border-main px-2 text-xs text-text-secondary hover:bg-fill-hover disabled:opacity-40">
              {t('Comment')}
            </button>
          </div>

          {doc.threads.length === 0 ? (
            <p className="text-xs text-text-tertiary">{t('Select text in the document to comment.')}</p>
          ) : (
            <ul className="flex flex-col gap-2" aria-label={t('Comments')}>
              {doc.threads.map((thread) => {
                const root = threadRoot(thread);
                if (!root) return null;
                const replies = thread.comments.filter((comment) => comment.parentId);
                return (
                  <li key={thread.id} className={`rounded-control border px-2 py-1.5 ${thread.resolved ? 'border-border-light opacity-60' : 'border-border-main'}`}>
                    <div className="flex items-center gap-2">
                      <mark className="min-w-0 flex-1 truncate rounded bg-yellow-100 px-1 text-[11px]" dir="auto">{snippet(anchoredText(thread), 30)}</mark>
                      <label className="flex items-center gap-1 text-[11px] text-text-secondary">
                        <input type="checkbox" checked={thread.resolved} onChange={(event) => onResolve(thread.id, event.target.checked)} />
                        {t('Resolved')}
                      </label>
                    </div>
                    <div className="mt-1 flex items-start gap-1.5">
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] text-text-secondary">{doc.authors[root.authorId]?.name ?? root.authorId} · {shortTime(root.timestamp)}</p>
                        <p dir="auto">{root.text}</p>
                      </div>
                      <button type="button" onClick={() => onDeleteComment(thread.id, root.id)} title={t('Delete comment')} aria-label={t('Delete comment')}
                        className="min-h-7 rounded-control border border-border-main px-1 text-text-tertiary hover:bg-fill-hover">
                        <X className="size-3" />
                      </button>
                    </div>
                    {replies.map((reply) => (
                      <div key={reply.id} className="mt-1 flex items-start gap-1.5 border-t border-border-light pt-1 ps-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-[11px] text-text-secondary">{doc.authors[reply.authorId]?.name ?? reply.authorId} · {shortTime(reply.timestamp)}</p>
                          <p dir="auto">{reply.text}</p>
                        </div>
                        <button type="button" onClick={() => onDeleteComment(thread.id, reply.id)} title={t('Delete comment')} aria-label={t('Delete comment')}
                          className="min-h-7 rounded-control border border-border-main px-1 text-text-tertiary hover:bg-fill-hover">
                          <X className="size-3" />
                        </button>
                      </div>
                    ))}
                    <div className="mt-1 flex items-center gap-2">
                      <input
                        value={replyDrafts[thread.id] ?? ''}
                        onChange={(event) => setReplyDrafts((current) => ({ ...current, [thread.id]: event.target.value }))}
                        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submitReply(thread); } }}
                        placeholder={t('Write a reply…')}
                        className="h-7 flex-1 rounded-control border border-border-main bg-bg-main px-2 text-[11px] outline-none focus:border-brand"
                      />
                      <button type="button" onClick={() => submitReply(thread)} disabled={!(replyDrafts[thread.id] ?? '').trim()}
                        className="min-h-7 rounded-control border border-border-main px-2 text-[11px] text-text-secondary hover:bg-fill-hover disabled:opacity-40">
                        <Undo2 className="me-1 inline size-3" />{t('Reply')}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
