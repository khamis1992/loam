/**
 * Neo N18: the canvas annotation store.
 *
 * The acceptance rule is that a colour tag, a comment and a free note survive a
 * server restart and stay inside their own run: a hand-crafted node id must never
 * annotate another task's graph. The store is real (SQLite) behind a throwaway
 * data directory, so these tests exercise the same code path the routes use.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { closeDb } from "../sqliteStore.js";
import {
  CANVAS_TAG_COLOURS,
  CanvasAnnotationError,
  CanvasAnnotationStore,
  MAX_COLOUR_TAGS_PER_RUN,
  MAX_FREE_NOTES_PER_RUN,
  coerceColourTags,
  coerceComments,
  coerceFreeNotes,
  emptyAnnotations,
  isCanvasTagColour,
  resetCanvasAnnotations,
} from "../canvasNotes.js";

const RUN = "task_canvas_notes_1";
const OTHER = "task_canvas_notes_2";
const NODE = "node-1";

let tmpDir = "";
let prevDataDir: string | undefined;

function freshDataDir(prefix: string): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  prevDataDir = process.env.MANUS_LOCAL_DATA_DIR;
  process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
  closeDb();
  resetCanvasAnnotations();
}

function restoreDataDir(): void {
  closeDb();
  resetCanvasAnnotations();
  if (prevDataDir === undefined) delete process.env.MANUS_LOCAL_DATA_DIR;
  else process.env.MANUS_LOCAL_DATA_DIR = prevDataDir;
  try {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  tmpDir = "";
}

describe("canvas annotation palette", () => {
  it("exposes a closed palette the canvas and the server agree on", () => {
    assert.deepEqual([...CANVAS_TAG_COLOURS], ["none", "blue", "green", "amber", "red", "violet"]);
    assert.equal(isCanvasTagColour("blue"), true);
    assert.equal(isCanvasTagColour("pink"), false, "an unknown colour is not part of the palette");
  });
});

describe("canvas annotation coercion", () => {
  it("drops an unknown colour instead of keeping it as junk", () => {
    const parsed = coerceColourTags({ tags: { a: "blue", b: "pink", c: 7, d: "red" } });
    assert.deepEqual(parsed.tags, { a: "blue", d: "red" });
    assert.deepEqual(coerceColourTags(null).tags, {});
    assert.deepEqual(coerceColourTags({ tags: "nope" }).tags, {});
  });

  it("keeps only usable comment entries and fills safe defaults", () => {
    const parsed = coerceComments({
      comments: {
        n1: [
          { id: "c1", author: "user", text: "Looks good", created: 5 },
          { text: "no id", author: "user", created: 6 },
          { author: "user" },
          "junk",
        ],
        n2: "nope",
      },
    });
    assert.equal(parsed.comments.n1!.length, 2, "an entry without text is dropped");
    assert.equal(parsed.comments.n1![1]!.id, "c-1", "a missing id is filled in");
    assert.equal(parsed.comments.n1![1]!.author, "user", "a missing author defaults to the user");
    assert.equal(parsed.comments.n2, undefined, "a non-array thread is dropped");
  });

  it("coerces free notes and defaults an unknown colour", () => {
    const parsed = coerceFreeNotes({
      notes: [
        { id: "note-1", text: "Remember the deadline", x: 12, y: 40, colour: "amber", created: 1, updated: 2 },
        { id: "note-2", text: "no position", colour: "pink" },
        { text: "" },
      ],
    });
    assert.equal(parsed.notes.length, 2, "an empty note is dropped");
    assert.deepEqual(
      { x: parsed.notes[0]!.x, y: parsed.notes[0]!.y, colour: parsed.notes[0]!.colour },
      { x: 12, y: 40, colour: "amber" },
    );
    assert.equal(parsed.notes[1]!.colour, "none", "an unknown colour falls back to none");
    assert.equal(parsed.notes[1]!.x, 0);
  });

  it("starts a run with an empty annotation layer", () => {
    assert.deepEqual(emptyAnnotations(RUN), { runId: RUN, tags: {}, comments: {}, notes: [] });
  });
});

describe("canvas annotation store", () => {
  beforeEach(() => freshDataDir("loam-canvas-notes-"));
  afterEach(() => restoreDataDir());

  it("sets, clears and reads back a node's colour tag", () => {
    const store = new CanvasAnnotationStore();
    const nodeExists = (id: string): boolean => id === NODE;
    assert.equal(store.setColour(RUN, NODE, "blue", nodeExists), "blue");
    assert.deepEqual(store.getAnnotations(RUN).tags, { [NODE]: "blue" });
    // "none" clears the tag without leaving a stale entry behind.
    store.setColour(RUN, NODE, "none", nodeExists);
    assert.deepEqual(store.getAnnotations(RUN).tags, {});
  });

  it("refuses to tag a node that is not on this run", () => {
    const store = new CanvasAnnotationStore();
    const nodeExists = (): boolean => false;
    assert.throws(() => store.setColour(RUN, "foreign", "red", nodeExists), CanvasAnnotationError);
    assert.deepEqual(store.getAnnotations(RUN).tags, {});
  });

  it("appends comments to a thread, oldest first, and removes one by id", () => {
    const store = new CanvasAnnotationStore();
    const nodeExists = (id: string): boolean => id === NODE;
    const first = store.addComment(RUN, NODE, "user", "First thought", nodeExists);
    const second = store.addComment(RUN, NODE, "", "Second thought", nodeExists);
    assert.equal(second.author, "user", "a missing author defaults to the user");
    const thread = store.getAnnotations(RUN).comments[NODE]!;
    assert.deepEqual(
      thread.map((comment) => comment.text),
      ["First thought", "Second thought"],
    );
    assert.equal(store.removeComment(RUN, NODE, first.id), true);
    assert.deepEqual(
      store.getAnnotations(RUN).comments[NODE]!.map((comment) => comment.text),
      ["Second thought"],
    );
    // Removing the last comment drops the thread entirely.
    assert.equal(store.removeComment(RUN, NODE, second.id), true);
    assert.deepEqual(store.getAnnotations(RUN).comments, {});
    assert.equal(store.removeComment(RUN, NODE, "gone"), false, "an unknown comment is a no-op");
  });

  it("rejects an empty comment and a comment on a foreign node", () => {
    const store = new CanvasAnnotationStore();
    assert.throws(() => store.addComment(RUN, NODE, "user", "   ", (id) => id === NODE), /comment text is required/);
    assert.throws(() => store.addComment(RUN, "foreign", "user", "hi", () => false), /node not found in this run/);
  });

  it("creates, moves, edits and deletes free notes", () => {
    const store = new CanvasAnnotationStore();
    const note = store.addNote(RUN, "Check the budget", 100, 200, "amber");
    assert.equal(note.colour, "amber");
    assert.equal(store.getAnnotations(RUN).notes.length, 1);

    const moved = store.moveNote(RUN, note.id, 320, 80)!;
    assert.deepEqual({ x: moved.x, y: moved.y }, { x: 320, y: 80 });

    const edited = store.updateNote(RUN, note.id, { text: "Check the Q3 budget", colour: "red" })!;
    assert.equal(edited.text, "Check the Q3 budget");
    assert.equal(edited.colour, "red");
    // An edit never rewrites the position the user placed the note at.
    assert.deepEqual({ x: edited.x, y: edited.y }, { x: 320, y: 80 });

    assert.equal(store.removeNote(RUN, note.id), true);
    assert.deepEqual(store.getAnnotations(RUN).notes, []);
    assert.equal(store.removeNote(RUN, "gone"), false);
    assert.equal(store.moveNote(RUN, "gone", 1, 1), undefined, "moving a missing note is a no-op");
  });

  it("keeps annotations of two runs apart", () => {
    const store = new CanvasAnnotationStore();
    const nodeExists = (id: string): boolean => id === NODE;
    store.setColour(RUN, NODE, "blue", nodeExists);
    store.setColour(OTHER, NODE, "red", nodeExists);
    store.addComment(RUN, NODE, "user", "run one", nodeExists);
    store.addNote(RUN, "run one note", 1, 1);
    assert.deepEqual(store.getAnnotations(RUN).tags, { [NODE]: "blue" });
    assert.deepEqual(store.getAnnotations(OTHER).tags, { [NODE]: "red" });
    assert.deepEqual(Object.keys(store.getAnnotations(OTHER).comments), [], "the comment stays in its run");
    assert.deepEqual(store.getAnnotations(OTHER).notes, []);
  });

  it("survives a restart by reading the annotations back from the store", () => {
    const first = new CanvasAnnotationStore();
    const nodeExists = (id: string): boolean => id === NODE;
    first.setColour(RUN, NODE, "violet", nodeExists);
    first.addComment(RUN, NODE, "user", "survives", nodeExists);
    first.addNote(RUN, "also survives", 7, 9, "green");

    // A new instance (server restart) must recover the whole layer.
    const second = new CanvasAnnotationStore();
    const recovered = second.getAnnotations(RUN);
    assert.deepEqual(recovered.tags, { [NODE]: "violet" });
    assert.equal(recovered.comments[NODE]![0]!.text, "survives");
    assert.equal(recovered.notes[0]!.text, "also survives");
    assert.equal(recovered.notes[0]!.colour, "green");
  });

  it("drops a whole run's annotations with clearRun", () => {
    const store = new CanvasAnnotationStore();
    const nodeExists = (id: string): boolean => id === NODE;
    store.setColour(RUN, NODE, "blue", nodeExists);
    store.addComment(RUN, NODE, "user", "bye", nodeExists);
    store.addNote(RUN, "bye", 0, 0);
    store.clearRun(RUN);
    assert.deepEqual(store.getAnnotations(RUN), emptyAnnotations(RUN));
  });

  it("enforces the per-run ceilings", () => {
    const store = new CanvasAnnotationStore();
    const nodeExists = (): boolean => true;
    for (let i = 0; i < MAX_COLOUR_TAGS_PER_RUN; i++) store.setColour(RUN, `n${i}`, "blue", nodeExists);
    assert.throws(() => store.setColour(RUN, "one-more", "blue", nodeExists), /colour tag limit reached/);
    for (let i = 0; i < MAX_FREE_NOTES_PER_RUN; i++) store.addNote(RUN, `note ${i}`, i, i);
    assert.throws(() => store.addNote(RUN, "one more", 0, 0), /free note limit reached/);
  });
});
