import { describe, expect, it } from 'vitest';
import {
  acceptAll, addCommentThread, createTrackedDocument, deleteText, insertText, pendingChanges,
  registerAuthor, setThreadResolved, type TrackedDocument,
} from '@shared/trackChanges';
import {
  adoptTrackedSidecar, applyDocumentTextToBlocks, applyEdit, attachParagraphIds, blockText,
  buildTrackedModel, clearTrackMarkers, coalesceRuns, inputEventToIntent, caretPointToOffset,
  nodeStartOffset, placeCaret, renderTrackedDocument, renderTrackedParagraphHtml, selectionToModel,
  trackedBlockList, TRACK_AUTHOR, visibleTotal,
} from '../trackEditing';

const TIME = '2026-10-27T00:00:00.000Z';

function tracked(...texts: string[]): TrackedDocument {
  let doc = createTrackedDocument(texts);
  doc = registerAuthor(doc, TRACK_AUTHOR);
  return doc;
}

function editedDoc(): TrackedDocument {
  let doc = tracked('Hello world', 'Second');
  doc = insertText(doc, doc.paragraphs[0]!.id, 5, ' big', { authorId: TRACK_AUTHOR.id, timestamp: TIME });
  doc = deleteText(doc, doc.paragraphs[0]!.id, 10, 5, { authorId: TRACK_AUTHOR.id, timestamp: TIME });
  return doc;
}

describe('trackedBlockList', () => {
  it('maps paragraphs, headings and list items; skips tables and images', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>a</p><h1>b</h1><ul><li>c</li><li>d</li></ul><table><tr><td>t</td></tr></table><img src="x"/><p>e</p>';
    const texts = trackedBlockList(root).map(blockText);
    expect(texts).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('normalizes nbsp in block text', () => {
    const block = document.createElement('p');
    block.innerHTML = 'a&nbsp;b';
    expect(blockText(block)).toBe('a b');
  });
});

describe('sidecar adoption', () => {
  it('adopts a sidecar whose original text still matches', () => {
    const sidecar = editedDoc();
    expect(adoptTrackedSidecar(sidecar, ['Hello world', 'Second'])).toBe(sidecar);
  });

  it('refuses a sidecar after the document text changed or its length differs', () => {
    const sidecar = editedDoc();
    expect(adoptTrackedSidecar(sidecar, ['Hello world!', 'Second'])).toBeNull();
    expect(adoptTrackedSidecar(sidecar, ['Hello world'])).toBeNull();
    expect(adoptTrackedSidecar(null, ['Hello world'])).toBeNull();
  });
});

describe('applyDocumentTextToBlocks', () => {
  it('writes the resolved plain text back paragraph by paragraph', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>old one</p><p>old two</p>';
    const blocks = trackedBlockList(root);
    const resolved = acceptAll(editedDoc());
    applyDocumentTextToBlocks(blocks, resolved, 'final');
    expect(blocks.map((block) => block.textContent)).toEqual(['Hello big ', 'Second']);
    expect(blocks[0]!.querySelector('.loam-track-ins')).toBeNull();
  });
});

