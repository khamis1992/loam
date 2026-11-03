import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CuaAuditLog, cuaAuditPath, cuaAuditScopes } from "../cuaAudit.js";

test("append-only JSONL: seq continues, torn lines healed and skipped, scalars only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cua-audit-"));
  try {
    const file = cuaAuditPath(dir);
    const log1 = new CuaAuditLog(file);
    log1.append({ name: "cua.driver.connect", outcome: "completed", detail: "14/63 tools registered" });
    log1.append({ name: "cua.driver.call", outcome: "completed", tool: "click", session: "sess-1", pid: 4242, windowId: 197014, durationMs: 62 });
    fs.appendFileSync(file, '{"seq":3,"at":"2026', "utf8"); // torn mid-write
    const log2 = new CuaAuditLog(file);
    log2.append({ name: "cua.driver.allowlist.reject", outcome: "denied", tool: "clipboard_read" });

    const entries = log2.read();
    assert.equal(entries.length, 3);
    assert.deepEqual(entries.map((e) => e.seq), [1, 2, 4]);
    assert.equal(entries[1]!.tool, "click");
    assert.equal(entries[1]!.windowId, 197014);
    assert.equal(entries[2]!.name, "cua.driver.allowlist.reject");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cuaAuditScopes keeps ids, drops every text-bearing field", () => {
  const scopes = cuaAuditScopes({
    text: "super secret typed payload",
    target: { kind: "window", pid: 777, window_id: 111 },
    session: "sess-9",
    expect: { anything: "nested" },
  });
  assert.deepEqual(scopes, { session: "sess-9", pid: 777, windowId: 111 });
  const flat = cuaAuditScopes({ pid: 31, window_id: 55, session: "s" });
  assert.deepEqual(flat, { session: "s", pid: 31, windowId: 55 });
  assert.deepEqual(cuaAuditScopes({}), {});
  // What lands in the audit file can never contain the typed text.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cua-audit-2-"));
  try {
    const log = new CuaAuditLog(cuaAuditPath(dir));
    const args = { text: "SECRET", target: { kind: "window", pid: 1, window_id: 2 } };
    const s = cuaAuditScopes(args);
    log.append({ name: "cua.driver.call", outcome: "completed", tool: "type_text", ...s });
    const raw = fs.readFileSync(cuaAuditPath(dir), "utf8");
    assert.ok(!raw.includes("SECRET"));
    assert.ok(raw.includes("\"pid\":1"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
