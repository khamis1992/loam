import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clearRepeatBlocks, noteToolOutcome, repeatBlockReason } from "../repeatGuard.js";

describe("repeat call guard", () => {
  it("blocks the same arguments after retry:false and allows a different call", () => {
    clearRepeatBlocks("task-repeat");
    noteToolOutcome("task-repeat", "office_craft", { app: "slides", action: "open" }, false, JSON.stringify({ retry: false }));
    assert.match(repeatBlockReason("task-repeat", "office_craft", { action: "open", app: "slides" }) ?? "", /retry:false/);
    assert.equal(repeatBlockReason("task-repeat", "office_craft", { app: "slides", action: "export" }), null);
    noteToolOutcome("task-repeat", "loam_studio", { action: "replace" }, true, "ok");
    assert.equal(repeatBlockReason("task-repeat", "office_craft", { app: "slides", action: "open" }), null);
  });
});
