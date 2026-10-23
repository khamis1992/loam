/**
 * Path classification: the safety-critical core.
 *
 * Adapted from jcode (MIT) ref/command-risk/src/paths.rs
 * jcode: https://github.com/1jehuang/jcode — Copyright (c) 2025 Jeremy Huang.
 *
 * Correctness here matters more than anywhere else in the classifier, because
 * the catastrophic tier is the one protection that cannot be talked around. It
 * is therefore written to be **absolute and simple**: a small set of paths that
 * may never be recursively destroyed, compared after normalization, with no
 * dependence on correctly understanding the surrounding command.
 *
 * Windows paths (`C:\...`, `\\server\share`) are handled alongside POSIX ones so
 * the same predicate protects a drive root and a UNC share.
 */

import type { RiskContext, RiskFinding, RiskLevel } from "./lib.js";

/** Credential stores. Protected *recursively*: destroying a single private key
 *  inside `~/.ssh` is as damaging as destroying the directory, so containment
 *  matters here and exact-match alone would leave an obvious hole. */
const PROTECTED_CREDENTIAL_SUBPATHS = [".ssh", ".gnupg", ".aws", ".kube", ".docker"];

/** Directories whose *wholesale* destruction is unacceptable, but whose
 *  individual files are legitimately edited and removed all the time. Matched
 *  exactly, so `~/.config` is protected while `~/.config/app/stale.toml` is not. */
const PROTECTED_HOME_SUBPATHS = [
  ".config",
  ".jcode",
  ".claude",
  ".local",
  ".local/share",
  "Documents",
  "Desktop",
];

/** Absolute system paths that must never be recursively destroyed. */
const PROTECTED_SYSTEM_PATHS = [
  "/",
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/lib64",
  "/opt",
  "/proc",
  "/root",
  "/sbin",
  "/srv",
  "/sys",
  "/usr",
  "/var",
  "/Applications",
  "/System",
  "/Library",
  "/Users",
  "/home",
];

/** System paths where the *contents* are as critical as the directory itself,
 *  so deleting a single file inside them is also unacceptable. */
const SYSTEM_PATHS_PROTECTED_RECURSIVELY = [
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/lib64",
  "/proc",
  "/sbin",
  "/sys",
  "/usr",
  "/var/lib",
  "/System",
  "/Library",
];

/** Well-known Windows roots that must not be destroyed wholesale. Matched
 *  exactly, so `C:/Users` is protected while the projects under it are not. */
const PROTECTED_WINDOWS_ROOTS = new Set([
  "users",
  "windows",
  "program files",
  "program files (x86)",
  "programdata",
  "perflogs",
  "system volume information",
]);

/** Conventional bit buckets are safe *redirect* destinations. They remain
 *  protected when explicitly passed to a destructive command such as `rm`. */
export function isSafeRedirectSink(raw: string): boolean {
  return raw === "/dev/null" || raw === "/dev/stdout" || raw === "/dev/stderr" || raw === "NUL";
}

/** A parsed path: a root (`/`, `C:`, `\\server\share`, or empty) plus segments. */
interface ParsedPath {
  root: string;
  segments: string[];
}

function parsePath(p: string): ParsedPath {
  let root = "";
  let rest = p;
  const drive = rest.match(/^([A-Za-z]):/);
  if (drive) {
    // Keep the colon: `C:` is the drive root, and `C:/a` must normalize back
    // to the same spelling so component comparison stays consistent.
    root = `${drive[1]!.toUpperCase()}:`;
    rest = rest.slice(2);
  } else if (rest.startsWith("\\\\") || rest.startsWith("//")) {
    const trimmed = rest.replace(/^[\\/]+/, "");
    const parts = trimmed.split(/[\\/]/);
    const server = parts[0] ?? "";
    const share = parts[1];
    root = share === undefined ? `\\\\${server}` : `\\\\${server}\\${share}`;
    rest = parts.slice(share === undefined ? 1 : 2).join("/");
  } else if (rest.startsWith("/")) {
    root = "/";
    rest = rest.slice(1);
  }
  const segments = rest.split(/[\\/]+/).filter((s) => s.length > 0);
  return { root, segments };
}

