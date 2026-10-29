import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PROVIDER_TOKEN_ENV, deployStaticTo, type CloudTarget, type StaticDeployOutcome } from "./staticDeploy.js";
import { collectFiles, zipBuffer, type ZipEntry } from "./zip.js";

/**
 * One-click deploy + export for built apps.
 *
 * A "built app" is the static build output inside the task workspace
 * (dist/, build/, out/, www/ or a workspace root with index.html) — the
 * same folders `preview_serve` can serve locally.
 *
 * Export  = zip the build output into the task workspace so it can ship anywhere.
 * Deploy  = copy/package the same output through a pluggable DeployTarget.
 *   - LOCAL target (always available): writes to a dist dir, returns a local URL.
 *   - Vercel/Netlify: REAL static deploys through the shared core in
 *     ./staticDeploy.ts when VERCEL_TOKEN / NETLIFY_AUTH_TOKEN is present;
 *     an honest "not enabled" report when it is not. UIs that call their own
 *     server API are refused — static-only stays the rule (G14).
 */

export interface BuildOutput {
  /** Absolute directory containing the build output (static host contents). */
  dir: string;
  /** Path relative to the task workspace. */
  relative: string;
  fileCount: number;
}

const BUILD_DIR_CANDIDATES = ["dist", "build", "out", "www"];

/** Locate the build output under a task workspace (deterministic scan order). */
export function resolveBuildOutput(root: string): BuildOutput | null {
  const base = path.resolve(root);
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return null;
  for (const candidate of BUILD_DIR_CANDIDATES) {
    const dir = path.join(base, candidate);
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory() && hasAnyFile(dir)) {
      return { dir, relative: candidate, fileCount: countFiles(dir) };
    }
  }
  const rootIndex = path.join(base, "index.html");
  if (fs.existsSync(rootIndex) && fs.statSync(rootIndex).isFile()) {
    // The workspace root doubles as the build output; exclude `.loam` staging
    // (exports/deploy copies) so the reported file count reflects real assets.
    return { dir: base, relative: ".", fileCount: countFiles(base, true) };
  }
  return null;
}

function hasAnyFile(dir: string): boolean {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    if (item.isFile()) return true;
    if (item.isDirectory() && countFiles(path.join(dir, item.name)) > 0) return true;
  }
  return false;
}

function countFiles(dir: string, skipRootLoam = false): number {
  let count = 0;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    if (skipRootLoam && item.name === ".loam") continue;
    if (item.isFile()) count += 1;
    else if (item.isDirectory()) count += countFiles(path.join(dir, item.name), false);
  }
  return count;
}

function buildEntries(dir: string): ZipEntry[] {
  return collectFiles(dir, {
    filter: (rel) => !rel.split("/").some((part) => part.startsWith(".loam")),
  });
}

export interface ExportResult {
  zipPath: string;
  bytes: number;
  fileCount: number;
  buildDir: string;
}

/** Zip the task's build output into `<root>/.loam/exports/deploy-<id>-<stamp>.zip`. */
export function exportBuild(root: string, taskId: string): ExportResult {
  const out = resolveBuildOutput(root);
  if (!out) {
    throw new Error("no build output found (expected dist/, build/, out/, www/ or index.html in the task workspace)");
  }
  const exportsDir = taskStagingDir(root);
  fs.mkdirSync(exportsDir, { recursive: true });
  const zipPath = uniqueArchivePath(exportsDir, `deploy-${safeSegment(taskId)}`, ".zip");
  const zip = zipBuffer(buildEntries(out.dir));
  fs.writeFileSync(zipPath, zip);
  return { zipPath, bytes: zip.length, fileCount: out.fileCount, buildDir: out.dir };
}

/**
 * Archive path that never collides: `timestampSegment()` is millisecond
 * precision, so two exports/deploys in the same millisecond would otherwise
 * overwrite each other. The first free candidate is returned.
 */
function uniqueArchivePath(dir: string, base: string, ext: string): string {
  return withCollisionSuffix(path.join(dir, `${base}-${timestampSegment()}${ext}`));
}

