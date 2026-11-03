/** Pure DOM/offset glue between the contenteditable doc surface and the shared
 *  track-changes model (packages/shared/src/trackChanges.ts). Everything here is
 *  testable without a real editor: blocks are addressed by a `data-tp` attribute
 *  carrying the model paragraph id, visible offsets count only non-deleted text
 *  (deleted runs render as struck-through spans the caret must skip). */
import {
  createTrackedDocument, insertText, deleteText, documentText, registerAuthor,
  type CommentThread, type RevisionAuthor, type TrackedDocument, type TrackedParagraph, type TrackedRun, type TrackView,
} from '@shared/trackChanges';

export const TRACK_AUTHOR: RevisionAuthor = { id: 'local', name: 'مستخدم لوم' };

export const TRACK_PARAGRAPH_ATTR = 'data-tp';

/* ------------------------- surface ↔ paragraphs ------------------------- */

/** Text-flow blocks that map 1:1 onto model paragraphs: direct children of the
 *  surface, plus <li> children of top-level lists. Tables/images/stats stay
 *  untracked (the model is plain text only) and keep rendering as-is. */
export function trackedBlockList(root: ParentNode): HTMLElement[] {
  const blocks: HTMLElement[] = [];
  for (const child of Array.from(root.children) as HTMLElement[]) {
    const tag = child.tagName;
    if (tag === 'UL' || tag === 'OL' || tag === 'MENU') {
      for (const item of Array.from(child.children) as HTMLElement[]) {
        if (item.tagName === 'LI') blocks.push(item);
      }
      continue;
    }
    if (tag === 'TABLE' || tag === 'IMG' || tag === 'TEMPLATE' || tag === 'SCRIPT' || tag === 'STYLE') continue;
    blocks.push(child);
  }
  return blocks;
}

export function blockText(block: HTMLElement): string {
  return (block.textContent ?? '').replace(/\u00a0/g, ' ');
}

export function buildTrackedModel(texts: string[], authorName?: string): TrackedDocument {
  return registerAuthor(createTrackedDocument(texts), authorName?.trim() ? { id: authorName.trim(), name: authorName.trim() } : TRACK_AUTHOR);
}

/** Stamp every block with its model paragraph id (order defines the mapping). */
export function attachParagraphIds(blocks: HTMLElement[], doc: TrackedDocument): void {
  blocks.forEach((block, index) => {
    const paragraph = doc.paragraphs[index];
    if (paragraph) block.setAttribute(TRACK_PARAGRAPH_ATTR, paragraph.id);
  });
}

export function clearTrackMarkers(root: ParentNode): void {
  for (const block of Array.from(root.querySelectorAll(`[${TRACK_PARAGRAPH_ATTR}]`))) {
    block.removeAttribute(TRACK_PARAGRAPH_ATTR);
  }
}

/** Adopt a sidecar document only when its original (pre-change) text still
 *  matches the editor's current paragraphs; otherwise start fresh. */
export function adoptTrackedSidecar(sidecar: TrackedDocument | null, texts: string[]): TrackedDocument | null {
  if (!sidecar || !Array.isArray(sidecar.paragraphs)) return null;
  if (sidecar.paragraphs.length !== texts.length) return null;
  const original = documentText(sidecar, 'original');
  for (let i = 0; i < texts.length; i++) {
    if (original[i] !== texts[i]) return null;
  }
  return sidecar;
}

/** Paragraph-level plain-text replacement used by قبول الكل/رفض الكل: writes the
 *  resolved text of every tracked paragraph back onto the surface. */
export function applyDocumentTextToBlocks(blocks: HTMLElement[], doc: TrackedDocument, view: TrackView): void {
  const texts = documentText(doc, view);
  blocks.forEach((block, index) => {
    const text = texts[index];
    if (text !== undefined) block.textContent = text;
  });
}

/* ------------------------- visible-offset caret math ------------------------- */

