import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RE_ALLOWLIST, filterReToolsList, isAllowedReTool } from "../allowlist.js";
import { classifyReToolCall } from "../effects.js";
import { startBudget, checkBudget, recordToolCall, clipJson } from "../budget.js";
import { buildBundle, verifyBundle } from "../bundles.js";
import { applyReAllowlist, wrapReResult } from "../../tools/reAllowlist.js";

describe("Cap B REA", () => {
  it("allowlist has 15 tools", () => {
    assert.equal(RE_ALLOWLIST.length, 15);
    assert.equal(isAllowedReTool("doctor"), true);
    assert.equal(isAllowedReTool("open_binary"), false);
  });
  it("filters tools/list", () => {
    const out = filterReToolsList([{ name: "doctor" }, { name: "hack" }]);
    assert.deepEqual(out.map((t) => t.name), ["doctor"]);
  });
  it("classifies effects", () => {
    assert.equal(classifyReToolCall("doctor"), "read");
    assert.equal(classifyReToolCall("extract_asar_entry"), "write-workspace-data");
    assert.equal(classifyReToolCall("nope"), "denied");
  });
  it("budget refuses over bytes", () => {
    const s = startBudget({ maxToolCalls: 2, maxBytesOut: 50, maxWallMs: 60_000 });
    const w = wrapReResult(s, { a: "x".repeat(100) });
    assert.ok(w.refused);
  });
  it("bundle digest verifies", () => {
    const files = [{ path: "a.txt", data: Buffer.from("hi") }];
    const b = buildBundle("EV0001", files);
    assert.equal(verifyBundle(b, files).ok, true);
    assert.equal(verifyBundle(b, [{ path: "a.txt", data: Buffer.from("no") }]).ok, false);
  });
  it("applyReAllowlist", () => {
    assert.equal(applyReAllowlist([{ name: "list_llms" }, { name: "x" }]).length, 1);
  });
  it("clipJson marks truncated", () => {
    const c = clipJson({ a: 1 }, 5);
    assert.equal(c.truncated, true);
  });
  it("recordToolCall increments", () => {
    const s = recordToolCall(startBudget(), 10);
    assert.equal(s.toolCalls, 1);
    assert.equal(checkBudget(s).ok, true);
  });
});
