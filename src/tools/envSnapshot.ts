/**
 * Environment blueprint + snapshot (Devin parity: blueprint → snapshot → every
 * session boots a fresh copy).
 *
 * A project folder carries an optional `loam.env.yaml` describing how to bring
 * the environment up:
 *
 * ```yaml
 * repos: [../shared-lib]                 # extra repos cloned beside the project
 * setup: [npm ci, echo done]             # shell steps, run ONCE per build
 * env: { NODE_ENV: development }         # plain env vars (never secrets)
 * secrets: [API_KEY]                     # vault names ONLY — values are
 *                                        # resolved server-side per build
 * cache: [node_modules, .next/cache]    # copied from the base snapshot into
 *                                        # each task worktree
 * ```
 *
 * `env_blueprint_generate` infers that file from the project's manifest
 * (package.json / lockfiles, requirements.txt, Cargo.toml, …). The builder
 * materializes a cached base environment under
 * `DATA_DIR/env-snapshots/<project>/<hash>` (hash = blueprint + lockfiles) and
 * records the build status plus a log whose secrets are redacted. Every task
 * worktree clones that base, so the setup steps are never re-run while the hash
 * is unchanged.
 *
 * Safety rules baked in here:
 *  - secrets appear ONLY as vault names; values are resolved server-side into
 *    the child process environment and registered with the log redactor, so no
 *    value can reach a log, a status payload or model context.
 *  - setup steps go through the same command policy as `shell_run`.
 *  - every path the builder touches stays inside the data dir or the project
 *    folder; an absolute path inside a blueprint is refused.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { load as loadYaml, dump as dumpYaml } from "js-yaml";
import { DATA_DIR } from "../config.js";
import { checkCommand } from "../policy/commands.js";
import { isInside } from "../policy/paths.js";
import { log } from "../log.js";
import type { Config } from "../config.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { bool, str } from "./registry.js";
import { planVaultEnv, redactVaultValues, vaultRef, vaultScope } from "./vaultTools.js";

const execFileAsync = promisify(execFile);
const execOpts = { windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 } as const;
const MAX_LOG = 200_000;

export const BLUEPRINT_FILE = "loam.env.yaml";

/** Reserved names that may never be treated as a vault secret name. */
const NON_SECRET_REFS = new Set(["HOME", "PATH", "PWD", "USERPROFILE", "TEMP", "TMP", "OS"]);

/** Directories a package manager ignores when it walks up for a workspace root. */
const NODE_IGNORES = new Set([".git", "node_modules", ".loam-tasks", "dist", "build", "deliverables", ".next", "coverage"]);

export interface EnvBlueprintRepo {
  path: string;
  /** Optional branch/tag/commit; defaults to the remote HEAD. */
  ref?: string;
  /** Local subdirectory (relative to the repo) that becomes the worktree root. */
  subdir?: string;
}

export interface EnvBlueprint {
  /** Extra repositories cloned beside the project checkout. */
  repos?: EnvBlueprintRepo[];
  /** Shell steps executed once per build, in order, in the project checkout. */
  setup?: string[];
  /** Plain environment variables applied to every step of the build. */
  env?: Record<string, string>;
  /** Vault secret NAMES (never values) resolved into the build environment. */
  secrets?: string[];
  /** Directories copied from the base snapshot into each task worktree. */
  cache?: string[];
}

export interface EnvBuildRecord {
  projectId: string;
  projectFolder: string;
  hash: string;
  status: "built" | "failed";
  steps: string[];
  /** Redacted build log (stdout/stderr of every step). */
  log: string;
  stepsRun: number;
  durationMs: number;
  createdAt: string;
  error?: string;
}

// ----------------------------------------------------------------------------
// Directories + ids
// ----------------------------------------------------------------------------

/** Root of the cached base environments: DATA_DIR/env-snapshots/<project>/<hash>. */
export function envSnapshotsRoot(): string {
  return path.join(DATA_DIR, "env-snapshots");
}

export function envProjectDir(projectId: string): string {
  return path.join(envSnapshotsRoot(), sanitizeSegment(projectId));
}

export function envSnapshotDir(projectId: string, hash: string): string {
  return path.join(envProjectDir(projectId), sanitizeSegment(hash));
}

export function envBlueprintPath(projectFolder: string): string {
  return path.join(projectFolder, BLUEPRINT_FILE);
}

export function envStatusPath(projectId: string): string {
  return path.join(envProjectDir(projectId), "status.json");
}

/** `<projectId>/<hash>` identity of a build, safe for URLs and the filesystem. */
export function envBuildId(projectId: string, hash: string): string {
  return `${sanitizeSegment(projectId)}/${sanitizeSegment(hash)}`;
}

/** Filesystem- and URL-safe segment: no separators, no traversal, no control chars. */
export function sanitizeSegment(input: string): string {
  const cleaned = input.trim().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
  if (!cleaned || cleaned === "." || cleaned === "..") throw new Error(`invalid env-snapshot id segment: ${input}`);
  return cleaned;
}