const isDeleteRun = (node: Node): boolean =>
  node.nodeType === Node.ELEMENT_NODE && (node as Element).getAttribute('data-run') === 'delete';

function visibleChildren(node: Node): Node[] {
  return Array.from(node.childNodes).filter((child) => !isDeleteRun(child));
}

/** Total visible text length inside `block` (delete-run subtrees excluded). */
export function visibleTotal(block: Element): number {
  let total = 0;
  const visit = (node: Node): void => {
    for (const child of visibleChildren(node)) {
      if (child.nodeType === Node.TEXT_NODE) total += (child as Text).length;
      else visit(child);
    }
  };
  visit(block);
  return total;
}

/** Visible offset of `target`'s start within `block`, or null when `target` is
 *  not inside the block or sits inside a deleted run. */
export function nodeStartOffset(block: Element, target: Node): number | null {
  let seen = 0;
  const visit = (node: Node): boolean => {
    for (const child of visibleChildren(node)) {
      if (child === target) return true;
      if (child.nodeType === Node.TEXT_NODE) seen += (child as Text).length;
      else if (visit(child)) return true;
    }
    return false;
  };
  return visit(block) ? seen : null;
}

/** Visible offset of `target`'s end within `block` (start + its visible length). */
export function nodeEndOffset(block: Element, target: Node): number | null {
  const start = nodeStartOffset(block, target);
  if (start === null) return null;
  if (target.nodeType === Node.TEXT_NODE) return start + (target as Text).length;
  return start + visibleTotal(target as Element);
}

/** Map a DOM caret point (node + nodeOffset) onto a visible model offset. */
export function caretPointToOffset(block: Element, node: Node, offset: number): number | null {
  if (node === block) {
    const kids = visibleChildren(block);
    if (offset <= 0 || kids.length === 0) return 0;
    if (offset >= block.childNodes.length) return visibleTotal(block);
    const at = nodeStartOffset(block, kids[Math.min(offset, kids.length - 1)]!);
    return at ?? 0;
  }
  if (node.nodeType === Node.TEXT_NODE) {
    const start = nodeStartOffset(block, node);
    if (start === null) return null;
    return start + Math.max(0, Math.min(offset, (node as Text).length));
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    if (offset === 0) return nodeStartOffset(block, node);
    return nodeEndOffset(block, node);
  }
  return null;
}

/** Inverse: place the caret at a visible offset inside `block`, skipping
 *  deleted-run text. Empty paragraphs collapse the caret to the block start. */
export function placeCaret(block: Element, offset: number): boolean {
  const doc = block.ownerDocument ?? document;
  const selection = doc.defaultView?.getSelection();
  if (!selection) return false;
  const range = doc.createRange();
  const target = Math.max(0, Math.min(offset, visibleTotal(block)));
  let seen = 0;
  let placed = false;
  const visit = (node: Node): boolean => {
    for (const child of visibleChildren(node)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child as Text;
        if (target <= seen + text.length) {
          range.setStart(text, target - seen);
          placed = true;
          return true;
        }
        seen += text.length;
      } else if (visit(child)) return true;
    }
    return false;
  };
  visit(block);
  if (!placed) range.setStart(block, target === 0 ? 0 : block.childNodes.length);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

export interface ModelSelection {
  block: HTMLElement;
  paragraphId: string;
  start: number;
  end: number;
}

function caretBlock(node: Node | null, root: ParentNode): HTMLElement | null {
  let cursor: Node | null = node;
  while (cursor && cursor !== root) {
    if (cursor.nodeType === Node.ELEMENT_NODE) {
      const element = cursor as HTMLElement;
      if (element.getAttribute?.(TRACK_PARAGRAPH_ATTR)) return element;
    }
    cursor = cursor.parentNode;
  }
  return null;
}

/** Current selection mapped to {paragraphId, start, end} visible offsets, or
 *  null when the selection is not inside one tracked block. */
