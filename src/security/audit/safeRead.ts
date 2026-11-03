/**
 * Bounded, link-refusing file reads (and promotion into the artifacts dir).
 *
 * POSIX: open with O_NOFOLLOW|O_NONBLOCK, assurance "full".
 * win32: lstat+fstat identity algorithm, assurance "reduced-win32". That path
 * narrows the TOCTOU window but cannot close it against other host processes;
 * it is NOT fail-closed and reports say so.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Assurance, PromotionRecord, ReadCapability } from "./types.js";

export type SafeReadStep =
  | "path-syntax" | "root-identity" | "parent-component" | "leaf-lstat" | "limit"
  | "fstat-before" | "bounded-read" | "fstat-after" | "leaf-relstat" | "dest-parent" | "dest-create" | "dest-verify";

export type SafeReadFailure = { ok: false; step: SafeReadStep; detail: string };
export type SafeReadOk = { ok: true; bytes: Buffer; assurance: Assurance };
export type SafeReadResult = SafeReadOk | SafeReadFailure;

export interface RootIdentity { dev: bigint; ino: bigint; real: string }
export interface ReadLimits { perFile: number; total: number }
export interface ReadEnv {
  platform: NodeJS.Platform;
  /** Numeric O_ flags; undefined on win32 so the branch is selectable in tests. */
  constants: { O_NOFOLLOW?: number; O_NONBLOCK?: number; O_RDONLY: number };
  /** Test hook: called between lstat and open, to simulate a swap race. */
  beforeOpen?: () => void;
  /** Test hook: called between the first read and fstat-after, to simulate growth. */
  afterRead?: () => void;
}
const defaultEnv = (): ReadEnv => ({ platform: process.platform, constants: fs.constants });

const DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const fail = (step: SafeReadStep, detail: string): SafeReadFailure => ({ ok: false, step, detail });

export function readCapability(env: ReadEnv = defaultEnv()): ReadCapability {
  if (env.platform === "win32" || env.constants.O_NOFOLLOW === undefined) {
    return { platform: env.platform, assurance: "reduced-win32", reason: "no O_NOFOLLOW/O_NONBLOCK or directory-relative open on this platform" };
  }
  return { platform: env.platform, assurance: "full", reason: null };
}

/** Returns an error string, or null when the relative path is acceptable. */
export function checkRelPath(rel: string): string | null {
  if (typeof rel !== "string" || rel.length === 0) return "empty path";
  if (rel.length > 240) return "path too long";
  if (/^[A-Za-z]:/.test(rel)) return "drive letter";
  if (rel.startsWith("/") || rel.startsWith("\\")) return "absolute or UNC path";
  if (rel.includes("\\")) return "backslash";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(rel)) return "control character";
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return `bad segment "${seg}"`;
    if (seg.includes(":")) return "colon (alternate data stream)";
    if (/[. ]$/.test(seg)) return "segment ends with dot or space";
    const base = seg.split(".")[0] ?? "";
    if (DEVICE.test(base)) return "windows device name";
  }
  return null;
}

export function captureRootIdentity(root: string): RootIdentity {
  const st = fs.lstatSync(root, { bigint: true });
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("root is not a real directory");
  return { dev: st.dev, ino: st.ino, real: fs.realpathSync.native(root) };
}

const norm = (p: string, win: boolean): string => (win ? path.win32.normalize(p).toLowerCase() : path.normalize(p));

function checkRoot(root: string, id: RootIdentity, win: boolean): SafeReadFailure | null {
  let st: fs.BigIntStats;
  try {
    st = fs.lstatSync(root, { bigint: true });
  } catch (e) {
    return fail("root-identity", (e as Error).message);
  }
  if (!st.isDirectory() || st.isSymbolicLink()) return fail("root-identity", "root is not a real directory");
  if (st.dev !== id.dev || st.ino !== id.ino) return fail("root-identity", "root identity changed");
  if (norm(fs.realpathSync.native(root), win) !== norm(id.real, win)) return fail("root-identity", "root real path changed");
  return null;
}

function checkParents(root: string, rel: string, win: boolean): SafeReadFailure | null {
  const segs = rel.split("/").slice(0, -1);
  let cur = root;
  for (const s of segs) {
    cur = path.join(cur, s);
    let st: fs.BigIntStats;
    try {
      st = fs.lstatSync(cur, { bigint: true });
    } catch (e) {
      return fail("parent-component", (e as Error).message);
    }
    if (!st.isDirectory() || st.isSymbolicLink()) return fail("parent-component", `${s} is not a real directory`);
    if (norm(fs.realpathSync.native(cur), win) !== norm(path.resolve(cur), win)) return fail("parent-component", `${s} resolves elsewhere`);
  }
  return null;
}

const same = (a: fs.BigIntStats, b: fs.BigIntStats): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs;