/** Staging directories live under `.loam` and are always excluded from packaged builds. */
function taskStagingDir(root: string, segment = "exports"): string {
  return path.join(root, ".loam", segment);
}

/** Hook that turns a deployed directory into a browsable local URL (the preview service). */
export type DistServe = (dir: string) => Promise<string>;

export interface DeployInput {
  buildDir: string;
  taskId: string;
}

export interface DeployResult {
  ok: boolean;
  /** URL the build output can be reached at (local URL for the local target). */
  url: string | null;
  target: string;
  buildDir: string;
  /** Where the deployable copy landed (local target). */
  distDir?: string;
  /** Zip produced for this deploy attempt. */
  zipPath?: string;
  bytes?: number;
  files?: number;
  /** Environment variables still required by cloud targets. */
  missingEnv?: string[];
  message: string;
}

export interface DeployTarget {
  id: string;
  label: string;
  /** local targets run offline; cloud targets are gated on credentials. */
  kind: "local" | "cloud";
  /** Environment variable names this target needs before a real deployment. */
  requiredEnv: readonly string[];
  describe(): string;
  deploy(input: DeployInput): Promise<DeployResult>;
}

export interface DistWriter {
  /** Copy the build directory contents into a fresh destination directory. */
  write(dir: string, destDir: string): void;
}

/** Default dist writer: copy regular files recursively; symlinks are skipped. */
export const directDistWriter: DistWriter = {
  write(dir: string, destDir: string): void {
    copyTree(dir, destDir);
  },
};

function copyTree(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const item of fs.readdirSync(src, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    const next = path.join(src, item.name);
    const target = path.join(dest, item.name);
    if (item.isDirectory()) copyTree(next, target);
    else if (item.isFile()) fs.copyFileSync(next, target);
  }
}

export interface LocalDeployTargetOptions {
  /** Absolute base directory for the deployed dist copies. */
  distRoot: string;
  /** Optional serve hook that should return a browsable local URL for a dist dir. */
  serve?: DistServe;
  /** Optional replacement writer (tests). */
  writer?: DistWriter;
}

/**
 * Deterministic dist layout: `<distRoot>/<taskId>/<stamp>` — a fresh timestamped
 * copy per deploy, so history is preserved without symlinks.
 */
export function localDistDir(distRoot: string, taskId: string): string {
  return path.join(distRoot, safeSegment(taskId), timestampSegment());
}

/**
 * Append the first free `-N` suffix to `base` so a same-millisecond collision
 * never overwrites an existing copy. Pure given the filesystem state.
 */
export function withCollisionSuffix(base: string): string {
  if (!fs.existsSync(base)) return base;
  let n = 1;
  let candidate = `${base}-${n}`;
  while (fs.existsSync(candidate)) {
    n += 1;
    candidate = `${base}-${n}`;
  }
  return candidate;
}

/**
 * Collision-free variant of {@link localDistDir}: keeps every deploy's copy on
 * disk even when two deploys land in the same millisecond (history preserved).
 */
export function uniqueLocalDistDir(distRoot: string, taskId: string): string {
  return withCollisionSuffix(localDistDir(distRoot, taskId));
}

/**
 * The always-available local/mock target: writes the build output into a dist
 * directory and returns a local URL (via the serve hook, else file://). Nothing
 * leaves the machine.
 */
