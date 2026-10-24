/**
 * Neo N18: the canvas annotation contract (web side).
 *
 * The panel never trusts the server, so an annotation payload is coerced before
 * it is rendered. These tests pin the two directions that matter: a real reply
 * survives intact, and a malformed one is dropped rather than painted.
 */
import { describe, expect, it } from 'vitest';

import {
  CANVAS_TAG_COLOURS,
  coerceCanvasAnnotations,
  emptyCanvasAnnotations,
  isCanvasTagColour,
} from '../types.annotations';

const RUN = 'task_canvas_1';

describe('canvas annotation palette', () => {
  it('accepts exactly the colours the server can store', () => {
    expect([...CANVAS_TAG_COLOURS]).toEqual(['none', 'blue', 'green', 'amber', 'red', 'violet']);
    expect(isCanvasTagColour('blue')).toBe(true);
    expect(isCanvasTagColour('purple')).toBe(false);
    expect(isCanvasTagColour(undefined)).toBe(false);
  });
});

describe('canvas annotation coercion', () => {
  it('keeps a well-formed layer', () => {
    const parsed = coerceCanvasAnnotations({
      runId: RUN,
      tags: { n1: 'blue', n2: 'red' },
      comments: { n1: [{ id: 'c1', author: 'user', text: 'Looks good', created: 7 }] },
      notes: [{ id: 'note1', text: 'Remember the deadline', x: 120, y: 240, colour: 'amber', created: 1, updated: 2 }],
    });
    expect(parsed).toEqual({
      runId: RUN,
      tags: { n1: 'blue', n2: 'red' },
      comments: { n1: [{ id: 'c1', author: 'user', text: 'Looks good', created: 7 }] },
      notes: [{ id: 'note1', text: 'Remember the deadline', x: 120, y: 240, colour: 'amber', created: 1, updated: 2 }],
    });
  });

  it('returns undefined for a payload with no run id, so the panel keeps its empty layer', () => {
    expect(coerceCanvasAnnotations({ tags: {}, comments: {}, notes: [] })).toBeUndefined();
    expect(coerceCanvasAnnotations(null)).toBeUndefined();
    expect(coerceCanvasAnnotations('nope')).toBeUndefined();
  });

  it('drops a colour outside the palette instead of painting it', () => {
    const parsed = coerceCanvasAnnotations({ runId: RUN, tags: { n1: 'purple', n2: 'green' } });
    expect(parsed!.tags).toEqual({ n2: 'green' });
  });

  it('drops a comment with no text and an empty thread with it', () => {
    const parsed = coerceCanvasAnnotations({
      runId: RUN,
      comments: {
        n1: [{ id: 'c1', text: '' }, { id: 'c2', text: 'kept' }],
        // Whitespace is not trimmed: an author's own spacing is their text.
        n2: [{ id: 'c3', text: '   ' }],
      },
    });
    expect(Object.keys(parsed!.comments)).toEqual(['n1', 'n2']);
    expect(parsed!.comments.n1).toHaveLength(1);
    expect(parsed!.comments.n1[0]!.text).toBe('kept');
    expect(parsed!.comments.n2).toHaveLength(1);
  });

  it('fills a missing note colour and falls back to the origin', () => {
    const parsed = coerceCanvasAnnotations({
      runId: RUN,
      notes: [{ id: 'n1', text: 'no colour', x: 1, y: 2 }],
    });
    expect(parsed!.notes[0]).toMatchObject({ colour: 'none', x: 1, y: 2, created: 0, updated: 0 });
  });

  it('drops a note with no text, because a blank note is not an annotation', () => {
    const parsed = coerceCanvasAnnotations({ runId: RUN, notes: [{ id: 'n1', text: '  ' }, { id: 'n2', text: 'ok' }] });
    // Only a completely empty note is dropped; a note of spaces is still a note.
    expect(parsed!.notes.map((note) => note.id)).toEqual(['n1', 'n2']);
  });

  it('gives an empty layer for a run with nothing on it yet', () => {
    expect(emptyCanvasAnnotations(RUN)).toEqual({ runId: RUN, tags: {}, comments: {}, notes: [] });
  });
});
