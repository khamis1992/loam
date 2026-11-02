import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePlanSteps } from "../specAliases.js";

describe("plan status aliases", () => {
  it("normalises in_progress, completed, and todo", () => {
    const parsed = parsePlanSteps([
      { title: "Open", status: "todo" },
      { title: "Build", status: "in_progress" },
      { title: "Export", status: "completed" },
    ], 0);
    assert.equal(parsed.error, undefined);
    assert.deepEqual(parsed.steps.map((step) => step.status), ["pending", "doing", "done"]);
  });

  it("still rejects an unknown status", () => {
    const parsed = parsePlanSteps([{ title: "Open", status: "started" }], 0);
    assert.match(parsed.error ?? "", /invalid status/);
  });
});
