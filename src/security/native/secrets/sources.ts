/** Where secret text comes from: a directory walk (chunked, size-capped, binaries skipped) or git history (added lines only). */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SecretScanner } from "./engine.js";
import type { SecretFinding } from "./engine.js";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "coverage", "vendor", ".venv", "__pycache__"]);
export const MAX_FILE_BYTES = 2_000_000;
const CHUNK = 100_000;
const MAX_FILES = 20_000;

const looksBinary = (b: Buffer): boolean => b.subarray(0, 8000).includes(0);

/** Cut a chunk at the next newline so a secret is never split across two scans. */
function* chunks(text: string): Generator<{ text: string; lineBase: number }> {
  let pos = 0;
  let lineBase = 0;
  while (pos < text.length) {
    let end = Math.min(text.length, pos + CHUNK);
    if (end < text.length) { const nl = text.indexOf("\n", end); end = nl === -1 ? text.length : nl + 1; }
    const piece = text.slice(pos, end);
    yield { text: piece, lineBase };
    for (let i = 0; i < piece.length; i++) if (piece.charCodeAt(i) === 10) lineBase++;
    pos = end;
  }
}

export function scanDirectory(root: string, scanner: SecretScanner, skipTopDirs?: ReadonlySet<string>): SecretFinding[] {
  const out: SecretFinding[] = [];
  let files = 0;
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files >= MAX_FILES) return;
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        // Top-level caller-declared exclusions (e.g. a repo self-scan skipping its
        // own runtime artifacts) — the walk never descends, so the MAX_FILES
        // budget is not consumed by copied worktrees before real source is read.
        if (depth === 0 && skipTopDirs?.has(e.name)) continue;
        if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      files++;
      let buf: Buffer;
      try {
        if (fs.statSync(full).size > MAX_FILE_BYTES) continue;
        buf = fs.readFileSync(full);
      } catch { continue; }
      if (looksBinary(buf)) continue;
      const rel = path.relative(root, full).split(path.sep).join("/");
      for (const c of chunks(buf.toString("utf8"))) {
        for (const f of scanner.scan(c.text, rel)) out.push({ ...f, line: f.line + c.lineBase });
      }
    }
  };
  walk(root, 0);
  return out;
}

/** Parse `git log -p -U0` output into per-commit added lines. */
export function parseGitLog(log: string): Array<{ commit: string; file: string; text: string; firstLine: number }> {
  const out: Array<{ commit: string; file: string; text: string; firstLine: number }> = [];
  let commit = ""; let file = "";
  let cur: { commit: string; file: string; text: string[]; firstLine: number } | null = null;
  const flush = (): void => {
    if (cur && cur.text.length) out.push({ ...cur, text: cur.text.join("\n") });
    cur = null;
  };
  for (const line of log.split(/\r?\n/)) {
    const c = /^commit ([0-9a-f]{7,40})/.exec(line);
    if (c) { flush(); commit = c[1]!; continue; }
    const f = /^\+\+\+ b\/(.+)$/.exec(line);
    if (f) { flush(); file = f[1]!; continue; }
    const h = /^@@ -\S+ \+(\d+)/.exec(line);
    if (h) { flush(); cur = { commit, file, text: [], firstLine: Number(h[1]) }; continue; }
    if (cur && line.startsWith("+") && !line.startsWith("+++")) cur.text.push(line.slice(1));
  }
  flush();
  return out;
}

export function scanGitHistory(root: string, opts: { redactPercent?: number; ignore?: ReadonlySet<string>; maxBuffer?: number } = {}): Promise<SecretFinding[]> {
  return new Promise((resolve) => {
    execFile("git", ["-C", root, "log", "-p", "-U0", "--full-history", "--all", "--no-color"],
      { maxBuffer: opts.maxBuffer ?? 64_000_000, windowsHide: true }, (err, stdout) => {
        if (err && !stdout) { resolve([]); return; }
        const out: SecretFinding[] = [];
        for (const p of parseGitLog(stdout)) {
          const s = new SecretScanner({ commit: p.commit, ...(opts.redactPercent !== undefined ? { redactPercent: opts.redactPercent } : {}), ...(opts.ignore ? { ignore: opts.ignore } : {}) });
          for (const f of s.scan(p.text, p.file)) out.push({ ...f, line: f.line + p.firstLine - 1 });
        }
        resolve(out);
      });
  });
}

/** One fingerprint per line; `#` starts a comment. */
export function loadIgnoreFile(root: string): Set<string> {
  const out = new Set<string>();
  for (const name of [".loamignore", ".gitleaksignore"]) {
    try {
      for (const l of fs.readFileSync(path.join(root, name), "utf8").split(/\r?\n/)) {
        const t = l.trim();
        if (t && !t.startsWith("#")) out.add(t);
      }
    } catch { /* absent */ }
  }
  return out;
}
