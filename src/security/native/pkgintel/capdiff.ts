/**
 * Capability-diff (socket-cli technique, ALL_SERVICES §9): given two package manifests
 * (before/after an upgrade), report the *new powers* the update grants — added
 * dependencies, install hooks, new bin shims, native builds, repo-URL changes.
 * Offline and deterministic; feeds supplychain_scan.
 */
export interface ManifestShape {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  bin?: string | Record<string, string>;
  gypfile?: boolean;
  repository?: { url?: string } | string;
}

export interface CapabilityDelta { kind: string; detail: string }

const HOOK_RE = /^(pre|post)?(install|prepare|test)$/;

export function diffCapabilities(before: ManifestShape, after: ManifestShape): CapabilityDelta[] {
  const out: CapabilityDelta[] = [];
  const bDep = before.dependencies ?? {};
  const aDep = after.dependencies ?? {};
  const bOpt = before.optionalDependencies ?? {};
  const aOpt = after.optionalDependencies ?? {};
  for (const [name, range] of Object.entries(aDep)) {
    if (!(name in bDep)) out.push({ kind: "new-dependency", detail: `adds dependency ${name}@${range}` });
    else if (bDep[name] !== range) out.push({ kind: "changed-dependency", detail: `${name}: ${bDep[name]} → ${range}` });
  }
  for (const [name, range] of Object.entries(aOpt)) if (!(name in bOpt) && !(name in bDep)) out.push({ kind: "new-optional-dependency", detail: `adds optional dependency ${name}@${range}` });
  for (const [hook, cmd] of Object.entries(after.scripts ?? {})) {
    if (!HOOK_RE.test(hook)) continue;
    if (!(before.scripts ?? {})[hook]) out.push({ kind: "new-install-hook", detail: `new ${hook} hook runs arbitrary code: ${cmd.slice(0, 120)}` });
  }
  if (after.bin && !before.bin) out.push({ kind: "new-bin", detail: "installs new executable shims on PATH" });
  if (after.gypfile && !before.gypfile) out.push({ kind: "native-build", detail: "compiles native code at install time" });
  const repoOf = (m: ManifestShape): string => (typeof m.repository === "string" ? m.repository : m.repository?.url ?? "");
  if (repoOf(after) && repoOf(before) && repoOf(after) !== repoOf(before)) out.push({ kind: "repo-change", detail: `source repository moved: ${repoOf(before)} → ${repoOf(after)}` });
  return out;
}
