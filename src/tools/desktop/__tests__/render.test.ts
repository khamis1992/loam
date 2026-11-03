/**
 * P3 acceptance: the B2 renderer, error renderer and ref-stripped delta on
 * fixture trees — the exact output shapes the model consumes (§3.5).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AdErr, AdNode, AdSnapshot } from "../adTypes.js";
import { renderDelta, renderError, renderSnapshot, renderTree } from "../render.js";

const tree: AdNode = {
  role: "window",
  name: "FakeApp",
  children: [
    { role: "button", name: "OK", ref_id: "@s1:e1" },
    { role: "textfield", name: "Query", ref_id: "@s1:e2", value: "" },
    { role: "text", name: undefined, ref_id: undefined, children_count: 0 },
    {
      role: "pane",
      name: "Advanced",
      ref_id: "@s1:e3",
      children_count: 42,
      children: [{ role: "checkbox", name: "Agree", ref_id: "@s1:e4", states: ["unchecked"] }],
    },
  ],
};

const snapshot: AdSnapshot = {
  app: "FakeApp.exe",
  window: { id: "w-1", title: "never logged" },
  snapshot_id: "s1",
  ref_count: 4,
  complete: true,
  tree,
};

describe("renderTree / renderSnapshot", () => {
  it("renders keep-ref nodes with name, value, ref and states", () => {
    const lines = renderTree(tree);
    assert.deepEqual(lines, [
      'window "FakeApp"',
      '  button "OK" @s1:e1',
      '  textfield "Query" @s1:e2',
      '  pane "Advanced" @s1:e3 (+42 hidden; drill with root=@s1:e3)',
      '    checkbox "Agree" @s1:e4 [unchecked]',
    ]);
  });

  it("prefixes the snapshot header with id/completeness/truncation", () => {
    const text = renderSnapshot(snapshot);
    assert.match(text, /^snapshot s1 complete=true\n/);
    assert.match(text, /drill with root=@s1:e3/);
  });

  it("marks over-budget snapshots truncated", () => {
    const text = renderSnapshot({ ...snapshot, complete: false, truncated: true });
    assert.match(text, /complete=false truncated=true/);
  });

  it("cuts at maxLines with the drill hint", () => {
    const big: AdNode = { role: "window", name: "Big", children: [] };
    for (let i = 0; i < 50; i++) big.children!.push({ role: "button", name: `b${i}`, ref_id: `@s1:e${i + 1}` });
    const text = renderSnapshot({ ...snapshot, tree: big }, 10);
    assert.match(text, /\[truncated at 10 lines; use root=@ref to drill\]$/);
  });
});

describe("renderError", () => {
  it("carries code, delivery, retry, suggestion and the retry rule", () => {
    const e = {
      code: "STALE_REF",
      message: "ref is from an older snapshot",
      disposition: { delivery: "not_delivered", retry: "safe" },
      suggestion: "take a new snapshot",
    } as AdErr["error"];
    const text = renderError(e);
    assert.match(text, /ERROR STALE_REF delivery=not_delivered retry=safe/);
    assert.match(text, /take a new snapshot/);
    assert.match(text, /retry only if retry=safe/);
  });
});

describe("renderDelta", () => {
  it("returns unchanged when only the refs differ", () => {
    const prev = ['button "OK" @s1:e1', 'checkbox "Agree" @s1:e2 [unchecked]'];
    const next = ['button "OK" @s9:e1', 'checkbox "Agree" @s9:e2 [unchecked]'];
    const out = renderDelta(prev, next);
    assert.equal(out, "unchanged");
  });

  it("returns a small diff that keeps the NEW refs", () => {
    const prev = ['button "OK" @s1:e1', 'checkbox "Agree" @s1:e2 [unchecked]'];
    const next = ['button "OK" @s2:e1', 'checkbox "Agree" @s2:e2 [checked]'];
    // NOTE: [unchecked]→[checked] differs after ref-stripping, so it is a real change.
    const out = renderDelta(prev, next);
    assert.match(out, /\+ checkbox "Agree" @s2:e2 \[checked\]/);
    assert.match(out, /- checkbox "Agree" @s1:e2 \[unchecked\]/);
  });

  it("overflows to the summary line past maxLines", () => {
    const prev: string[] = [];
    const next: string[] = [];
    for (let i = 0; i < 50; i++) {
      prev.push(`text "row${i}" @s1:e${i}`);
      next.push(`text "ROW${i}" @s2:e${i}`);
    }
    const out = renderDelta(prev, next, 40);
    assert.equal(out, "changed: 100 lines; call computer_snapshot to see it");
  });
});
