/**
 * Neo N11 acceptance tests: turning a canvas edit into prompt context.
 *
 * Two functions are on the critical path of every canvas operation, and both are
 * easy to get subtly wrong, so the tests pin their shape rather than their prose:
 *
 *   1. `nodeText` must read the same field the model will quote, and must never
 *      leak an id or a counter into a prompt.
 *   2. `canvasEditsMessage` must carry a *batch* as one block. The selector folds
 *      stacked reminders down to the newest, so N separate blocks would collapse
 *      to one and silently drop the other edits.
 */
import assert from "node:assert";
import { describe, it } from "node:test";

import { canvasEditsMessage, directiveBody, directiveTitle, directiveText } from "../../agent/canvasContext.js";
import type { CanvasDirective, NewDirective } from "../directives.js";
import { editableFields, excerpt, hasNodeText, nodeLocation, nodeText, withEditedText } from "../nodeText.js";
import type { RunNode } from "../store.js";

function node(over: Partial<RunNode> & { id: string; type: RunNode["type"] }): RunNode {
  const now = Date.now();
  return {
    id: over.id,
    run_id: over.run_id ?? "task_text_1",
    parent_ids: [],
    type: over.type,
    status: "finished",
    data: over.data,
    version: 1,
    created: now,
    updated: now,
  };
}

describe("N11 nodeText", () => {
  it("prefers the field a node's own type carries", () => {
    assert.equal(nodeText(node({ id: "n1", type: "webpage", data: { url: "https://example.com", title: "The report", summary: "Market size" } })), "The report — Market size");
    assert.equal(nodeText(node({ id: "n2", type: "search", data: { query: "market size", summary: "3 hits" } })), "3 hits — market size");
    assert.equal(nodeText(node({ id: "n3", type: "complete", data: { text: "The market is $4B.", steps: 1, model: "m" } })), "The market is $4B.");
  });

  it("never puts an id or a counter into a prompt", () => {
    const text = nodeText(node({ id: "n1", type: "document", data: { title: "Plan", stepId: "s1", seedId: "seed-9", sizeBytes: 4096, ok: true, sha256: "abc" } }));
    assert.doesNotMatch(text, /s1/, "a step id is not prose");
    assert.doesNotMatch(text, /seed-9/);
    assert.doesNotMatch(text, /4096/);
    assert.doesNotMatch(text, /abc/);
    assert.ok(hasNodeText(node({ id: "n1", type: "document", data: { title: "Plan", stepId: "s1" } })));
  });

  it("falls back to the node type rather than inventing text", () => {
    // A payload with no prose field falls back to the node's own type name.
    assert.equal(nodeText(node({ id: "n1", type: "note", data: { trivial: false } })), "note");
    assert.equal(hasNodeText(node({ id: "n1", type: "note", data: { trivial: false } })), false);
  });

  it("reports where an artefact lives, for a prompt that must point at it", () => {
    assert.equal(nodeLocation(node({ id: "n1", type: "media", data: { path: "C:\\tmp\\shot.png", mime: "image/png" } })), "C:\\tmp\\shot.png");
    assert.equal(nodeLocation(node({ id: "n2", type: "media", data: { mime: "image/png" } })), "image/png");
    assert.equal(nodeLocation(node({ id: "n3", type: "media", data: {} })), undefined);
  });

  it("edits rewrite one prose field and keep everything else", () => {
    const data = { title: "Old title", url: "https://example.com", ok: true, sizeBytes: 10, summary: "s" };
    const edited = withEditedText(data, "New title");
    assert.equal(edited.title, "New title");
    assert.equal(edited.summary, "s", "the fields the edit did not name survive");
    assert.equal(edited.url, "https://example.com");
    assert.equal(edited.ok, true);
    assert.deepEqual(editableFields(data), { title: "Old title", summary: "s" }, "only prose fields are editable");
  });

  it("abbreviates without splitting a word mid-byte", () => {
    assert.equal(excerpt("one two three", 7), "one tw…");
    assert.equal(excerpt("short", 40), "short");
    assert.equal(excerpt("a\n\n   b", 40), "a b");
  });
});

/** The log owns the id, sequence and timestamp, so a fixture only states the rest. */
function directive(over: Partial<NewDirective> = {}): CanvasDirective {
  return {
    id: "dir_1",
    seq: 1,
    created: 0,
    run_id: "task_text_1",
    nodeId: "node_a",
    title: "The report",
    text: "The market is $4.2B.",
    mode: "follow-up",
    reason: "edited",
    ...over,
  };
}

describe("N11 canvas edit prompt block", () => {
  it("names the node id, states the instruction, and carries the content", () => {
    const block = directiveText(directive());
    assert.match(block, /node_a/, "the model must be able to locate the node");
    assert.match(block, /authoritative output/, "an edit supersedes what the model produced");
    assert.match(block, /Title: The report/);
    assert.match(block, /Content:\nThe market is \$4\.2B\./);
  });

  it("tells a quote apart from a follow-up", () => {
    const quote = directiveText(directive({ mode: "quote", reason: "mode" }));
    assert.match(quote, /exactly/);
    assert.match(quote, /Do not paraphrase/);
    assert.match(directiveText(directive({ mode: "follow-up", reason: "mode" })), /Continue the work/);
  });

  it("carries the detail a cut or a group records", () => {
    const cut = directiveText(directive({ reason: "cut", detail: "Cut from: The report" }));
    assert.match(cut, /Cut from: The report/, "the dropped parent is named");
  });

  it("batches every edit into one reminder block", () => {
    const message = canvasEditsMessage([directive(), directive({ nodeId: "node_b" })]);
    assert.ok(message, "a batch produces a message");
    assert.equal(message!.role, "user");
    assert.match(message!.content, /2 canvas edits/, "the batch is counted");
    assert.match(message!.content, /1\. .*node_a/, "each edit is numbered");
    assert.match(message!.content, /2\. .*node_b/, "and every edit is present");
    assert.equal(canvasEditsMessage([]), undefined, "an empty batch produces nothing");
  });

  it("keeps the shelf entry and the prompt block identical", () => {
    const item = directive();
    assert.equal(directiveTitle(item), "Canvas edit: The report");
    assert.equal(directiveBody(item), directiveText(item));
  });
});