describe('visible-offset caret math', () => {
  function renderedParagraph(): HTMLElement {
    // 'Hello ' base + ' big' inserted + 'wor' base + 'ld' deleted + 'l'? — build via the model renderer
    const doc = editedDoc();
    const block = document.createElement('p');
    block.innerHTML = renderTrackedParagraphHtml(doc.paragraphs[0]!, doc.threads, doc.authors);
    return block;
  }

  it('renders base/insert/delete runs with the right classes', () => {
    const block = renderedParagraph();
    expect(block.querySelector('.loam-track-ins')!.textContent).toBe(' big');
    expect(block.querySelector('.loam-track-del')!.textContent).toBe('world');
    // textContent = visible text plus the struck-through deleted text
    expect(block.textContent).toBe('Hello big world');
  });

  it('visibleTotal skips deleted runs', () => {
    const block = renderedParagraph();
    expect(visibleTotal(block)).toBe('Hello big '.length);
  });

  it('maps caret points on text nodes to model offsets, skipping deletes', () => {
    const block = renderedParagraph();
    // text nodes in order: 'Hello'(base) ' big'(insert) ' '(base) 'world'(deleted)
    const textNodes = Array.from(block.getElementsByTagName('*'))
      .flatMap((element) => Array.from(element.childNodes))
      .concat(Array.from(block.childNodes))
      .filter((node) => node.nodeType === Node.TEXT_NODE) as Text[];
    const hello = textNodes.find((node) => node.data === 'Hello')!;
    const big = textNodes.find((node) => node.data === ' big')!;
    const deleted = textNodes.find((node) => node.data === 'world')!;
    expect(caretPointToOffset(block, hello, 0)).toBe(0);
    expect(caretPointToOffset(block, hello, 5)).toBe(5);
    expect(caretPointToOffset(block, big, 2)).toBe(7);
    // a caret inside a deleted run cannot be represented
    expect(caretPointToOffset(block, deleted, 1)).toBeNull();
    expect(nodeStartOffset(block, deleted)).toBeNull();
  });

  it('placeCaret restores a model offset and skips deleted text (round trip)', () => {
    const block = renderedParagraph();
    document.body.appendChild(block);
    expect(placeCaret(block, 8)).toBe(true);
    const selection = window.getSelection()!;
    expect(selection.rangeCount).toBeGreaterThan(0);
    const anchor = selection.anchorNode!;
    expect(caretPointToOffset(block, anchor, selection.anchorOffset)).toBe(8);
    // offset 0 in an "empty-ish" leading position and clamping beyond the end
    expect(placeCaret(block, 0)).toBe(true);
    expect(caretPointToOffset(block, window.getSelection()!.anchorNode!, window.getSelection()!.anchorOffset!)).toBe(0);
    expect(placeCaret(block, 999)).toBe(true);
    expect(caretPointToOffset(block, window.getSelection()!.anchorNode!, window.getSelection()!.anchorOffset!)).toBe(visibleTotal(block));
    document.body.removeChild(block);
  });

  it('selectionToModel resolves the tracked block and paragraph id', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>one</p><p>two</p>';
    document.body.appendChild(root); // jsdom's Selection only tracks ranges inside the document
    const doc = buildTrackedModel(['one', 'two']);
    attachParagraphIds(trackedBlockList(root), doc);
    const second = root.querySelectorAll('p')[1]!;
    const text = second.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 1);
    range.setEnd(text, 3);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const model = selectionToModel(root)!;
    expect(model.paragraphId).toBe(doc.paragraphs[1]!.id);
    expect(model.start).toBe(1);
    expect(model.end).toBe(3);
    clearTrackMarkers(root);
    expect(selectionToModel(root)).toBeNull();
    document.body.removeChild(root);
  });
});

describe('inputEventToIntent', () => {
  it('maps plain-text inserts, deletes and paste', () => {
    expect(inputEventToIntent({ inputType: 'insertText', data: 'a' })).toEqual({ kind: 'insert', text: 'a' });
    expect(inputEventToIntent({ inputType: 'insertFromPaste', data: 'pasted', dataTransfer: { getData: () => 'from dt' } }))
      .toEqual({ kind: 'insert', text: 'from dt' });
    expect(inputEventToIntent({ inputType: 'deleteContentBackward' })).toEqual({ kind: 'delete', direction: 'backward' });
    expect(inputEventToIntent({ inputType: 'deleteContentForward' })).toEqual({ kind: 'delete', direction: 'forward' });
  });

  it('flags paragraphs and unknown edits as unsupported, empty inserts as null', () => {
    expect(inputEventToIntent({ inputType: 'insertParagraph' })).toEqual({ kind: 'unsupported', reason: 'paragraph' });
    expect(inputEventToIntent({ inputType: 'formatBold' })).toEqual({ kind: 'unsupported', reason: 'edit' });
    expect(inputEventToIntent({ inputType: 'insertText', data: null })).toBeNull();
    expect(inputEventToIntent({ inputType: 'insertFromPaste', data: null })).toBeNull();
  });
});