// ----------------------------------------------------------------------------
// Blueprint parsing / validation
// ----------------------------------------------------------------------------

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseRepos(value: unknown): EnvBlueprintRepo[] {
  if (value === undefined || value === null) return [];
  const out: EnvBlueprintRepo[] = [];
  const entries = Array.isArray(value) ? value : [value];
  for (const entry of entries) {
    if (typeof entry === "string") {
      const p = entry.trim();
      if (p) out.push({ path: p });
      continue;
    }
    if (entry && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      const p = asString(record["path"]);
      if (!p) continue;
      const ref = asString(record["ref"]);
      const subdir = asString(record["subdir"]);
      out.push({ path: p, ...(ref ? { ref } : {}), ...(subdir ? { subdir } : {}) });
    }
  }
  return out;
}

function parseStringArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const entries = Array.isArray(value) ? value : [value];
  return entries.map((v) => (typeof v === "string" ? v.trim() : "")).filter((v) => v.length > 0);
}

function parseEnv(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const name = String(key).trim();
    if (!name) continue;
    if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") continue;
    out[name] = String(raw);
  }
  return out;
}

function sortEntries<T>(values: T[], key: (item: T) => string): T[] {
  return [...values].sort((a, b) => key(a).localeCompare(key(b)));
}

/** Parse + normalize a blueprint object. Unknown keys are ignored, never fatal. */
export function normalizeBlueprint(input: unknown): EnvBlueprint {
  const raw = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const repos = sortEntries(parseRepos(raw["repos"]), (r) => r.path);
  const setup = sortEntries(parseStringArray(raw["setup"]), (s) => s);
  const env = parseEnv(raw["env"]);
  const secrets = sortEntries(
    parseStringArray(raw["secrets"]).filter((name) => !NON_SECRET_REFS.has(name)),
    (s) => s,
  );
  const cache = sortEntries(parseStringArray(raw["cache"]), (c) => c);
  for (const repo of repos) {
    if (path.isAbsolute(repo.path)) throw new Error(`repos[].path must be relative: ${repo.path}`);
    if (repo.subdir && (path.isAbsolute(repo.subdir) || repo.subdir.split(/[\\/]/).some((p) => p === ".."))) {
      throw new Error(`repos[].subdir must stay inside the repo: ${repo.subdir}`);
    }
    if (repo.path.split(/[\\/]/).some((p) => p === "..")) {
      throw new Error(`repos[].path must not escape: ${repo.path}`);
    }
  }
  for (const name of secrets) {
    if (!/^[A-Za-z0-9_.-]{1,48}$/.test(name)) throw new Error(`invalid secret name (vault refs only): ${name}`);
  }
  for (const entry of cache) {
    if (path.isAbsolute(entry) || entry.split(/[\\/]/).some((p) => p === "..")) {
      throw new Error(`cache entries must be relative paths inside the project: ${entry}`);
    }
  }
  return { repos, setup, env, secrets, cache };
}

/** Read the project's `loam.env.yaml`; an empty blueprint when it is absent. */
export function readBlueprint(projectFolder: string): EnvBlueprint {
  const file = envBlueprintPath(projectFolder);
  if (!fs.existsSync(file)) return normalizeBlueprint({});
  const parsed = loadYaml(fs.readFileSync(file, "utf8"));
  if (parsed === null || parsed === undefined) return normalizeBlueprint({});
  return normalizeBlueprint(parsed);
}

export function writeBlueprint(projectFolder: string, blueprint: EnvBlueprint): void {
  const file = envBlueprintPath(projectFolder);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, dumpYaml(blueprint, { lineWidth: 0 }), "utf8");
  fs.renameSync(tmp, file);
}

// ----------------------------------------------------------------------------
// Manifest inference + hashing
// ----------------------------------------------------------------------------

interface PackageManager {
  /** Lockfile names, most specific first. */
  locks: string[];
  /** Setup command installing exactly what the lockfile pins. */
  install: string;
}

/** Detection order matters: the most specific package manager wins. */
const PACKAGE_MANAGERS: PackageManager[] = [
  { locks: ["pnpm-lock.yaml", "pnpm-lock.yml"], install: "pnpm install --frozen-lockfile" },
  { locks: ["yarn.lock"], install: "yarn install --frozen-lockfile" },
  { locks: ["bun.lockb", "bun.lock"], install: "bun install --frozen-lockfile" },
  { locks: ["package-lock.json", "npm-shrinkwrap.json"], install: "npm ci" },
];

/** Lockfile basenames that pin an install; they feed the build hash. */
const LOCK_NAMES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "pnpm-lock.yml", "yarn.lock", "bun.lockb", "bun.lock"];

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function isNodeProject(dir: string): boolean {
  if (fs.existsSync(path.join(dir, "node_modules"))) return true;
  return PACKAGE_MANAGERS.some((pm) => pm.locks.some((lock) => fs.existsSync(path.join(dir, lock))));
}

