/**
 * Pentest Task Tree tests (RED_TEAM_BUILD_SPEC §6.1, PentestGPT graft).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createPtt, flatten, updateNode } from "../orchestrator/ptt.js";

describe("PTT", () => {
  it("creates a root with task children", () => {
    const root = createPtt("assess the lab web app", [{ goal: "http://127.0.0.1:3000" }, { goal: "http://127.0.0.1:3001" }]);
    assert.equal(root.goal, "assess the lab web app");
    assert.equal(root.status, "doing");
    assert.equal(root.children.length, 2);
    assert.deepEqual(root.children.map((c) => c.status), ["todo", "todo"]);
  });

  it("updateNode is pure and patches only the matched node", () => {
    const root = createPtt("g", [{ goal: "a" }, { goal: "b" }]);
    const next = updateNode(root, root.children[1]!.id, { status: "proven", evidenceIds: ["EV0001"] });
    assert.equal(root.children[1]!.status, "todo", "original tree is untouched");
    assert.equal(next.children[1]!.status, "proven");
    assert.equal(next.children[1]!.evidenceIds.length, 1);
    assert.equal(next.children[0]!.status, "todo");
  });

  it("flatten walks the whole tree depth-first", () => {
    const root = createPtt("g", [{ goal: "a" }, { goal: "b" }]);
    const child = root.children[0]!;
    const next = updateNode(root, child.id, { status: "doing", note: "x" });
    const all = flatten(next);
    assert.equal(all.length, 3);
    assert.ok(all.some((n) => n.note === "x"));
  });

  it("unknown ids leave the tree unchanged", () => {
    const root = createPtt("g", [{ goal: "a" }]);
    const next = updateNode(root, "nope", { status: "blocked" });
    assert.equal(next.children[0]!.status, "todo");
  });
});
