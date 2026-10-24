import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ReaAuditLog, reaAuditPath } from "../reaAudit.js";

test("append-only JSONL: seq continues across instances, timestamps assigned, torn lines skipped", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rea-audit-"));
  try {
    const file = reaAuditPath(dir);
    const log1 = new ReaAuditLog(file);
    log1.append({ name: "rea.mcp.connect", outcome: "completed", tool: "server" });
    log1.append({ name: "rea.mcp.call", outcome: "completed", tool: "analyze_javascript_application", durationMs: 719, bytes: 11354 });
    // A torn line (crash mid-write) must not corrupt reads.
    fs.appendFileSync(file, '{"seq":3,"at":"2026', "utf8");
    const log2 = new ReaAuditLog(file); // seq resumes from full lines only → next is 4
    log2.append({ name: "rea.bundle.import", outcome: "failed", contentDigest: "ev_" + "a".repeat(64) });

    const entries = log2.read();
    assert.equal(entries.length, 3); // torn line skipped
    assert.deepEqual(entries.map((e) => e.seq), [1, 2, 4]);
    assert.equal(entries[0]!.name, "rea.mcp.connect");
    assert.match(entries[0]!.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(entries[1]!.tool, "analyze_javascript_application");
    assert.equal(entries[2]!.contentDigest, "ev_" + "a".repeat(64));

    // Entries are scalar-shaped: no field can smuggle tool arguments or secrets.
    for (const e of entries) {
      for (const value of Object.values(e)) {
        assert.equal(typeof value === "object", false);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