/** Nearest enclosing Node project of `dir` (never through node_modules). */
export function enclosingNodeProject(dir: string): string | undefined {
  let cursor = path.resolve(dir);
  for (;;) {
    if (isNodeProject(cursor)) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

/** Dependency names declared by a package.json (no versions; only names matter). */
function dependencyNames(projectDir: string): string[] {
  const manifest = readJson(path.join(projectDir, "package.json"));
  const names = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const) {
    const deps = manifest?.[field];
    if (!deps || typeof deps !== "object") continue;
    for (const name of Object.keys(deps as Record<string, unknown>)) names.add(name);
  }
  return sortEntries([...names], (n) => n);
}

/** Lockfiles under `dir` (depth-limited, never through node_modules). */
export function collectLocks(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, depth: number): void => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (NODE_IGNORES.has(entry.name)) continue;
        walk(path.join(current, entry.name), depth + 1);
      } else if (entry.isFile() && LOCK_NAMES.includes(entry.name)) {
        out.push(path.join(current, entry.name));
      }
    }
  };
  if (fs.existsSync(dir)) walk(path.resolve(dir), 0);
  return sortEntries(out, (p) => p);
}

/** Digest of a file's contents (or of its absence). Stable, never absolute. */
export function hashFile(absPath: string): string {
  if (!fs.existsSync(absPath)) return "absent";
  return crypto.createHash("sha256").update(fs.readFileSync(absPath)).digest("hex");
}

/**
 * Build hash = blueprint + the lockfiles/manifests the setup steps actually
 * consume. A changed lockfile invalidates the cache even when the blueprint
 * text did not move.
 */
export function blueprintHash(projectFolder: string, blueprint: EnvBlueprint): string {
  const locks = collectLocks(projectFolder);
  const parts: string[] = [JSON.stringify(blueprint), JSON.stringify(locks.map((p) => path.relative(projectFolder, p) || path.basename(p)))];
  for (const lock of locks) parts.push(`${path.basename(lock)}:${hashFile(lock).slice(0, 16)}`);
  // A missing node_modules proves no install ever ran, so the inferred install
  // step must be part of the hash. A mono-repo's node_modules sits at the package
  // root (which may be an ancestor of the project folder), so check there too.
  const nodeProject = enclosingNodeProject(projectFolder);
  const nodeModulesDir = path.join(nodeProject ?? projectFolder, "node_modules");
  parts.push(`node_modules:${fs.existsSync(nodeModulesDir) ? "present" : "absent"}`);
  return crypto.createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 32);
}

/** Every input that feeds the build hash, for the status payload (names only). */
export function blueprintHashInputs(projectFolder: string, blueprint: EnvBlueprint): string[] {
  const locks = collectLocks(projectFolder).map((p) => path.relative(projectFolder, p) || path.basename(p));
  return [BLUEPRINT_FILE, ...locks];
}

export interface EnvBlueprintInference {
  blueprint: EnvBlueprint;
  hash: string;
  hashInputs: string[];
  /** What the inference found, in human order (for the tool reply). */
  notes: string[];
}

