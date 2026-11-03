import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureRootIdentity, checkRelPath, promote, readCapability, safeRead } from "../safeRead.js";
import type { ReadEnv } from "../safeRead.js";

const LIM = { perFile: 1024, total: 4096 };
const win: ReadEnv = { platform: "win32", constants: { O_RDONLY: 0 } };
const posix: ReadEnv = { platform: "linux", constants: { O_RDONLY: 0, O_NOFOLLOW: fs.constants.O_NOFOLLOW ?? 0, O_NONBLOCK: fs.constants.O_NONBLOCK ?? 0 } };

function tmp(): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "audit-sr-")));
}

test("T1 normal file reads and reports assurance per platform", () => {
  const r = tmp();
  fs.writeFileSync(path.join(r, "a.txt"), "hello");
  const id = captureRootIdentity(r);
  const w = safeRead(r, "a.txt", id, LIM, 0, win);
  assert.ok(w.ok);
  if (w.ok) assert.equal(w.assurance, "reduced-win32");
  assert.equal(readCapability(posix).assurance, "full");
});

test("T9 path syntax rejections", () => {
  for (const p of ["C:\\x", "\\\\srv\\x", "a\\b", "a/../b", "a//b", "a.txt:ads", "con.txt", "x.", "", "/abs"]) {
    assert.notEqual(checkRelPath(p), null, p);
  }
  assert.equal(checkRelPath("dir/file.txt"), null);
});

test("T5 directory leaf and T4 hard link are refused at leaf-lstat", () => {
  const r = tmp();
  fs.mkdirSync(path.join(r, "d"));
  fs.writeFileSync(path.join(r, "f"), "x");
  fs.linkSync(path.join(r, "f"), path.join(r, "g"));
  const id = captureRootIdentity(r);
  for (const p of ["d", "g"]) {
    const res = safeRead(r, p, id, LIM, 0, win);
    assert.ok(!res.ok);
    if (!res.ok) assert.equal(res.step, "leaf-lstat");
  }
});

test("T3 junction parent is refused at parent-component", () => {
  const r = tmp();
  const outside = tmp();
  fs.writeFileSync(path.join(outside, "s.txt"), "secret");
  fs.symlinkSync(outside, path.join(r, "j"), "junction");
  const id = captureRootIdentity(r);
  const res = safeRead(r, "j/s.txt", id, LIM, 0, win);
  assert.ok(!res.ok);
  if (!res.ok) assert.equal(res.step, "parent-component");
});

test("T6 size limits", () => {
  const r = tmp();
  fs.writeFileSync(path.join(r, "big"), Buffer.alloc(2000));
  fs.writeFileSync(path.join(r, "ok"), Buffer.alloc(600));
  const id = captureRootIdentity(r);
  const a = safeRead(r, "big", id, LIM, 0, win);
  assert.ok(!a.ok && a.step === "limit");
  const b = safeRead(r, "ok", id, LIM, 4000, win);
  assert.ok(!b.ok && b.step === "limit");
});

test("T7 file swapped between lstat and open", () => {
  const r = tmp();
  fs.writeFileSync(path.join(r, "a"), "one");
  const id = captureRootIdentity(r);
  const res = safeRead(r, "a", id, LIM, 0, { ...win, beforeOpen: () => fs.writeFileSync(path.join(r, "a"), "twotwo") });
  assert.ok(!res.ok && res.step === "fstat-before");
});

test("T8 file changes during read", () => {
  const r = tmp();
  fs.writeFileSync(path.join(r, "a"), "one");
  const id = captureRootIdentity(r);
  const res = safeRead(r, "a", id, LIM, 0, { ...win, afterRead: () => fs.appendFileSync(path.join(r, "a"), "more") });
  assert.ok(!res.ok && res.step === "fstat-after");
});

test("T10 root replaced after run start", () => {
  const r = tmp();
  fs.writeFileSync(path.join(r, "a"), "x");
  const id = captureRootIdentity(r);
  const moved = r + "-old";
  fs.renameSync(r, moved);
  fs.mkdirSync(r);
  fs.writeFileSync(path.join(r, "a"), "x");
  const res = safeRead(r, "a", id, LIM, 0, win);
  assert.ok(!res.ok && res.step === "root-identity");
});

test("T11 destination exists is not overwritten; T12 promotion succeeds", () => {
  const s = tmp();
  const a = tmp();
  fs.writeFileSync(path.join(s, "poc.txt"), "payload");
  const sid = captureRootIdentity(s);
  const aid = captureRootIdentity(a);
  const ok = promote(s, sid, a, aid, "poc.txt", "h1", LIM, win);
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.record.assurance, "reduced-win32");
    assert.equal(ok.record.sha256.length, 64);
  }
  const again = promote(s, sid, a, aid, "poc.txt", "h1", LIM, win);
  assert.ok(!again.ok && again.step === "dest-create");
  assert.equal(fs.readFileSync(path.join(a, "poc.txt"), "utf8"), "payload");
});