export function selectionToModel(root: ParentNode): ModelSelection | null {
  const doc = root.nodeType === Node.DOCUMENT_NODE ? (root as Document) : root.ownerDocument ?? document;
  const selection = doc.defaultView?.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const startBlock = caretBlock(range.startContainer, root);
  const endBlock = caretBlock(range.endContainer, root);
  if (!startBlock || (range.collapsed && !endBlock)) return null;
  if (!range.collapsed && (!endBlock || endBlock !== startBlock)) return null;
  const start = caretPointToOffset(startBlock, range.startContainer, range.startOffset);
  if (start === null) return null;
  let end = start;
  if (!range.collapsed && endBlock) {
    const mapped = caretPointToOffset(endBlock, range.endContainer, range.endOffset);
    if (mapped === null) return null;
    end = mapped;
  }
  const paragraphId = startBlock.getAttribute(TRACK_PARAGRAPH_ATTR) ?? '';
  return { block: startBlock, paragraphId, start: Math.min(start, end), end: Math.max(start, end) };
}

/* ------------------------- beforeinput translation ------------------------- */

export type EditIntent =
  | { kind: 'insert'; text: string }
  | { kind: 'delete'; direction: 'backward' | 'forward' }
  | { kind: 'unsupported'; reason: 'paragraph' | 'edit' };

/** Translate a beforeinput event into a model edit. Only plain-text edits are
 *  modelable; new paragraphs (Enter) and rich/format edits are unsupported. */
export function inputEventToIntent(event: { inputType: string; data?: string | null; dataTransfer?: { getData?: (type: string) => string } | null }): EditIntent | null {
  switch (event.inputType) {
    case 'insertText':
    case 'insertReplacementText':
      return event.data ? { kind: 'insert', text: event.data } : null;
    case 'insertFromPaste': {
      const text = event.dataTransfer?.getData?.('text/plain') ?? event.data ?? '';
      return text ? { kind: 'insert', text } : null;
    }
    case 'insertParagraph':
    case 'insertLineBreak':
      return { kind: 'unsupported', reason: 'paragraph' };
    case 'deleteContentBackward':
      return { kind: 'delete', direction: 'backward' };
    case 'deleteContentForward':
      return { kind: 'delete', direction: 'forward' };
    default:
      return { kind: 'unsupported', reason: 'edit' };
  }
}

const sanitizeInsert = (text: string): string => text.replace(/\r/g, '').replace(/\n+/g, ' ');

/** Merge typing artifacts produced one call at a time: adjacent base runs and
 *  adjacent insert runs by the same author become single runs (Word merges
 *  consecutive keystrokes the same way). Mutates and returns the same doc. */
export function coalesceRuns(doc: TrackedDocument): TrackedDocument {
  for (const paragraph of doc.paragraphs) {
    const kept: TrackedRun[] = [];
    for (const run of paragraph.runs) {
      const last = kept[kept.length - 1];
      const mergeable = last
        && last.type === run.type
        && last.type !== 'delete'
        && (last.type === 'base' || last.authorId === run.authorId);
      if (mergeable) last.text += run.text;
      else kept.push(run);
    }
    paragraph.runs = kept;
  }
  return doc;
}

export interface ApplyEditResult {
  doc: TrackedDocument;
  caret: number;
}

/** Apply a translated intent to the model at a visible offset. Returns null when
 *  the edit is a no-op (backspace at paragraph start, forward-delete at the end);
 *  TrackChangesError propagates to the caller. */
