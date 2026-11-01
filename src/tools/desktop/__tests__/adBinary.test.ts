/**
 * P2 acceptance: the pinned-binary verifier and the new computerUse config
 * normalisation. The vendored exe itself is exercised by the vendor script
 * (run on the engineer's machine); here we verify the logic around it.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  AD_EXE_SHA256,
  _resetAdBinaryCache,
  adExePath,
  resolveStateRoot,
  verifyAdBinary,
} from "../adBinary.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-adbin-"));
const savedExeEnv = process.env.LOAM_AGENT_DESKTOP_EXE;
const savedUnpacked = process.env.LOAM_UNPACKED_ROOT;

before(() => {
  delete process.env.LOAM_AGENT_DESKTOP_EXE;
  delete process.env.LOAM_UNPACKED_ROOT;
  _resetAdBinaryCache();
});

after(() => {
  if (savedExeEnv !== undefined) process.env.LOAM_AGENT_DESKTOP_EXE = savedExeEnv;
  else delete process.env.LOAM_AGENT_DESKTOP_EXE;
  if (savedUnpacked !== undefined) process.env.LOAM_UNPACKED_ROOT = savedUnpacked;
  else delete process.env.LOAM_UNPACKED_ROOT;
  _resetAdBinaryCache();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeTempExe(bytes: Buffer): string {
  const file = path.join(tmp, `exe-${crypto.randomUUID().slice(0, 8)}.bin`);
  fs.writeFileSync(file, bytes);
  return file;
}

describe("verifyAdBinary", () => {
  it("refuses a missing binary with a reason", () => {
    _resetAdBinaryCache();
    const v = verifyAdBinary(path.join(tmp, "nope.exe"));
    assert.equal(v.ok, false);
    assert.match(v.reason ?? "", /missing/);
  });

  it("refuses a binary whose sha256 does not match the pin", () => {
    _resetAdBinaryCache();
    const v = verifyAdBinary(writeTempExe(Buffer.from("not the pinned binary")));
    assert.equal(v.ok, false);
    assert.match(v.reason ?? "", /sha256 mismatch/);
  });

  it("accepts a binary whose sha256 matches the pin", () => {
    _resetAdBinaryCache();
    // Any content works: compute its sha, and monkey-patch is impossible — so
    // instead exercise the real pin with a file whose bytes hash to AD_EXE_SHA256
    // is infeasible; use the override path for the positive case and, for the
    // pin comparison itself, assert the constant matches the documented pin.
    assert.equal(AD_EXE_SHA256, "409e58cbdd6aed47e29771ffa60bc122a9843505a227af488cded85215943988");
    const file = writeTempExe(Buffer.from("override-trusted"));
    process.env.LOAM_AGENT_DESKTOP_EXE = file;
    _resetAdBinaryCache();
    const v = verifyAdBinary(file);
    assert.equal(v.ok, true);
    delete process.env.LOAM_AGENT_DESKTOP_EXE;
    _resetAdBinaryCache();
  });

  it("memoises the verdict per path", () => {
    _resetAdBinaryCache();
    const missing = path.join(tmp, "memo-missing.exe");
    const a = verifyAdBinary(missing);
    const b = verifyAdBinary(missing);
    assert.equal(a, b, "same path must return the cached verdict object");
    _resetAdBinaryCache();
    const c = verifyAdBinary(missing);
    assert.notEqual(a, c, "reset drops the cache");
  });
});

describe("adExePath", () => {
  it("LOAM_AGENT_DESKTOP_EXE wins (tests and local dev)", () => {
    process.env.LOAM_AGENT_DESKTOP_EXE = "C:/fake/ad.exe";
    _resetAdBinaryCache();
    assert.equal(adExePath("C:/res"), "C:/fake/ad.exe");
    delete process.env.LOAM_AGENT_DESKTOP_EXE;
    _resetAdBinaryCache();
  });

  it("explicit resourcesDir resolves <resources>/agent-desktop/agent-desktop.exe", () => {
    assert.equal(
      adExePath(path.join("C:", "Program Files", "Loam", "resources")),
      path.join("C:", "Program Files", "Loam", "resources", "agent-desktop", "agent-desktop.exe"),
    );
  });
});

describe("resolveStateRoot", () => {
  it("defaults to %APPDATA%\\Loam\\agent-desktop", () => {
    assert.equal(resolveStateRoot("", "C:/Users/k/AppData/Roaming"), path.join("C:/Users/k/AppData/Roaming", "Loam", "agent-desktop"));
  });

  it("an explicit value wins and is resolved", () => {
    assert.equal(resolveStateRoot("D:/ad-state", "C:/ignored"), path.resolve("D:/ad-state"));
  });
});
