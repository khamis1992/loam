import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { SPILL_CHARS, spillToolOutput } from "../spill.js";

describe("spillToolOutput", () => {
  it("leaves a short tool result in the prompt", () => {
    assert.equal(spillToolOutput(os.tmpdir(), "file_read", "hello", "task"), "hello");
  });

  it("writes a long tool result to a file and keeps an excerpt plus the path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-spill-"));
    const content = `marker-start ${"x".repeat(SPILL_CHARS)} marker-end`;
    const spilled = spillToolOutput(dir, "browser_read", content, "task_1");
    assert.match(spilled, /marker-start/);
    assert.doesNotMatch(spilled, /marker-end/);
    const match = spilled.match(/saved at (.+)\. Read that file/);
    assert.ok(match?.[1]);
    const saved = fs.readFileSync(match![1]!, "utf8");
    assert.ok(saved.endsWith("marker-end"));
    assert.ok(saved.includes("marker-start"));
  });
});