/** Lexically remove `.` and `..` so `/home/u/../..` is seen as `/`.
 *
 *  Without this, `rm -rf ~/../..` would walk straight past the protected-path
 *  check. Note this is intentionally *not* symlink-aware; see the crate docs on
 *  defense in depth. */
export function normalize(p: string): string {
  const { root, segments } = parsePath(p);
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(segment);
  }
  if (root === "/") return "/" + out.join("/");
  if (root) return root + "/" + out.join("/");
  return out.join("/");
}

/** Component-based prefix test: `/home/u/proj` starts with `/home/u`, but
 *  `/home/user` does not start with `/home/u`. */
export function pathStartsWith(p: string, prefix: string): boolean {
  const a = parsePath(p);
  const b = parsePath(prefix);
  if (a.root !== b.root) return false;
  if (b.segments.length > a.segments.length) return false;
  return b.segments.every((segment, index) => a.segments[index] === segment);
}

/** The parent path, or `null` for `/`, a drive root, or an empty path. */
export function pathParent(p: string): string | null {
  const { root, segments } = parsePath(p);
  if (segments.length === 0) return null;
  const out = segments.slice(0, -1);
  if (root === "/") return "/" + out.join("/");
  if (root) return root + "/" + out.join("/");
  return out.length > 0 ? out.join("/") : null;
}

/** The final component, or `null` for `/`, a drive root, or an empty path. */
export function pathFileName(p: string): string | null {
  const { segments } = parsePath(p);
  return segments.length > 0 ? segments[segments.length - 1]! : null;
}

/** Join a base directory with a relative path. */
export function pathJoin(base: string, relative: string): string {
  if (parsePath(relative).root !== "") return relative;
  const trimmed = base.replace(/[\\/]+$/, "");
  if (trimmed === "") return relative;
  return trimmed + "/" + relative;
}

/** Whether a path is absolute (POSIX root, drive letter, UNC, or `~`). */
export function isAbsolutePath(p: string): boolean {
  return parsePath(p).root !== "" || p.startsWith("~");
}

/** Expand only complete, known leading variables. Prefix lookalikes such as
 *  `$HOME_BACKUP` and shell parameter operators remain unresolved. */
export function expandKnownPrefix(raw: string, ctx: RiskContext): string {
  const candidates: Array<[string, string | undefined]> = [
    ["HOME", ctx.homeDir],
    ["JCODE_SCRATCH_DIR", ctx.scratchDir],
  ];
  for (const [name, value] of candidates) {
    if (!value) continue;
    for (const prefix of [`$${name}`, `\${${name}}`]) {
      if (raw.startsWith(prefix)) {
        const rest = raw.slice(prefix.length);
        if (rest === "" || rest.startsWith("/") || rest.startsWith("\\")) {
          return value + rest;
        }
      }
    }
  }
  // PowerShell `$env:NAME` spellings of the same variables.
  for (const [names, value] of [
    [["HOME", "USERPROFILE"], ctx.homeDir],
    [["JCODE_SCRATCH_DIR"], ctx.scratchDir],
  ] as Array<[string[], string | undefined]>) {
    if (!value) continue;
    for (const name of names) {
      for (const prefix of [`$env:${name}`, `\${env:${name}}`]) {
        if (raw.startsWith(prefix)) {
          const rest = raw.slice(prefix.length);
          if (rest === "" || rest.startsWith("/") || rest.startsWith("\\")) {
            return value + rest;
          }
        }
      }
    }
  }
  if (ctx.homeDir) {
    if (raw === "~") return ctx.homeDir;
    if (raw.startsWith("~/") || raw.startsWith("~\\")) {
      return ctx.homeDir + "/" + raw.slice(2);
    }
  }
  return raw;
}

/** Resolve `~`, `$HOME`, and relative paths into something comparable.
 *
 *  This is lexical only: it never touches the filesystem, so it is safe to call
 *  on paths that do not exist and cannot be slowed down by a hostile argument. */
