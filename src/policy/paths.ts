import fs from "node:fs";
import path from "node:path";

function norm(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(norm(root), norm(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Resolve existing ancestors, including junctions; retain a not-yet-created suffix. */
function physicalPath(input: string): string {
  let current = path.resolve(input);
  const suffix: string[] = [];
  for (;;) {
    try {
      // lstat detects dangling links too; realpath then rejects them rather than treating them as absent.
      fs.lstatSync(current);
      return path.resolve(fs.realpathSync(current), ...suffix);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
      try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`unresolved symbolic link: ${current}`); }
      catch (linkErr) { if ((linkErr as NodeJS.ErrnoException).code !== "ENOENT") throw linkErr; }
      const parent = path.dirname(current);
      if (parent === current) throw new Error(`cannot resolve path: ${input}`);
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function assertContained(workspace: string, abs: string, action: string): void {
  if (!isInside(workspace, abs) || !isInside(physicalPath(workspace), physicalPath(abs))) {
    throw new Error(`path outside workspace (${action} denied): ${abs}`);
  }
}

/** Resolve a path that will be WRITTEN — must stay inside the workspace. */
export function resolveWrite(workspace: string, input?: string): string {
  const raw = input && input.trim().length > 0 ? input : ".";
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workspace, raw);
  assertContained(workspace, abs, "write");
  return abs;
}

/** Resolve a path for READING — inside workspace, or outside only when allowed. */
export function resolveRead(workspace: string, input: string, allowOutside: boolean): string {
  const abs = path.isAbsolute(input) ? path.resolve(input) : path.resolve(workspace, input);
  if (!allowOutside) assertContained(workspace, abs, "read");
  return abs;
}

export function assertExists(p: string): void {
  if (!fs.existsSync(p)) throw new Error(`not found: ${p}`);
}
