/**
 * Offline build verification for a generated site (V1 seed, extended by V10/V14).
 *
 * A site "builds" when its declared build entrypoint exits 0 and produces a
 * known output artifact. Sites without a build script are accepted only when a
 * prebuilt artifact is already present, so the check never invents success.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface BuildResult {
  pass: boolean;
  /** Human-readable command that was attempted ("prebuilt" when no command ran). */
  command: string;
  exitCode: number | null;
  /** Combined stdout/stderr, truncated. */
  output: string;
  /** Site-relative artifact that was verified, if any. */
  artifact: string | null;
}

const ARTIFACTS = ["dist/index.html", "build/index.html", "out/index.html", ".next/BUILD_ID", "public/build/manifest.json"];

function findArtifact(siteDir: string): string | null {
  for (const candidate of ARTIFACTS) {
    if (fs.existsSync(path.join(siteDir, candidate))) return candidate;
  }
  return null;
}

export interface BuildCheckOptions {
  /** Hard timeout for the build command. Defaults to 120s. */
  timeoutMs?: number;
}

function npmBinary(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export async function checkSiteBuild(siteDir: string, options: BuildCheckOptions = {}): Promise<BuildResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const root = path.resolve(siteDir);
  const buildScript = path.join(root, "build.mjs");
  const pkgPath = path.join(root, "package.json");

  let command = "";
  let bin = "";
  let args: string[] = [];
  if (fs.existsSync(buildScript)) {
    command = "node build.mjs";
    bin = process.execPath;
    args = ["build.mjs"];
  } else if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      if (pkg.scripts && typeof pkg.scripts.build === "string") {
        command = "npm run build";
        bin = npmBinary();
        args = ["run", "build", "--silent"];
      }
    } catch {
      command = "";
    }
  }

  const prebuilt = findArtifact(root);
  if (!command) {
    return { pass: prebuilt !== null, command: "prebuilt", exitCode: prebuilt ? 0 : null, output: prebuilt ? "" : "no build entrypoint and no prebuilt artifact", artifact: prebuilt };
  }

  let exitCode: number | null = null;
  let output = "";
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      cwd: root,
      timeout: timeoutMs,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    exitCode = 0;
    output = `${stdout}\n${stderr}`.trim();
  } catch (error) {
    const err = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    exitCode = typeof err.code === "number" ? err.code : null;
    output = `${err.stdout ?? ""}\n${err.stderr ?? ""}\n${err.message ?? ""}`.trim();
  }

  const artifact = findArtifact(root);
  const pass = exitCode === 0 && artifact !== null;
  return { pass, command, exitCode, output: output.slice(0, 2000), artifact };
}
