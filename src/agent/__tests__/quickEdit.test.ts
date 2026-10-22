/**
 * Tests for the quick-edit route (quickEdit.ts).
 *
 * Acceptance under test:
 *  - text and reorder edits route to the fast model
 *  - big edits (structural, behavioural, file-boundary or oversized) route to
 *    the base model
 *  - a before/after pair becomes a minimal, targeted diff
 *  - Arabic/RTL text is recognised and preserved
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  QUICK_EDIT_LIMITS,
  classifyEditRequest,
  classifyQuickEdit,
  hasRtlScript,
  isReorderOnly,
  planQuickEditRoute,
  planTargetedDiff,
  resolveQuickEditModel,
  type QuickEditScope,
  type TargetedPatch,
} from "../quickEdit.js";

const CFG = { model: "frontier-x", fallbackModel: "fast-y" };

function scope(over: Partial<QuickEditScope> = {}): QuickEditScope {
  return {
    files: ["src/button.tsx"],
    changedLines: 1,
    textOnly: false,
    reorderOnly: false,
    structural: false,
    behavioural: false,
    fileBoundary: false,
    ...over,
  };
}

function applyPatches(text: string, patches: TargetedPatch[]): string {
  let out = text.replace(/\r\n|\r/g, "\n");
  for (const patch of patches) {
    if (patch.find === "") {
      out = `${patch.replace}${out}`;
      continue;
    }
    const at = out.indexOf(patch.find);
    assert.ok(at >= 0, `patch find text not present: ${JSON.stringify(patch.find)}`);
    out = out.slice(0, at) + patch.replace + out.slice(at + patch.find.length);
  }
  return out;
}

describe("quick-edit classifier", () => {
  it("routes a text-only edit to the fast model", () => {
    const decision = classifyQuickEdit(scope({ textOnly: true }));
    assert.equal(decision.route, "quick");
    assert.equal(resolveQuickEditModel(CFG, decision), "fast-y");
  });

  it("routes a pure reorder to the fast model", () => {
    const decision = classifyQuickEdit(scope({ reorderOnly: true, textOnly: false }));
    assert.equal(decision.route, "quick");
    assert.equal(resolveQuickEditModel(CFG, decision), "fast-y");
  });

  it("routes a big structural edit to the base model", () => {
    const decision = classifyQuickEdit(scope({ structural: true, changedLines: 12 }));
    assert.equal(decision.route, "base");
    assert.equal(resolveQuickEditModel(CFG, decision), "frontier-x");
  });

  it("routes a behavioural change to the base model", () => {
    const decision = classifyQuickEdit(scope({ behavioural: true }));
    assert.equal(decision.route, "base");
    assert.equal(resolveQuickEditModel(CFG, decision), "frontier-x");
  });

  it("routes a file creation/deletion to the base model", () => {
    const decision = classifyQuickEdit(scope({ fileBoundary: true }));
    assert.equal(decision.route, "base");
  });

  it("routes an oversized edit to the base model", () => {
    const decision = classifyQuickEdit(scope({ textOnly: true, changedLines: QUICK_EDIT_LIMITS.maxChangedLines + 1 }));
    assert.equal(decision.route, "base");
  });

  it("routes a multi-file edit to the base model", () => {
    const decision = classifyQuickEdit(scope({ textOnly: true, files: ["a.ts", "b.ts", "c.ts", "d.ts"] }));
    assert.equal(decision.route, "base");
  });

  it("keeps an ambiguous scope on the base model", () => {
    assert.equal(classifyQuickEdit(scope()).route, "base");
  });
});

describe("quick-edit instruction classifier", () => {
  it("routes a narrow English instruction to quick", () => {
    const decision = classifyEditRequest("Rename the submit button label to «Send»");
    assert.equal(decision.route, "quick");
  });

  it("routes a narrow Arabic instruction to quick", () => {
    const decision = classifyEditRequest("استبدل النص «قديم» ب«جديد»");
    assert.equal(decision.route, "quick");
  });

  it("routes a reorder instruction to quick", () => {
    assert.equal(classifyEditRequest("Move the footer above the sidebar").route, "quick");
  });

  it("routes an additive instruction to base", () => {
    assert.equal(classifyEditRequest("Add a new dashboard page with charts").route, "base");
  });

  it("routes a long instruction to base", () => {
    const long = "rename this ".repeat(40);
    assert.ok(long.length > QUICK_EDIT_LIMITS.maxInstructionChars);
    assert.equal(classifyEditRequest(long).route, "base");
  });

  it("keeps a neutral instruction on the base model", () => {
    assert.equal(classifyEditRequest("Save fixture").route, "base");
  });

  it("prefers a measured scope over the instruction text", () => {
    const decision = classifyEditRequest("Add a new page", scope({ textOnly: true }));
    assert.equal(decision.route, "quick");
  });
});

describe("quick-edit route plan", () => {
  it("returns the fast model and a suffix for a narrow edit", () => {
    const route = planQuickEditRoute(CFG, "Fix the typo in the heading");
    assert.equal(route.model, "fast-y");
    assert.equal(route.decision.route, "quick");
    assert.match(route.suffix, /targeted edit/i);
    assert.match(route.suffix, /مسار التحرير السريع/);
  });

  it("returns the base model and no suffix for a large edit", () => {
    const route = planQuickEditRoute(CFG, "Refactor the authentication flow");
    assert.equal(route.model, "frontier-x");
    assert.equal(route.suffix, "");
  });

  it("falls back to the base model when no fast model is configured", () => {
    const route = planQuickEditRoute({ model: "frontier-x", fallbackModel: "" }, "Rename the label");
    assert.equal(route.model, "frontier-x");
  });
});

describe("targeted diff", () => {
  it("produces a single replacement patch for a text edit", () => {
    const diff = planTargetedDiff("alpha\nbeta\ngamma\n", "alpha\nBETA\ngamma\n");
    assert.equal(diff.added, 1);
    assert.equal(diff.removed, 1);
    assert.equal(diff.patches.length, 1);
    assert.equal(diff.patches[0]!.find, "beta\n");
    assert.equal(diff.patches[0]!.replace, "BETA\n");
    assert.equal(applyPatches("alpha\nbeta\ngamma\n", diff.patches), "alpha\nBETA\ngamma\n");
  });

  it("anchors an insertion on an existing line", () => {
    const diff = planTargetedDiff("alpha\ngamma\n", "alpha\nbeta\ngamma\n");
    assert.equal(diff.added, 1);
    assert.equal(diff.removed, 0);
    assert.equal(applyPatches("alpha\ngamma\n", diff.patches), "alpha\nbeta\ngamma\n");
  });

  it("produces a deletion patch", () => {
    const diff = planTargetedDiff("alpha\nbeta\ngamma\n", "alpha\ngamma\n");
    assert.equal(diff.removed, 1);
    assert.equal(diff.patches[0]!.replace, "");
    assert.equal(applyPatches("alpha\nbeta\ngamma\n", diff.patches), "alpha\ngamma\n");
  });

  it("inserts before the first line", () => {
    const diff = planTargetedDiff("beta\n", "alpha\nbeta\n");
    assert.equal(applyPatches("beta\n", diff.patches), "alpha\nbeta\n");
  });

  it("preserves Arabic text in a targeted patch", () => {
    const before = "title = \"قديم\"\n";
    const after = "title = \"جديد\"\n";
    const diff = planTargetedDiff(before, after);
    assert.ok(hasRtlScript(before));
    assert.equal(applyPatches(before, diff.patches), after);
    assert.equal(diff.patches[0]!.find.includes("قديم"), true);
  });
});

describe("reorder detection", () => {
  it("detects a pure reorder", () => {
    assert.equal(isReorderOnly("a\nb\nc\n", "c\na\nb\n"), true);
    assert.equal(planTargetedDiff("a\nb\nc\n", "c\na\nb\n").reorderOnly, true);
  });

  it("does not call a content change a reorder", () => {
    assert.equal(isReorderOnly("a\nb\nc\n", "a\nb\nd\n"), false);
    assert.equal(isReorderOnly("a\nb\n", "a\nb\n"), false);
  });
});

describe("rtl detection", () => {
  it("detects Arabic script", () => {
    assert.equal(hasRtlScript("مرحبا"), true);
    assert.equal(hasRtlScript("hello"), false);
    assert.equal(hasRtlScript("mixed نص text"), true);
  });
});