export function createLocalDeployTarget(opts: LocalDeployTargetOptions): DeployTarget {
  const writer = opts.writer ?? directDistWriter;
  return {
    id: "local",
    label: "Local dist",
    kind: "local",
    requiredEnv: [],
    describe(): string {
      return "نشر محلي: ينسخ مخرجات البناء إلى مجلد dist ويعيد رابطًا محليًا.";
    },
    async deploy(input: DeployInput): Promise<DeployResult> {
      const distDir = uniqueLocalDistDir(opts.distRoot, input.taskId);
      const tmpDir = `${distDir}.deploying`;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      // Stage the full copy first; only swap it into place once the write has
      // fully succeeded so a failed deploy never destroys the previous copy.
      writer.write(input.buildDir, tmpDir);
      fs.rmSync(distDir, { recursive: true, force: true });
      fs.renameSync(tmpDir, distDir);
      const files = collectFiles(distDir);
      const zip = zipBuffer(buildEntries(input.buildDir));
      const zipPath = uniqueArchivePath(path.dirname(distDir), "local", ".zip");
      fs.writeFileSync(zipPath, zip);

      let url: string | null;
      if (opts.serve) {
        url = await opts.serve(distDir);
      } else {
        const indexPath = path.resolve(distDir, "index.html");
        url = pathToFileURL(fs.existsSync(indexPath) ? indexPath : distDir).toString();
      }
      return {
        ok: true,
        url,
        target: "local",
        buildDir: input.buildDir,
        distDir,
        zipPath,
        bytes: zip.length,
        files: files.length,
        message: opts.serve
          ? `انتشر محليًا إلى ${distDir} (${files.length} ملفًا) وتُعرض الآن في ${url}`
          : `انتشر محليًا إلى ${distDir} (${files.length} ملفًا). افتح index.html من: ${url}`,
      };
    },
  };
}

/** Safe path segment from ids. */
export function safeSegment(value: string): string {
  return /^[\w-]+$/.test(value) ? value : "task";
}

/** Archive-path-safe timestamp (year..millisecond) so rapid deploys never collide. */
export function timestampSegment(date = new Date()): string {
  return date.toISOString().replace(/\D/g, "").slice(0, 17);
}

/** Environment variable names from this list that are not set yet. */
export function missingCredentials(requiredEnv: readonly string[]): string[] {
  return requiredEnv.filter((name) => !process.env[name]);
}

export interface DeployOutcome {
  target: DeployTarget;
  build: BuildOutput | null;
  result: DeployResult;
}

/** Running a deployment against a task workspace. Throws when nothing is built. */
export async function deployBuild(root: string, taskId: string, target: DeployTarget): Promise<DeployOutcome> {
  const build = resolveBuildOutput(root);
  if (target.kind === "cloud") {
    const missing = missingCredentials(target.requiredEnv);
    if (missing.length > 0) {
      return {
        target,
        build,
        result: {
          ok: false,
          url: null,
          target: target.id,
          buildDir: build?.dir ?? "",
          files: build?.fileCount,
          missingEnv: missing,
          message: `لم يُنفّذ نشر ${target.label}: متغيرات البيئة التالية مفقودة: ${missing.join(", ")}`,
        },
      };
    }
  }
  if (!build) {
    throw new Error("no build output found (expected dist/, build/, out/, www/ or index.html in the task workspace)");
  }
  const result = await target.deploy({ buildDir: build.dir, taskId });
  return { target, build, result };
}

/* ---- Cloud targets: real static deploys via the shared core when the
 * provider token is present; an honest "not enabled" report otherwise. ---- */

