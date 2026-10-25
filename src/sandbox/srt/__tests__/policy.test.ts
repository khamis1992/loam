import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_LOAM_SRT_POLICY,
  SRT_TARBALL_SHA256,
  SRT_WIN_X64_SHA256,
  SRT_WIN_ARM64_SHA256,
  normalizeDomains,
  normalizeSrtMode,
  resolveSrtPolicy,
  shouldSandboxCommand,
  srtAuditPath,
  srtPinRoot,
  srtSettingsFile,
  srtWinExePath,
  verifySrtPin,
} from "../policy.js";

test("default policy is default-deny (appendix C2, spec 6.3): no egress, no credentials, off", () => {
  assert.equal(DEFAULT_LOAM_SRT_POLICY.mode, "off"); // OD-1 gate
  assert.equal(DEFAULT_LOAM_SRT_POLICY.strictAllowlist, true); // OD-7
  assert.deepEqual(DEFAULT_LOAM_SRT_POLICY.allowedDomains, []);
  assert.equal(DEFAULT_LOAM_SRT_POLICY.allowLocalBinding, false); // OD-5
  for (const cred of ["~/.ssh", "~/.gnupg", "~/.aws", "~/.azure", "~/.kube", "~/.docker"]) {
    assert.ok(DEFAULT_LOAM_SRT_POLICY.denyRead.includes(cred), cred);
  }
  assert.ok(DEFAULT_LOAM_SRT_POLICY.denyWrite.includes(".env"));
});

test("supply-chain constants are the recorded triple (appendix C8)", () => {
  assert.match(SRT_TARBALL_SHA256, /^[a-f0-9]{64}$/);
  assert.match(SRT_WIN_X64_SHA256, /^[a-f0-9]{64}$/);
  assert.match(SRT_WIN_ARM64_SHA256, /^[a-f0-9]{64}$/);
});

test("paths: pin outside workspace, Loam-owned settings file, audit JSONL", () => {
  const d = "D:/loam-data";
  assert.equal(srtPinRoot(d), path.join(d, "bin", "srt", "0.0.81"));
  assert.equal(srtSettingsFile(d), path.join(d, "srt", "loam-srt-settings.json"));
  assert.equal(srtAuditPath(d), path.join(d, "srt", "audit.jsonl"));
  assert.ok(srtWinExePath("x64", d).includes(path.join("vendor", "srt-win", "x64", "srt-win.exe")));
  assert.ok(!srtSettingsFile(d).startsWith(os.homedir()), "never ~/.srt-settings.json");
});

test("mode normalization rejects unknown values (fail to off)", () => {
  assert.equal(normalizeSrtMode("untrusted_only"), "untrusted_only");
  assert.equal(normalizeSrtMode("all_shell"), "all_shell");
  assert.equal(normalizeSrtMode("off"), "off");
  assert.equal(normalizeSrtMode("UNTRUSTED_ONLY"), "off");
  assert.equal(normalizeSrtMode(undefined), "off");
});

test("domain normalization: dedupes, lowercases, rejects junk (OD-7 hygiene)", () => {
  assert.deepEqual(normalizeDomains(["GitHub.com", "github.com", "  ", 42, "a b", "*.npmjs.org", "x".repeat(300)]), ["*.npmjs.org", "github.com"]);
  assert.deepEqual(normalizeDomains(undefined), []);
  assert.deepEqual(normalizeDomains("github.com"), []);
});

test("shouldSandboxCommand implements C6 semantics", () => {
  assert.equal(shouldSandboxCommand("off", "ask_for_approval"), false);
  assert.equal(shouldSandboxCommand("all_shell", "full_access"), true);
  assert.equal(shouldSandboxCommand("untrusted_only", "ask_for_approval"), true);
  assert.equal(shouldSandboxCommand("untrusted_only", "approve_for_me"), true);
  assert.equal(shouldSandboxCommand("untrusted_only", "full_access"), false); // explicit user trust
  assert.equal(shouldSandboxCommand("untrusted_only", undefined), true); // unknown trust → contained
});

test("resolveSrtPolicy merges user settings without widening denies", () => {
  const p = resolveSrtPolicy({ sandboxMode: "all_shell", sandboxAllowedDomains: ["Example.com", "example.com"] });
  assert.equal(p.mode, "all_shell");
  assert.deepEqual(p.allowedDomains, ["example.com"]);
  assert.deepEqual(p.denyRead, DEFAULT_LOAM_SRT_POLICY.denyRead);
  const off = resolveSrtPolicy({ sandboxMode: "weird" });
  assert.equal(off.mode, "off");
});

test("verifySrtPin: hash-gated against a fabricated pin (mismatch disables)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "srt-pin-"));
  try {
    // Empty dir → missing.
    assert.equal(verifySrtPin(dir).ok, false);
    // Correct entry + tampered exe → sha256 mismatch.
    const pkgDir = path.join(srtPinRoot(dir), "node_modules", "@anthropic-ai", "sandbox-runtime");
    fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "dist", "index.js"), "export {}");
    const winDir = path.dirname(srtWinExePath("x64", dir));
    fs.mkdirSync(winDir, { recursive: true });
    fs.writeFileSync(srtWinExePath("x64", dir), Buffer.alloc(4_020_736, 7)); // right size, wrong bytes
    const bad = verifySrtPin(dir, "x64");
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, "srt-win-sha256-mismatch");
    // Wrong size → size mismatch.
    fs.writeFileSync(srtWinExePath("x64", dir), Buffer.alloc(10));
    assert.equal(verifySrtPin(dir, "x64").reason, "srt-win-size-mismatch");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("verifySrtPin: green against the REAL installed pin (live, this PC)", () => {
  // Installed by scripts/install-srt.mjs; skipped silently on machines without the pin
  // (CI) so the unit suite stays offline-safe.
  const root = process.env.MANUS_LOCAL_DATA_DIR || process.env.LOAM_DATA_DIR || path.resolve("."); 
  const result = verifySrtPin(path.join(root, "data"));
  if (result.ok) {
    assert.ok(result.srtWin.endsWith("srt-win.exe"));
  } else {
    assert.ok(["pin-entry-missing", "srt-win-missing"].includes(result.reason ?? ""), `unexpected reason: ${result.reason}`);
  }
});