export function applyEdit(
  doc: TrackedDocument,
  paragraphId: string,
  offset: number,
  intent: EditIntent,
  opts: { authorId: string; timestamp?: string },
): ApplyEditResult | null {
  if (intent.kind === 'insert') {
    const text = sanitizeInsert(intent.text);
    if (!text) return null;
    const next = coalesceRuns(insertText(doc, paragraphId, offset, text, opts));
    return { doc: next, caret: offset + text.length };
  }
  if (intent.kind === 'delete') {
    const paragraph = doc.paragraphs.find((p) => p.id === paragraphId);
    if (!paragraph) return null;
    const total = visibleRunLength(paragraph);
    if (intent.direction === 'backward') {
      if (offset <= 0) return null;
      const next = coalesceRuns(deleteText(doc, paragraphId, offset - 1, 1, opts));
      return { doc: next, caret: offset - 1 };
    }
    if (offset >= total) return null;
    const next = coalesceRuns(deleteText(doc, paragraphId, offset, 1, opts));
    return { doc: next, caret: offset };
  }
  return null;
}

export function visibleRunLength(paragraph: TrackedParagraph): number {
  return paragraph.runs.reduce((n, run) => n + (run.type === 'delete' ? 0 : run.text.length), 0);
}

/* ------------------------- tracked rendering (pure) ------------------------- */

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const runTitle = (run: TrackedRun, authors: Record<string, RevisionAuthor>): string => {
  const author = run.authorId ? (authors[run.authorId]?.name ?? run.authorId) : '';
  return escapeHtml([author, run.timestamp ?? ''].filter(Boolean).join(' · '));
};

/** Render one paragraph's runs to html: insert runs green-underlined, delete
 *  runs red-struck (title = author + time, data-run="delete" so the caret math
 *  skips them), comment anchors wrapped in a subtle <mark>. */
export function renderTrackedParagraphHtml(
  paragraph: TrackedParagraph,
  threads: CommentThread[],
  authors: Record<string, RevisionAuthor>,
): string {
  const parts: string[] = [];
  const anchors = threads.filter((thread) => thread.paragraphId === paragraph.id && thread.anchor.length > 0);
  let emitted = 0; // visible chars emitted so far
  let openThreadIds: string[] = [];

  const covering = (position: number): string[] => anchors
    .filter((thread) => position >= thread.anchor.offset && position < thread.anchor.offset + thread.anchor.length)
    .map((thread) => thread.id);
  const closeMark = (): void => { if (openThreadIds.length) { parts.push('</mark>'); openThreadIds = []; } };
  const openMark = (threadIds: string[]): void => {
    const allResolved = threadIds.every((id) => anchors.find((thread) => thread.id === id)?.resolved);
    parts.push(`<mark class="loam-track-comment${allResolved ? ' loam-track-resolved' : ''}" data-threads="${escapeHtml(threadIds.join(','))}">`);
    openThreadIds = threadIds;
  };

  for (const run of paragraph.runs) {
    if (run.type === 'delete') {
      closeMark();
      parts.push(`<span data-run="delete" class="loam-track-del" title="${runTitle(run, authors)}">${escapeHtml(run.text)}</span>`);
      continue;
    }
    let runStart = 0;
    while (runStart < run.text.length) {
      const here = covering(emitted + runStart);
      if (here.join(',') !== openThreadIds.join(',')) {
        closeMark();
        if (here.length) openMark(here);
      }
      let runEnd = runStart + 1;
      while (runEnd < run.text.length && covering(emitted + runEnd).join(',') === here.join(',')) runEnd++;
      const chunk = escapeHtml(run.text.slice(runStart, runEnd));
      if (run.type === 'insert') {
        parts.push(`<ins data-run="insert" class="loam-track-ins" title="${runTitle(run, authors)}">${chunk}</ins>`);
      } else {
        parts.push(chunk);
      }
      runStart = runEnd;
    }
    emitted += run.text.length;
  }
  closeMark();
  return parts.join('');
}

/** Re-render every tracked block in the surface from the model. */
export function renderTrackedDocument(root: HTMLElement, doc: TrackedDocument): void {
  for (const paragraph of doc.paragraphs) {
    const block = root.querySelector<HTMLElement>(`[${TRACK_PARAGRAPH_ATTR}="${paragraph.id}"]`);
    if (block) block.innerHTML = renderTrackedParagraphHtml(paragraph, doc.threads, doc.authors);
  }
}