export function safeRead(
  root: string, rel: string, id: RootIdentity, limits: ReadLimits, cumulative = 0, env: ReadEnv = defaultEnv(),
): SafeReadResult {
  const cap = readCapability(env);
  const win = cap.assurance === "reduced-win32";
  const bad = checkRelPath(rel);
  if (bad) return fail("path-syntax", bad);
  const rootBad = checkRoot(root, id, win);
  if (rootBad) return rootBad;
  const parBad = checkParents(root, rel, win);
  if (parBad) return parBad;

  const leaf = path.join(root, ...rel.split("/"));
  let st0: fs.BigIntStats;
  try {
    st0 = fs.lstatSync(leaf, { bigint: true });
  } catch (e) {
    return fail("leaf-lstat", (e as Error).message);
  }
  if (st0.isSymbolicLink() || !st0.isFile()) return fail("leaf-lstat", "leaf is not a regular file");
  if (st0.nlink !== 1n) return fail("leaf-lstat", "leaf has multiple hard links");
  if (st0.size > BigInt(limits.perFile) || BigInt(cumulative) + st0.size > BigInt(limits.total)) return fail("limit", "size limit exceeded");
  if (win && norm(fs.realpathSync.native(leaf), true) !== norm(path.resolve(leaf), true)) return fail("leaf-lstat", "leaf resolves elsewhere");

  env.beforeOpen?.();
  let fd: number;
  try {
    const flags = win ? env.constants.O_RDONLY : env.constants.O_RDONLY | (env.constants.O_NOFOLLOW ?? 0) | (env.constants.O_NONBLOCK ?? 0);
    fd = fs.openSync(leaf, flags);
  } catch (e) {
    return fail("leaf-lstat", (e as Error).message);
  }
  try {
    const st1 = fs.fstatSync(fd, { bigint: true });
    if (!st1.isFile() || !same(st0, st1)) return fail("fstat-before", "file changed between lstat and open");
    const want = Number(st1.size);
    const buf = Buffer.alloc(want + 1);
    let got = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, got, Math.min(65536, buf.length - got), got);
      if (n === 0) break;
      got += n;
      if (got > want) return fail("bounded-read", "file grew during read");
    }
    if (got !== want) return fail("bounded-read", "short read");
    env.afterRead?.();
    const st2 = fs.fstatSync(fd, { bigint: true });
    if (!same(st1, st2)) return fail("fstat-after", "file changed during read");
    if (win) {
      const st3 = fs.lstatSync(leaf, { bigint: true });
      if (st3.isSymbolicLink() || !same(st0, st3)) return fail("leaf-relstat", "leaf changed after read");
    }
    return { ok: true, bytes: buf.subarray(0, want), assurance: cap.assurance };
  } finally {
    fs.closeSync(fd);
  }
}

/** Copy one verified file from scratch to the parent-only artifacts dir. */
export function promote(
  scratchRoot: string, scratchId: RootIdentity, artifactsRoot: string, artifactsId: RootIdentity,
  rel: string, agentId: string, limits: ReadLimits, env: ReadEnv = defaultEnv(),
): { ok: true; record: PromotionRecord } | SafeReadFailure {
  const read = safeRead(scratchRoot, rel, scratchId, limits, 0, env);
  if (!read.ok) return read;
  const win = read.assurance === "reduced-win32";
  const rootBad = checkRoot(artifactsRoot, artifactsId, win);
  if (rootBad) return fail("dest-parent", rootBad.detail);
  const segs = rel.split("/");
  let cur = artifactsRoot;
  for (const s of segs.slice(0, -1)) {
    cur = path.join(cur, s);
    try {
      let st: fs.BigIntStats | undefined;
      try {
        st = fs.lstatSync(cur, { bigint: true });
      } catch {
        fs.mkdirSync(cur);
        st = fs.lstatSync(cur, { bigint: true });
      }
      if (!st.isDirectory() || st.isSymbolicLink()) return fail("dest-parent", `${s} is not a real directory`);
    } catch (e) {
      return fail("dest-parent", (e as Error).message);
    }
  }
  const dest = path.join(artifactsRoot, ...segs);
  let fd: number;
  try {
    fd = fs.openSync(dest, "wx");
  } catch (e) {
    return fail("dest-create", (e as Error).message);
  }
  try {
    fs.writeSync(fd, read.bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const st = fs.lstatSync(dest, { bigint: true });
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1n || st.size !== BigInt(read.bytes.length)) {
    try {
      fs.unlinkSync(dest);
    } catch { /* best effort */ }
    return fail("dest-verify", "destination did not verify");
  }
  return {
    ok: true,
    record: {
      agent_id: agentId, scratch_rel: rel, artifact_rel: `agents/${agentId}/artifacts/${rel}`,
      bytes: read.bytes.length, sha256: createHash("sha256").update(read.bytes).digest("hex"), assurance: read.assurance,
    },
  };
}

/** Convenience for validators: read one regular file by absolute path with a size cap. */
export function readBounded(file: string, maxBytes: number, env: ReadEnv = defaultEnv()): SafeReadResult {
  const dir = path.dirname(file);
  const base = path.basename(file);
  let id: RootIdentity;
  try {
    id = captureRootIdentity(dir);
  } catch (e) {
    return fail("root-identity", (e as Error).message);
  }
  return safeRead(dir, base, id, { perFile: maxBytes, total: maxBytes }, 0, env);
}