/** Infer a blueprint from a project's manifest; refuses a missing folder. */
export function inferBlueprint(projectFolder: string, existing?: EnvBlueprint): EnvBlueprintInference {
  if (!projectFolder || !fs.existsSync(projectFolder) || !fs.statSync(projectFolder).isDirectory()) {
    throw new Error(`project folder is not a directory: ${projectFolder}`);
  }
  const notes: string[] = [];
  // Local mutable accumulators keep the possibly-undefined blueprint fields out
  // of the walk; `normalizeBlueprint` rebuilds the typed shape afterwards.
  const repos: EnvBlueprintRepo[] = [...(existing?.repos ?? [])];
  const setup: string[] = [...(existing?.setup ?? [])];
  const env: Record<string, string> = { ...(existing?.env ?? {}) };
  const secrets: string[] = [...(existing?.secrets ?? [])];
  const cache: string[] = [...(existing?.cache ?? [])];

  // Non-Node manifests first: their install steps are explicit and unambiguous.
  const walk = (dir: string, depth: number, prefix: string): void => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.name === "requirements.txt") setup.push(`python -m pip install -r ${rel}`);
      else if (entry.name === "Pipfile") setup.push("pipenv install --deploy");
      else if (entry.name === "pyproject.toml") setup.push("python -m pip install .");
      else if (entry.name === "Cargo.toml") setup.push("cargo fetch");
      else if (entry.name === "go.mod") setup.push("go mod download");
      else if (entry.name === "Gemfile") setup.push("bundle install");
      else if (entry.name === "composer.json") setup.push("composer install");
      else if (entry.name === "pom.xml") setup.push("mvn -q -DskipTests dependency:resolve");
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || NODE_IGNORES.has(entry.name)) continue;
      walk(path.join(dir, entry.name), depth + 1, prefix ? `${prefix}/${entry.name}` : entry.name);
    }
  };
  walk(path.resolve(projectFolder), 0, "");

  // Node install + cache, honouring the package manager the lockfile implies.
  const nodeProject = enclosingNodeProject(projectFolder);
  if (nodeProject) {
    const pm = PACKAGE_MANAGERS.find((candidate) => candidate.locks.some((lock) => fs.existsSync(path.join(nodeProject, lock))));
    const install = pm?.install ?? "npm install";
    const relProject = path.relative(path.resolve(projectFolder), nodeProject);
    const prefix = relProject && relProject !== "." ? `${relProject.replaceAll("\\", "/")}/` : "";
    setup.push(`${prefix}${install}`);
    if (!cache.includes("node_modules")) cache.push("node_modules");
    const deps = dependencyNames(nodeProject);
    const relLock = pm?.locks.find((lock) => fs.existsSync(path.join(nodeProject, lock)));
    notes.push(
      deps.length > 0
        ? `node: ${install}${relLock ? ` (${relLock})` : ""} · ${deps.length} dependency name(s): ${deps.join(", ")}`
        : `node: ${install} (no declared dependencies)`,
    );
  } else {
    notes.push("node: none (no package.json / lockfile found)");
  }

  const blueprint: EnvBlueprint = {
    repos: sortEntries([...new Set(repos)], (r) => r.path),
    setup: sortEntries([...new Set(setup)], (s) => s),
    env,
    secrets: sortEntries([...new Set(secrets)], (s) => s),
    cache: sortEntries([...new Set(cache)], (c) => c),
  };

  const inferred = normalizeBlueprint(blueprint);
  return {
    blueprint: inferred,
    hash: blueprintHash(projectFolder, inferred),
    hashInputs: blueprintHashInputs(projectFolder, inferred),
    notes,
  };
}

// ----------------------------------------------------------------------------
// Build status persistence
// ----------------------------------------------------------------------------

export function readBuildStatus(projectId: string): EnvBuildRecord | undefined {
  const file = envStatusPath(projectId);
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as EnvBuildRecord;
  } catch {
    return undefined;
  }
}

export function listBuildStatuses(): EnvBuildRecord[] {
  const root = envSnapshotsRoot();
  if (!fs.existsSync(root)) return [];
  const out: EnvBuildRecord[] = [];
  for (const project of fs.readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const status = readBuildStatus(project.name);
    if (status) out.push(status);
  }
  return out;
}

export function writeBuildStatus(record: EnvBuildRecord): void {
  const file = envStatusPath(record.projectId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 1), "utf8");
  fs.renameSync(tmp, file);
}

// ----------------------------------------------------------------------------
// Copy helpers
// ----------------------------------------------------------------------------

/** Copy `from` into `to`, reflinking whole files where the platform supports it. */
export function copyTree(from: string, to: string): void {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(from, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyTree(src, dst);
    } else if (entry.isSymbolicLink()) {
      // Links are recreated, never followed: a link cannot smuggle a copy out.
      try {
        const target = fs.readlinkSync(src);
        if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
        fs.symlinkSync(target, dst);
      } catch {
        /* unreadable link: skip rather than fail the whole clone */
      }
    } else if (entry.isFile()) {
      try {
        fs.copyFileSync(src, dst, fs.constants.COPYFILE_FICLONE_FORCE);
      } catch {
        fs.copyFileSync(src, dst);
      }
    }
  }
}

/** `git clone --local` (shares the object store); plain copy when unavailable. */
async function cloneProject(source: string, dest: string): Promise<void> {
  try {
    await execFileAsync("git", ["clone", "--quiet", source, dest], execOpts);
    return;
  } catch {
    /* fall through to a filesystem copy */
  }
  fs.rmSync(dest, { recursive: true, force: true });
  copyTree(source, dest);
}

// ----------------------------------------------------------------------------
// Build
// ----------------------------------------------------------------------------

/** Absolute cache roots of a project, resolved against its package root too. */
function cacheRoots(projectFolder: string, cache: string[]): Array<{ rel: string; abs: string }> {
  const root = path.resolve(projectFolder);
  const nodeProject = enclosingNodeProject(root);
  const out = new Map<string, string>();
  for (const entry of cache) {
    const normalized = entry.replaceAll("\\", "/").replace(/\/+$/, "");
    if (!normalized) continue;
    const abs = path.resolve(root, normalized);
    if (isInside(root, abs)) out.set(normalized, abs);
    if (nodeProject) {
      const nested = path.resolve(nodeProject, normalized);
      if (isInside(nodeProject, nested) && !isInside(root, nested)) out.set(normalized, nested);
    }
  }
  return [...out.entries()].map(([rel, abs]) => ({ rel, abs })).sort((a, b) => a.rel.localeCompare(b.rel));
}

