/**
 * Acceptance check for the web_scaffold starter.
 *
 * Copies the bundled Loam UI Kit starter into a temporary directory, installs
 * its dependencies from the local npm cache only (`npm install --offline`),
 * runs `npm run build`, and asserts both steps succeed. This is the
 * end-to-end proof behind the V3 acceptance test: "the scaffold builds
 * offline from cache, and npm run build passes".
 *
 * Run with: npm run check:web-scaffold
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defaultCommandRunner, scaffoldWebApp } from "../tools/webScaffold.js";
import { WEB_APP_TEMPLATE_FILES } from "../tools/templates/webapp/webAppTemplate.js";

export interface WebScaffoldAcceptance {
  pass: boolean;
  dir: string;
  files: number;
  installMs: number;
  buildMs: number;
  uiComponents: number;
  errors: string[];
}

const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

function countUiComponents(files: readonly { path: string }[]): number {
  return files.filter((file) => /^src\/components\/ui\/[^/]+\.tsx$/.test(file.path)).length;
}

export async function runAcceptance(): Promise<WebScaffoldAcceptance> {
  const errors: string[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-web-scaffold-"));
  try {
    const outcome = scaffoldWebApp(dir, WEB_APP_TEMPLATE_FILES);

    const installStart = Date.now();
    const installed = await defaultCommandRunner(NPM, ["install", "--offline", "--no-audit", "--no-fund"], {
      cwd: dir,
      timeoutMs: 10 * 60 * 1000,
    });
    const installMs = Date.now() - installStart;

    const buildStart = Date.now();
    const built = await defaultCommandRunner(NPM, ["run", "build"], {
      cwd: dir,
      timeoutMs: 5 * 60 * 1000,
    });
    const buildMs = Date.now() - buildStart;

    if (installed.code !== 0) errors.push(`install exited ${installed.code}: ${installed.stderr.slice(-1000)}`);
    if (built.code !== 0) errors.push(`build exited ${built.code}: ${built.stderr.slice(-1000)}`);

    return {
      pass: errors.length === 0 && outcome.created.length > 0,
      dir,
      files: outcome.created.length,
      installMs,
      buildMs,
      uiComponents: countUiComponents(WEB_APP_TEMPLATE_FILES),
      errors,
    };
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
    return {
      pass: false,
      dir,
      files: 0,
      installMs: 0,
      buildMs: 0,
      uiComponents: countUiComponents(WEB_APP_TEMPLATE_FILES),
      errors,
    };
  }
}

async function main(): Promise<number> {
  const started = Date.now();
  const result = await runAcceptance();
  console.log(JSON.stringify({ ...result, totalMs: Date.now() - started, dir: undefined }, null, 2));
  try {
    fs.rmSync(result.dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; a leftover temp dir is not a failure.
  }
  return result.pass ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