export function expand(raw: string, ctx: RiskContext): string {
  const text = expandKnownPrefix(raw, ctx);
  // Never normalize unresolved substitutions away (e.g. `$UNKNOWN/..`).
  if (text.includes("$") || text.includes("`")) return text;

  if (isAbsolutePath(text)) return normalize(text);
  if (ctx.workingDir) return normalize(pathJoin(ctx.workingDir, text));
  return text;
}

/** Whether destroying this path is categorically unacceptable.
 *
 *  Exposed separately because this is the single most important predicate in
 *  the classifier and deserves to be testable in isolation. */
export function isCatastrophicTarget(path: string, ctx: RiskContext): boolean {
  // The drive/UNC roots below are compared before normalization so a trailing
  // separator never hides them.
  const raw = path.replace(/[\s]+$/, "");

  // A whole drive (`C:\`, `C:/`), a drive letter alone (`C:`), or a UNC share
  // (`\\server\share`) is the user's entire volume.
  if (/^[A-Za-z]:[\\/]?$/.test(raw)) return true;
  if (/^\\\\[^\\]+(\\[^\\]+)?$/.test(raw)) return true;

  // A well-known Windows root (`C:/Users`, `C:/Windows`) is the volume's user
  // or system tree. Only the root itself is protected, so `C:/Users/u/proj`
  // stays workable.
  const parsed = parsePath(normalize(path));
  if (/^[A-Za-z]:$/.test(parsed.root)) {
    const first = parsed.segments[0]?.toLowerCase();
    if (first !== undefined && PROTECTED_WINDOWS_ROOTS.has(first) && parsed.segments.length === 1) {
      return true;
    }
  }

  const normalized = normalize(path);

  // Exact system roots, plus anything inside the ones whose contents are as
  // unrecoverable as the directory itself (`/etc/passwd`). `/home` and `/Users`
  // are deliberately not recursive: a user's own project lives under them, and
  // the home directory itself is handled below.
  if (PROTECTED_SYSTEM_PATHS.some((p) => normalized === p)) return true;
  if (SYSTEM_PATHS_PROTECTED_RECURSIVELY.some((p) => pathStartsWith(normalized, p))) return true;

  if (!ctx.homeDir) return false;
  const home = normalize(ctx.homeDir);

  // The home directory itself.
  if (normalized === home) return true;
  // Credential stores, including anything inside them.
  if (PROTECTED_CREDENTIAL_SUBPATHS.some((sub) => pathStartsWith(normalized, pathJoin(home, sub)))) {
    return true;
  }
  // Config and document roots, but not their individual files.
  if (PROTECTED_HOME_SUBPATHS.some((sub) => normalized === pathJoin(home, sub))) return true;

  return false;
}

/** Windows device names are device nodes, so writing to them is as dangerous
 *  as writing to `/dev/sda`. */