export interface BuildOptions {
  /** Polled between steps so a cancelled run stops instead of hanging. */
  isCancelled?: () => boolean;
  /** Step progress sink (also how tests observe that steps ran). */
  onStep?: (command: string, index: number, total: number) => void;
  /** Real shell spawn hook (tests inject a deterministic fake). */
  spawn?: (command: string, cwd: string, env: NodeJS.ProcessEnv) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  /** Vault scope the blueprint's secret names resolve against (defaults to
   *  the run's agent scope, else the global vault). */
  scope?: string;
}

export interface BuildResult {
  ok: boolean;
  status: EnvBuildRecord;
  /** Absolute path of the materialized base snapshot. */
  snapshotDir: string;
}

async function runSetupStep(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  spawn?: BuildOptions["spawn"],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  if (spawn) return spawn(command, cwd, env);
  const { stdout, stderr } = await execFileAsync(command, { shell: true, cwd, env, ...execOpts });
  return { code: 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
}

function failedStatus(
  projectId: string,
  projectFolder: string,
  blueprint: EnvBlueprint,
  hash: string,
  lines: string[],
  secrets: string[],
  startedAt: number,
  message: string,
): EnvBuildRecord {
  return {
    projectId, projectFolder, hash, status: "failed", steps: blueprint.setup ?? [],
    log: redactVaultValues(`${lines.join("\n")}\n[failed] ${message}`, secrets).slice(-MAX_LOG),
    stepsRun: 0, durationMs: Date.now() - startedAt, createdAt: new Date().toISOString(), error: message,
  };
}

/**
 * Materialize the base snapshot for `blueprintHash(projectFolder, blueprint)`.
 *
 * Idempotent: a healthy snapshot of the same hash is reused and its setup steps
 * are skipped (`stepsRun: 0`). `force` rebuilds even when the hash is unchanged.
 */
export async function buildEnvSnapshot(
  projectId: string,
  projectFolder: string,
  blueprintInput: unknown,
  cfg: Config,
  opts: BuildOptions = {},
): Promise<BuildResult> {
  // Normalize once: callers (the tool, tests, a future CLI) all pass hand-written
  // shapes, and the normalized blueprint guarantees the arrays below exist.
  const blueprint = normalizeBlueprint(blueprintInput);
  const steps = blueprint.setup ?? [];
  const setupEnv = blueprint.env ?? {};
  const secretNames = blueprint.secrets ?? [];
  const cacheEntries = blueprint.cache ?? [];
  const repos = blueprint.repos ?? [];
  const hash = blueprintHash(projectFolder, blueprint);
  const dir = envSnapshotDir(projectId, hash);
  const marker = path.join(dir, "BLUEPRINT.json");
  const startedAt = Date.now();
  const lines: string[] = [`env-build ${hash}`, `project: ${projectFolder}`, `blueprint: ${JSON.stringify(blueprint)}`];
  const secrets: string[] = [];

  // Reuse: the marker plus a recorded `built` status of the same hash.
  const recorded = readBuildStatus(projectId);
  if (!opts.isCancelled?.() && fs.existsSync(marker) && fs.existsSync(path.join(dir, "project")) && recorded?.hash === hash && recorded.status === "built") {
    const reused: EnvBuildRecord = {
      ...recorded, projectFolder, status: "built", stepsRun: 0, steps,
      log: `${recorded.log}\n[reused existing snapshot ${hash}]`.slice(-MAX_LOG),
    };
    writeBuildStatus(reused);
    return { ok: true, status: reused, snapshotDir: dir };
  }

  // Vault refs in `env`/`setup` are resolved into the child environment only.
  // A ref with no stored value is an explicit failure, never an inline leak.
  let envPlan;
  try {
    const scope = opts.scope ?? vaultScope({ cfg, workspace: projectFolder } as ToolContext);
    envPlan = planVaultEnv([...Object.values(setupEnv), ...steps], scope);
    // `secrets` names are resolved the same way: the value goes to the child
    // env as LOAM_VAULT_<NAME> and is registered for redaction, never inlined.
    for (const name of secretNames) {
      const named = planVaultEnv([vaultRef(name)], scope);
      Object.assign(envPlan.env, named.env);
      for (const value of named.secrets) if (!envPlan.secrets.includes(value)) envPlan.secrets.push(value);
      envPlan.values[name] = named.values[name] ?? "";
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = failedStatus(projectId, projectFolder, blueprint, hash, lines, secrets, startedAt, message);
    writeBuildStatus(status);
    return { ok: false, status, snapshotDir: dir };
  }
  secrets.push(...envPlan.secrets);

  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    // 1. The project checkout.
    const projectDest = path.join(dir, "project");
    await cloneProject(path.resolve(projectFolder), projectDest);
    // Same exclusions as the task-worktree clone: `.git`/per-task state never
    // ships, and a stale `node_modules` would make `blueprintHash` believe the
    // install had already run and skip the setup steps.
    pruneCloneTarget(projectDest);

    // 2. Extra repos declared by the blueprint, always inside the snapshot dir.
    for (const repo of repos) {
      if (opts.isCancelled?.()) throw new Error("cancelled");
      const source = path.resolve(projectFolder, repo.path);
      if (!fs.existsSync(source)) {
        lines.push(`[clone] skipped (missing): ${repo.path}`);
        continue;
      }
      const dest = path.join(dir, "repos", repoRelDest(repo.path));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await cloneProject(source, dest);
      const checkout = repo.ref?.trim();
      if (checkout) {
        await execFileAsync("git", ["-C", dest, "checkout", "--quiet", checkout], execOpts);
        const subdir = repo.subdir?.trim();
        if (subdir) {
          const nested = path.join(dest, subdir);
          if (!fs.existsSync(nested) || !isInside(dest, nested)) throw new Error(`repos[].subdir is outside the repo: ${repo.subdir}`);
          copyTree(nested, dest);
        }
      }
    }

    // 3. Setup steps, once per build, in the project checkout.
    const stepEnv: NodeJS.ProcessEnv = { ...process.env, ...setupEnv, ...envPlan.env };
    for (const [index, raw] of steps.entries()) {
      if (opts.isCancelled?.()) throw new Error("cancelled");
      const command = raw.replace(/\r?\n/g, " ").trim();
      if (!command) continue;
      opts.onStep?.(command, index, steps.length);
      const check = checkCommand(cfg, command);
      if (!check.ok) throw new Error(`setup step blocked by policy: ${check.reason ?? "denied"} → ${command}`);
      lines.push(`$ ${command}`);
      const result = await runSetupStep(envPlan.rewrite(command), projectDest, stepEnv, opts.spawn);
      const stdout = redactVaultValues(String(result.stdout ?? ""), secrets);
      const stderr = redactVaultValues(String(result.stderr ?? ""), secrets);
      if (stdout.trim()) lines.push(stdout.trim());
      if (stderr.trim()) lines.push(stderr.trim());
      if (result.code !== 0) throw new Error(`setup step failed (exit=${result.code ?? "null"}): ${command}`);
    }

    // 4. Cache roots that live outside the project checkout (a mono-repo's
    //    package root) are materialized under cache/ so the clone is complete.
    for (const { rel, abs } of cacheRoots(projectFolder, cacheEntries)) {
      if (isInside(projectDest, abs) || !fs.existsSync(abs)) continue;
      copyTree(abs, path.join(dir, "cache", rel));
    }

    fs.writeFileSync(marker, JSON.stringify({ projectId, hash, blueprint }, null, 1), "utf8");
    const status: EnvBuildRecord = {
      projectId, projectFolder, hash, status: "built", steps,
      log: redactVaultValues(lines.join("\n"), secrets).slice(-MAX_LOG),
      stepsRun: steps.length, durationMs: Date.now() - startedAt, createdAt: new Date().toISOString(),
    };
    writeBuildStatus(status);
    log.info(`env-build: built ${envBuildId(projectId, hash)} (${status.stepsRun} step(s))`);
    return { ok: true, status, snapshotDir: dir };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const cancelled = message === "cancelled" || opts.isCancelled?.() === true;
    const status = failedStatus(projectId, projectFolder, blueprint, hash, lines, secrets, startedAt, cancelled ? "cancelled" : message);
    writeBuildStatus(status);
    log.warn(`env-build: ${envBuildId(projectId, hash)} failed: ${message}`);
    return { ok: false, status, snapshotDir: dir };
  }
}

function repoRelDest(repoPath: string): string {
  const base = path.basename(path.resolve(repoPath).replaceAll("\\", "/").replace(/\/+$/, ""));
  return base || "repo";
}

// ----------------------------------------------------------------------------
// Snapshot → task worktree
// ----------------------------------------------------------------------------

/** Paths (relative to the project root) that never join a snapshot clone. */
/**
 * Paths (relative to the project root) that never join a snapshot clone.
 *
 * `node_modules` is excluded too: it is the product of the install steps below,
 * so a stale copy from the project checkout would make `blueprintHash` think the
 * install had already run (its `node_modules:present` input) and skip the steps.
 * The install recreates it from the lockfile instead.
 */
const EXCLUDED_CLONE_ENTRIES = new Set([".git", "node_modules", ".loam-tasks", "deliverables", ".screenshots"]);

/** Remove per-task state a previous boot may have left in the clone target. */
function pruneCloneTarget(dest: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dest, { encoding: "utf8", withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (EXCLUDED_CLONE_ENTRIES.has(entry.name)) fs.rmSync(path.join(dest, entry.name), { recursive: true, force: true });
  }
}

/**
 * Clone the cached base snapshot into a task worktree. Returns the absolute
 * project path inside the task workspace; the caller owns that directory.
 */
export function cloneEnvSnapshot(
  projectId: string,
  hash: string,
  taskWorkspace: string,
  blueprint: EnvBlueprint,
): { ok: true; projectDir: string; reused: boolean } | { ok: false; error: string } {
  const snapshotDir = envSnapshotDir(projectId, hash);
  const base = path.join(snapshotDir, "project");
  if (!fs.existsSync(path.join(snapshotDir, "BLUEPRINT.json")) || !fs.existsSync(base)) {
    return { ok: false, error: `no built snapshot for ${envBuildId(projectId, hash)} — run env_build_status with build=` };
  }
  const dest = path.join(taskWorkspace, "project");
  try {
    if (fs.existsSync(dest)) pruneCloneTarget(dest);
    copyTree(base, dest);
    // Cache roots materialized outside the project checkout (mono-repo roots).
    const cacheDir = path.join(snapshotDir, "cache");
    for (const { rel } of cacheRoots(base, blueprint.cache ?? [])) {
      const source = path.join(cacheDir, rel);
      if (fs.existsSync(source)) copyTree(source, path.join(dest, rel));
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, projectDir: dest, reused: true };
}

// ----------------------------------------------------------------------------
// Tools
// ----------------------------------------------------------------------------

/** `<projectId>/<hash>` or a bare hash; both resolve to a build status. */
export function resolveBuildQuery(projectId: string, input?: string): { projectId: string; hash: string } {
  const raw = (input ?? "").trim();
  if (!raw) throw new Error("build id must look like <projectId>/<hash>");
  const slash = raw.lastIndexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return { projectId, hash: sanitizeSegment(slash < 0 ? raw : raw.slice(0, slash)) };
  const prefix = sanitizeSegment(raw.slice(0, slash));
  return { projectId: prefix === projectId ? projectId : prefix, hash: sanitizeSegment(raw.slice(slash + 1)) };
}

/** Status renderer shared by the tool and the HTTP route. */
export function renderStatus(record: EnvBuildRecord | undefined, snapshotDir?: string): string {
  if (!record) return "(no environment build for this project)";
  const parts = [
    `build ${envBuildId(record.projectId, record.hash)}`,
    `status: ${record.status}`,
    `steps: ${record.stepsRun}${record.error ? ` (${record.error})` : ""}`,
    `duration: ${record.durationMs}ms`,
    `built: ${record.createdAt}`,
  ];
  if (snapshotDir) parts.push(`snapshot: ${snapshotDir}`);
  if (record.log.trim()) parts.push(`log:\n${record.log}`);
  return parts.join("\n");
}

/**
 * Resolve a `projectDir` argument against the workspace; a segment-aware check
 * (like `resolveScaffoldDir`) so `..` can never escape the task workspace.
 */
export function resolveProjectDir(workspace: string, projectDir: string): string {
  const normalized = projectDir.trim().replaceAll("\\", "/");
  if (normalized !== "" && path.isAbsolute(normalized)) {
    throw new Error("projectDir must be a relative path inside the workspace");
  }
  const segments = normalized.split("/");
  if (normalized.startsWith("/") || segments.some((part) => part === "..")) {
    throw new Error("projectDir must not contain '..' or drive/UNC references");
  }
  const resolved = path.resolve(workspace, normalized);
  if (resolved !== workspace && !resolved.startsWith(workspace + path.sep)) {
    throw new Error("projectDir must resolve inside the workspace");
  }
  return resolved;
}

export function createEnvSnapshotTools(): Tool[] {
  return [
    {
      name: "env_blueprint_generate",
      description:
        `Generate (or refresh) the project's ${BLUEPRINT_FILE} environment blueprint from its manifest: the detected package manager's install command, extra repositories to clone, plain env vars, vault secret NAMES and the cache directories copied into each task worktree. Hand-written entries are preserved and the file is rewritten only when the inferred content changed. Secret values are never written — only names.`,
      parameters: {
        type: "object",
        properties: {
          projectDir: { type: "string", description: "Relative subdirectory of the workspace holding the project (default: workspace root)" },
          writeFile: { type: "boolean", description: "Write loam.env.yaml into the project (default: true)" },
        },
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        let dir: string;
        try {
          dir = resolveProjectDir(ctx.workspace, str(args, "projectDir", "."));
        } catch (err) {
          return { ok: false, content: `env_blueprint_generate refused: ${err instanceof Error ? err.message : String(err)}` };
        }
        try {
          const inferred = inferBlueprint(dir, readBlueprint(dir));
          if (bool(args, "writeFile", true)) writeBlueprint(dir, inferred.blueprint);
          const preview = dumpYaml(inferred.blueprint, { lineWidth: 0 }).trim();
          return {
            ok: true,
            content: [
              `${BLUEPRINT_FILE} for ${dir}`,
              `hash: ${inferred.hash}`,
              `hash inputs: ${inferred.hashInputs.join(", ")}`,
              bool(args, "writeFile", true) ? `written: ${envBlueprintPath(dir)}` : "(not written — writeFile=false)",
              preview ? `blueprint:\n${preview}` : "blueprint: (empty)",
              inferred.notes.length > 0 ? `inferred: ${inferred.notes.join(" | ")}` : "",
            ].filter(Boolean).join("\n"),
          };
        } catch (err) {
          return { ok: false, content: `env_blueprint_generate failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      name: "env_build_status",
      description:
        `Report this project's environment build state: blueprint hash, cached snapshot path, build status and the redacted build log. Pass build=<projectId>/<hash> to (re)build that snapshot — the setup steps run once and an unchanged hash reuses the cached snapshot — or writeBlueprint=<projectId>/<hash> to copy another project's built snapshot into this project's env cache. Secret values never appear in the log or the reply.`,
      parameters: {
        type: "object",
        properties: {
          build: { type: "string", description: 'Build id "<projectId>/<hash>"; omit to only report the current status' },
          writeBlueprint: { type: "string", description: "Build id whose built snapshot is copied into this project's env cache" },
          projectDir: { type: "string", description: "Relative subdirectory of the workspace holding the project (default: workspace root)" },
        },
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        let dir: string;
        try {
          dir = resolveProjectDir(ctx.workspace, str(args, "projectDir", "."));
        } catch (err) {
          return { ok: false, content: `env_build_status refused: ${err instanceof Error ? err.message : String(err)}` };
        }
        const buildArg = str(args, "build");
        const writeArg = str(args, "writeBlueprint");
        const projectId = path.basename(path.resolve(dir));
        try {
          const blueprint = readBlueprint(dir);

          if (buildArg) {
            const target = resolveBuildQuery(projectId, buildArg);
            if (target.projectId !== projectId) {
              const other = readBuildStatus(target.projectId);
              return { ok: true, content: `build ${envBuildId(target.projectId, target.hash)}: ${other ? renderStatus(other) : "no build recorded"}` };
            }
            const result = await buildEnvSnapshot(projectId, dir, blueprint, ctx.cfg, {
              isCancelled: () => ctx.signal?.aborted === true,
              scope: vaultScope(ctx),
            });
            return { ok: true, content: renderStatus(result.status, envSnapshotDir(projectId, result.status.hash)) };
          }

          if (writeArg) {
            const target = resolveBuildQuery(projectId, writeArg);
            const record = readBuildStatus(target.projectId);
            if (!record || record.hash !== target.hash) {
              return { ok: false, content: `env_build_status: no built snapshot for ${envBuildId(target.projectId, target.hash)}` };
            }
            const targetDir = envSnapshotDir(projectId, target.hash);
            fs.rmSync(targetDir, { recursive: true, force: true });
            copyTree(envSnapshotDir(target.projectId, target.hash), targetDir);
            return { ok: true, content: `wrote snapshot ${envBuildId(target.projectId, target.hash)} → ${targetDir}` };
          }

          const status = readBuildStatus(projectId);
          const hash = blueprintHash(dir, blueprint);
          if (status && status.hash !== hash) {
            return {
              ok: true,
              content: `${renderStatus(status)}\ncurrent hash: ${hash} (blueprint changed — the cached snapshot is stale)`,
            };
          }
          return { ok: true, content: renderStatus(status, envSnapshotDir(projectId, status?.hash ?? hash)) };
        } catch (err) {
          return { ok: false, content: `env_build_status failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
  ];
}

// ----------------------------------------------------------------------------
// Task boot hook
// ----------------------------------------------------------------------------

export interface TaskEnvBootInput {
  /** Task workspace root (created by ensureTaskWorkspace). */
  taskWorkspace: string;
  /** Project id (db project id, else the project folder basename). */
  projectId: string;
  /** Project folder carrying loam.env.yaml. */
  projectFolder: string;
}

/**
 * Boot a task worktree from the cached base snapshot when one exists and its
 * hash matches the current blueprint. A mismatch (or no snapshot) is a no-op:
 * the task simply starts from an empty worktree, exactly as before.
 *
 * Never throws: environment reuse is an optimization, not a task requirement.
 */
export function bootTaskFromSnapshot(input: TaskEnvBootInput): { ok: boolean; projectDir?: string; hash?: string; reason: string } {
  try {
    const blueprint = readBlueprint(input.projectFolder);
    const hash = blueprintHash(input.projectFolder, blueprint);
    const status = readBuildStatus(input.projectId);
    if (!status || status.hash !== hash || status.status !== "built") {
      return { ok: false, reason: `no snapshot for hash ${hash}` };
    }
    const cloned = cloneEnvSnapshot(input.projectId, hash, input.taskWorkspace, blueprint);
    if (!cloned.ok) return { ok: false, reason: cloned.error };
    return { ok: true, projectDir: cloned.projectDir, hash, reason: `reused snapshot ${hash}` };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