export interface CloudDeployTargetOptions {
  /** Token override (tests / explicit callers); defaults to the provider's env token. */
  token?: string;
  /** Project name override; defaults to `loam-<taskId>`. */
  projectName?: string;
  /** Vercel-only: publish to production instead of a preview deployment. Default false. */
  production?: boolean;
  /** Netlify-only: existing site id override; defaults to NETLIFY_SITE_ID when set. */
  siteId?: string;
  /** Vercel-only: team scope override; defaults to VERCEL_TEAM_ID when set. */
  teamId?: string;
  /** Test hooks: inject fetch/sleep and shorten the polling deadline. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  pollTimeoutMs?: number;
}

/** Maps a shared-core outcome to the DeployResult shape the tool/route layer reports. */
function toDeployResult(id: string, input: DeployInput, outcome: StaticDeployOutcome): DeployResult {
  return {
    ok: outcome.ok,
    url: outcome.url,
    target: id,
    buildDir: input.buildDir,
    bytes: outcome.bytes,
    files: outcome.files,
    missingEnv: [],
    message: outcome.message,
  };
}

/** The provider token: explicit override first, then the documented env variable. */
function cloudToken(provider: CloudTarget, opts: CloudDeployTargetOptions): string | undefined {
  return opts.token ?? process.env[PROVIDER_TOKEN_ENV[provider]];
}

/** The honest result cloud targets return (and deployBuild pre-computes) when no token is configured. */
function notEnabledResult(id: string, input: DeployInput, tokenEnv: string): DeployResult {
  return {
    ok: false,
    url: null,
    target: id,
    buildDir: input.buildDir,
    missingEnv: [tokenEnv],
    message: `نشر ${id} غير مفعّل: لم يُنفّذ أي شيء لأن ${tokenEnv} غير متوفر في البيئة؛ أضِفه لتمكين النشر الفعلي، أو استخدم الهدف المحلي أو التصدير.`,
  };
}

export function createVercelDeployTarget(opts: CloudDeployTargetOptions = {}): DeployTarget {
  const tokenEnv = PROVIDER_TOKEN_ENV.vercel;
  return {
    id: "vercel",
    label: "Vercel",
    kind: "cloud",
    requiredEnv: [tokenEnv],
    describe(): string {
      return cloudToken("vercel", opts)
        ? `نشر Vercel فعلي للمخرجات الثابتة (ملفات inline عبر POST /v13/deployments)؛ مفعّل لأن ${tokenEnv} متوفر في البيئة.`
        : `هدف Vercel غير مفعّل: النشر الفعلي يتطلب ${tokenEnv} في البيئة؛ استخدم الهدف المحلي أو التصدير حتى يتوفر.`;
    },
    async deploy(input: DeployInput): Promise<DeployResult> {
      const token = cloudToken("vercel", opts);
      if (!token) return notEnabledResult("vercel", input, tokenEnv);
      const teamId = opts.teamId ?? process.env.VERCEL_TEAM_ID;
      const outcome = await deployStaticTo("vercel", input.buildDir, {
        token,
        name: opts.projectName ?? `loam-${safeSegment(input.taskId)}`,
        production: opts.production === true,
        ...(teamId ? { teamId } : {}),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts.sleep ? { sleep: opts.sleep } : {}),
        ...(opts.pollTimeoutMs !== undefined ? { pollTimeoutMs: opts.pollTimeoutMs } : {}),
      });
      return toDeployResult("vercel", input, outcome);
    },
  } satisfies DeployTarget;
}

export function createNetlifyDeployTarget(opts: CloudDeployTargetOptions = {}): DeployTarget {
  const tokenEnv = PROVIDER_TOKEN_ENV.netlify;
  return {
    id: "netlify",
    label: "Netlify",
    kind: "cloud",
    requiredEnv: [tokenEnv],
    describe(): string {
      return cloudToken("netlify", opts)
        ? `نشر Netlify فعلي للمخرجات الثابتة (موقع جديد أو NETLIFY_SITE_ID، ثم رفع ZIP)؛ مفعّل لأن ${tokenEnv} متوفر في البيئة.`
        : `هدف Netlify غير مفعّل: النشر الفعلي يتطلب ${tokenEnv} في البيئة (و NETLIFY_SITE_ID اختياريًا)؛ استخدم الهدف المحلي أو التصدير حتى يتوفر.`;
    },
    async deploy(input: DeployInput): Promise<DeployResult> {
      const token = cloudToken("netlify", opts);
      if (!token) return notEnabledResult("netlify", input, tokenEnv);
      const siteId = opts.siteId ?? process.env.NETLIFY_SITE_ID;
      const outcome = await deployStaticTo("netlify", input.buildDir, {
        token,
        name: opts.projectName ?? `loam-${safeSegment(input.taskId)}`,
        ...(siteId ? { siteId } : {}),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts.sleep ? { sleep: opts.sleep } : {}),
        ...(opts.pollTimeoutMs !== undefined ? { pollTimeoutMs: opts.pollTimeoutMs } : {}),
      });
      return toDeployResult("netlify", input, outcome);
    },
  } satisfies DeployTarget;
}

/** Full target catalog including the local target (whose dist root is caller-provided). */
export function targetCatalog(local: DeployTarget): DeployTarget[] {
  return [local, createVercelDeployTarget(), createNetlifyDeployTarget()];
}

export function findTarget(catalog: readonly DeployTarget[], id: string): DeployTarget | undefined {
  return catalog.find((t) => t.id === id);
}