describe('applyEdit', () => {
  it('applies an insert at the caret offset and moves the caret past it', () => {
    const doc = tracked('Hello world');
    const p = doc.paragraphs[0]!.id;
    const result = applyEdit(doc, p, 5, { kind: 'insert', text: ' big' }, { authorId: TRACK_AUTHOR.id })!;
    expect(result.caret).toBe(9);
    expect(result.doc.paragraphs[0]!.runs.map((run) => run.type)).toEqual(['base', 'insert', 'base']);
  });

  it('coalesces consecutive same-author keystrokes into one insert run', () => {
    const doc = tracked('ab');
    const p = doc.paragraphs[0]!.id;
    let current = doc;
    let caret = 2;
    for (const char of ['x', 'y', 'z']) {
      const step = applyEdit(current, p, caret, { kind: 'insert', text: char }, { authorId: TRACK_AUTHOR.id })!;
      current = step.doc;
      caret = step.caret;
    }
    expect(pendingChanges(current)).toHaveLength(1);
    expect(pendingChanges(current)[0]!.text).toBe('xyz');
  });

  it('sanitizes pasted newlines into spaces (no new paragraphs)', () => {
    const doc = tracked('ab');
    const result = applyEdit(doc, doc.paragraphs[0]!.id, 2, { kind: 'insert', text: 'x\ny\r\nz' }, { authorId: TRACK_AUTHOR.id })!;
    expect(result.doc.paragraphs[0]!.runs[1]!.text).toBe('x y z');
  });

  it('applies backward/forward deletes and returns null at paragraph boundaries', () => {
    const doc = tracked('abc');
    const p = doc.paragraphs[0]!.id;
    const back = applyEdit(doc, p, 2, { kind: 'delete', direction: 'backward' }, { authorId: TRACK_AUTHOR.id })!;
    expect(back.caret).toBe(1);
    expect(back.doc.paragraphs[0]!.runs.map((run) => run.type)).toEqual(['base', 'delete', 'base']);
    const forward = applyEdit(doc, p, 0, { kind: 'delete', direction: 'forward' }, { authorId: TRACK_AUTHOR.id })!;
    expect(forward.doc.paragraphs[0]!.runs.map((run) => run.type)).toEqual(['delete', 'base']);
    expect(applyEdit(doc, p, 0, { kind: 'delete', direction: 'backward' }, { authorId: TRACK_AUTHOR.id })).toBeNull();
    expect(applyEdit(doc, p, 3, { kind: 'delete', direction: 'forward' }, { authorId: TRACK_AUTHOR.id })).toBeNull();
  });

  it('coalesceRuns merges adjacent base runs and same-author inserts only', () => {
    const doc = tracked('ab');
    const p = doc.paragraphs[0]!.id;
    let current = coalesceRuns(insertText(doc, p, 1, 'x', { authorId: TRACK_AUTHOR.id, timestamp: TIME }));
    current = coalesceRuns(insertText(current, p, 2, 'y', { authorId: TRACK_AUTHOR.id, timestamp: TIME }));
    expect(current.paragraphs[0]!.runs.map((run) => run.text)).toEqual(['a', 'xy', 'b']);
  });
});

describe('renderTrackedParagraphHtml', () => {
  it('marks inserts/deletes with author+time titles and escapes html', () => {
    let doc = tracked('<b>');
    const p = doc.paragraphs[0]!.id;
    doc = insertText(doc, p, 0, '<i>', { authorId: TRACK_AUTHOR.id, timestamp: TIME });
    doc = deleteText(doc, p, 1, 1, { authorId: TRACK_AUTHOR.id, timestamp: TIME });
    const html = renderTrackedParagraphHtml(doc.paragraphs[0]!, [], doc.authors);
    expect(html).toContain('class="loam-track-ins"');
    expect(html).toContain(`title="مستخدم لوم · ${TIME}"`);
    // every angle bracket is escaped — the deleted 'i' splits the insert run
    expect(html).toContain('&lt;');
    expect(html).toContain('&gt;');
    expect(html).toContain('class="loam-track-del"');
    expect(html).not.toContain('<i>');
    expect(html).not.toContain('<b>');
  });

  it('wraps comment anchors in a mark, resolved threads styled apart', () => {
    let doc = tracked('Hello world');
    const p = doc.paragraphs[0]!.id;
    doc = addCommentThread(doc, p, 0, 5, { authorId: TRACK_AUTHOR.id, text: 'why', timestamp: TIME });
    const open = renderTrackedParagraphHtml(doc.paragraphs[0]!, doc.threads, doc.authors);
    expect(open).toContain('<mark class="loam-track-comment" data-threads="');
    expect(open).toContain('</mark>');
    const resolved = setThreadResolved(doc, doc.threads[0]!.id, true);
    const closed = renderTrackedParagraphHtml(resolved.paragraphs[0]!, resolved.threads, resolved.authors);
    expect(closed).toContain('loam-track-comment loam-track-resolved');
  });
});

describe('renderTrackedDocument', () => {
  it('re-renders each data-tp block from the model', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>one</p><p>two</p>';
    const blocks = trackedBlockList(root);
    let doc = buildTrackedModel(['one', 'two']);
    attachParagraphIds(blocks, doc);
    doc = insertText(doc, doc.paragraphs[1]!.id, 3, '!', { authorId: TRACK_AUTHOR.id, timestamp: TIME });
    renderTrackedDocument(root, doc);
    expect(root.querySelectorAll('p')[0]!.textContent).toBe('one');
    expect(root.querySelectorAll('p')[1]!.querySelector('.loam-track-ins')!.textContent).toBe('!');
  });
});