const WINDOWS_DEVICE_NAMES = new Set([
  "NUL",
  "CON",
  "PRN",
  "AUX",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

/** Temp directories are conventionally disposable, so deleting inside them is
 *  not worth a reflection turn. */
export function isTempPath(path: string): boolean {
  if (["/tmp", "/var/tmp", "/private/tmp"].some((prefix) => pathStartsWith(path, prefix))) {
    return true;
  }
  // Windows: a path whose final component is `Temp`/`tmp` and whose root is a
  // drive letter, e.g. `C:/Users/u/AppData/Local/Temp` or `D:/tmp`.
  const parsed = parsePath(path);
  if (/^[A-Za-z]:$/.test(parsed.root)) {
    const leaf = parsed.segments[parsed.segments.length - 1]?.toLowerCase();
    // A bare `D:/tmp` is a drive-rooted scratch dir, so it is disposable too.
    return leaf === "temp" || (leaf === "tmp" && parsed.segments.length === 1);
  }
  return false;
}

/** PowerShell spellings of the temp directory, which is disposable. */
const TEMP_ENV_VARS = /^\$\{?env:(TEMP|TMP)\}?$/i;

/** Classify one resolved target, returning a finding when it is notable. */
export function classifyTarget(
  expanded: string,
  raw: string,
  recursive: boolean,
  ctx: RiskContext,
): RiskFinding | null {
  const unresolved = expandKnownPrefix(raw, ctx).includes("$") || expandKnownPrefix(raw, ctx).includes("`");

  // Glob and variable expansion we did not perform: we cannot know the
  // footprint, so escalate rather than guess.
  if ((raw.includes("*") || raw.includes("?")) && !unresolved) {
    const parent = pathParent(expanded);
    // A bare `/*` or `~/*` is catastrophic in effect even though no single
    // resolved path is protected.
    if (parent !== null && isCatastrophicTarget(parent, ctx) && pathFileName(expanded) === "*") {
      return {
        level: "Catastrophic" as RiskLevel,
        reason: "would destroy the entire contents of a protected directory",
        target: raw,
      };
    }
    // A glob in a filename cannot escape its concrete parent directory. Keep
    // wildcard directory components conservative because their parent is not
    // the actual expansion boundary (`/home/u/*/node_modules`).
    if (parent !== null && !parent.includes("*") && !parent.includes("?")) {
      const insideCwd = ctx.workingDir !== undefined && pathStartsWith(parent, normalize(ctx.workingDir));
      if (insideCwd || isTempPath(parent)) {
        return {
          level: "Low" as RiskLevel,
          reason: "glob is bounded to the working or temporary directory",
          target: raw,
        };
      }
    }
    return {
      level: "Confirm" as RiskLevel,
      reason:
        "target contains a glob, so the exact set of affected files is not known before execution",
      target: raw,
    };
  }

  // Check the resolved path first: `$HOME` expands to a protected path and must
  // be denied outright, not merely queried. Only genuinely unresolvable
  // substitutions fall through to the Confirm tier below.
  if (isCatastrophicTarget(expanded, ctx)) {
    return {
      level: "Catastrophic" as RiskLevel,
      reason: "targets a protected system or home path that must never be destroyed",
      target: expanded,
    };
  }

  // `$env:TEMP` and friends denote a disposable directory even though the value
  // is resolved at runtime.
  if (TEMP_ENV_VARS.test(raw)) return null;

  if (unresolved) {
    return {
      level: "Confirm" as RiskLevel,
      reason:
        "target is computed at runtime (variable or command substitution), so its value cannot be checked in advance",
      target: raw,
    };
  }

  // Raw device nodes are never a safe write target.
  if (
    pathStartsWith(expanded, "/dev") &&
    !pathStartsWith(expanded, "/dev/null") &&
    !pathStartsWith(expanded, "/dev/stdout") &&
    !pathStartsWith(expanded, "/dev/stderr")
  ) {
    return {
      level: "Catastrophic" as RiskLevel,
      reason: "writes directly to a device node, which can destroy a filesystem or disk",
      target: expanded,
    };
  }
  const deviceLeaf = (pathFileName(expanded) ?? "").toUpperCase();
  if (WINDOWS_DEVICE_NAMES.has(deviceLeaf) && !isSafeRedirectSink(raw)) {
    return {
      level: "Catastrophic" as RiskLevel,
      reason: "writes directly to a device node, which can destroy a filesystem or disk",
      target: expanded,
    };
  }

  const insideCwd = ctx.workingDir !== undefined && pathStartsWith(expanded, normalize(ctx.workingDir));

  if (insideCwd) {
    // The routine case: an agent tidying up its own workspace.
    return recursive
      ? {
          level: "Low" as RiskLevel,
          reason: "recursive delete inside the working directory",
          target: expanded,
        }
      : null;
  }

  if (isTempPath(expanded)) return null;

  // A concrete path being outside the workspace is not, by itself, a reason to
  // interrupt the agent. Protected home/system paths and unknown targets have
  // already returned above. Keep this as Low so the operation remains visible
  // in risk logs without requiring a justification retry.
  return {
    level: "Low" as RiskLevel,
    reason: "destructive operation targets a concrete path outside the working directory",
    target: expanded,
  };
}
