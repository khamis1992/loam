import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
 *   - Vercel/Netlify: honest stubs reporting which env credentials they need.
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
    return { dir: base, relative: ".", fileCount: countFiles(base) };
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

function countFiles(dir: string): number {
  let count = 0;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    if (item.isFile()) count += 1;
    else if (item.isDirectory()) count += countFiles(path.join(dir, item.name));
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
  const zipPath = path.join(exportsDir, `deploy-${safeSegment(taskId)}-${timestampSegment()}.zip`);
  const zip = zipBuffer(buildEntries(out.dir));
  fs.writeFileSync(zipPath, zip);
  return { zipPath, bytes: zip.length, fileCount: out.fileCount, buildDir: out.dir };
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
      const distDir = localDistDir(opts.distRoot, input.taskId);
      const tmpDir = `${distDir}.deploying`;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(distDir, { recursive: true, force: true });
      writer.write(input.buildDir, tmpDir);
      fs.renameSync(tmpDir, distDir);
      const files = collectFiles(distDir);
      const zip = zipBuffer(buildEntries(input.buildDir));
      const zipPath = path.join(path.dirname(distDir), `local-${timestampSegment()}.zip`);
      fs.writeFileSync(zipPath, zip);

      let url: string | null;
      if (opts.serve) {
        url = await opts.serve(distDir);
      } else {
        url = pathToFileURL(path.resolve(distDir, "index.html")).toString();
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
  if (target.kind === "cloud") {
    // Credentials are present, but real cloud publishing is not wired yet.
    return {
      target,
      build,
      result: {
        ok: false,
        url: null,
        target: target.id,
        buildDir: build.dir,
        files: build.fileCount,
        missingEnv: [],
        message: `تم العثور على بيانات اعتماد ${target.label} لكن النشر السحابي الفعلي غير مفعّل في هذا الإصدار؛ استخدم الهدف المحلي أو التصدير.`,
      },
    };
  }
  const result = await target.deploy({ buildDir: build.dir, taskId });
  return { target, build, result };
}

/* ---- Cloud stubs: they only report required credentials. ---- */

export function createVercelDeployTarget(): DeployTarget {
  const base = { id: "vercel", label: "Vercel (stub)", kind: "cloud" as const, requiredEnv: ["VERCEL_TOKEN"] as const };
  return {
    ...base,
    describe(): string {
      return "هدف سحابي محفّظ: لا ينفّذ شيئًا حتى يتوفر VERCEL_TOKEN في البيئة.";
    },
    async deploy(input: DeployInput): Promise<DeployResult> {
      return {
        ok: false,
        url: null,
        target: base.id,
        buildDir: input.buildDir,
        missingEnv: missingCredentials(base.requiredEnv),
        message: `نشر Vercel غير مفعّل (stub): لا ينفّذ شيئًا حتى يتوفر VERCEL_TOKEN في البيئة.`,
      };
    },
  } satisfies DeployTarget;
}

export function createNetlifyDeployTarget(): DeployTarget {
  const base = { id: "netlify", label: "Netlify (stub)", kind: "cloud" as const, requiredEnv: ["NETLIFY_AUTH_TOKEN"] as const };
  return {
    ...base,
    describe(): string {
      return "هدف سحابي محفّظ: لا ينفّذ شيئًا حتى يتوفر NETLIFY_AUTH_TOKEN (و NETLIFY_SITE_ID اختياريًا) في البيئة.";
    },
    async deploy(input: DeployInput): Promise<DeployResult> {
      return {
        ok: false,
        url: null,
        target: base.id,
        buildDir: input.buildDir,
        missingEnv: missingCredentials(base.requiredEnv),
        message: `نشر Netlify غير مفعّل (stub): لا ينفّذ شيئًا حتى يتوفر NETLIFY_AUTH_TOKEN (و NETLIFY_SITE_ID اختياريًا) في البيئة.`,
      };
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
