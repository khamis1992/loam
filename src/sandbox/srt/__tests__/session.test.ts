import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SrtAuditLog } from "../audit.js";
import { buildSrtConfig, writeSrtSettingsFile } from "../session.js";
import { DEFAULT_LOAM_SRT_POLICY, resolveSrtPolicy, srtAuditPath } from "../policy.js";

test("audit JSONL: seq continues, torn tails healed, events recorded with scalars only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "srt-audit-"));
  try {
    const file = srtAuditPath(dir);
    const a = new SrtAuditLog(file);
    a.append({ name: "srt_install_started", outcome: "started", skipProfileGrant: true });
    a.append({ name: "srt_exec", outcome: "completed", commandId: "x".repeat(22), toolName: "shell_run", exitCode: 0, sandboxed: true, durationMs: 42 });
    fs.appendFileSync(file, '{"seq":3', "utf8"); // torn
    const b = new SrtAuditLog(file);
    b.append({ name: "srt_blocked_tool", outcome: "denied", toolName: "shell_start" });
    const entries = b.read();
    assert.equal(entries.length, 3);
    assert.deepEqual(entries.map((e) => e.seq), [1, 2, 4]);
    assert.equal(entries[2]!.name, "srt_blocked_tool");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildSrtConfig maps the flat policy + workspace roots (default-deny posture intact)", () => {
  const policy = resolveSrtPolicy({ sandboxMode: "untrusted_only", sandboxAllowedDomains: ["example.com"] });
  const config = buildSrtConfig(policy, "D:/ws", "D:/pin/srt-win.exe") as unknown as Record<string, unknown>;
  const net = config["network"] as Record<string, unknown>;
  const fsx = config["filesystem"] as Record<string, unknown>;
  const win = config["windows"] as Record<string, unknown>;
  assert.deepEqual(net["allowedDomains"], ["example.com"]);
  assert.equal(net["strictAllowlist"], true);
  assert.equal(net["allowLocalBinding"], false);
  assert.ok((fsx["denyRead"] as string[]).includes("~/.ssh"));
  assert.ok((fsx["allowRead"] as string[]).includes("D:/ws"));
  assert.ok((fsx["allowWrite"] as string[]).includes("D:/ws"));
  assert.ok((fsx["denyWrite"] as string[]).includes(".env"));
  assert.deepEqual(win["proxyPortRange"], [60080, 60089]);
  assert.ok(String((win["srtWin"] as Record<string, unknown>)["path"]).endsWith("srt-win.exe"));
  // The deny list survives a merge with user domains (C2).
  assert.deepEqual((fsx["denyRead"] as string[]).length, DEFAULT_LOAM_SRT_POLICY.denyRead.length);
});

test("writeSrtSettingsFile writes a complete settings object for CLI wraps", () => {
  // Writes to the real (gitignored) DATA_DIR/srt/loam-srt-settings.json — the
  // legitimate runtime location; the file is rewritten on every session open.
  const file = writeSrtSettingsFile(resolveSrtPolicy({ sandboxMode: "all_shell" }), "D:/ws", "D:/pin/srt-win.exe");
  assert.ok(file.endsWith("loam-srt-settings.json"));
  assert.ok(!file.startsWith(os.homedir() + path.sep) || process.env.USERPROFILE === os.homedir(), "never ~/.srt-settings.json");
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  assert.ok(parsed["network"] && parsed["filesystem"] && parsed["windows"]);
  const net = parsed["network"] as Record<string, unknown>;
  assert.equal(net["strictAllowlist"], true);
});
