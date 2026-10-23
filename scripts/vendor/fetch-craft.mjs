#!/usr/bin/env node
/*
 * fetch-craft.mjs — reproducible vendoring of the Loam Craft web apps
 * (Loam Docs, Loam Sheets, Loam Slides, Loam Photo, Loam Design).
 *
 * The apps are the original ArtCraft wasm builds patched with the Loam
 * postMessage bridge (scripts/vendor/craft/loam_bridge.rs, applied by
 * scripts/vendor/craft/apply_patch.py) and rebranded at source level
 * (scripts/vendor/craft/rebrand_src.py). Each zip is installed into
 * electron/craft/<app>/dist and served over the privileged loamcraft:// scheme.
 *
 * Usage:
 *   node scripts/vendor/fetch-craft.mjs [app...] [--force] [--from-source]
 *
 * With no app argument all five apps are processed. Sources are tried in order:
 *   1. LOAM_CRAFT_<APP>_ZIP — a local zip path (APP upper-case, e.g.
 *      LOAM_CRAFT_WORDCRAFT_ZIP);
 *   2. <homedir>/Desktop/loam-vendor/<manifest zip name> — local cache, with the
 *      sha256 verified against scripts/vendor/craft/manifest.json (a mismatch
 *      aborts that app);
 *   3. --from-source — build the pinned upstream repo with Trunk via
 *      scripts/vendor/craft/build-craft-web.sh (needs bash, cargo, trunk).
 *
 * Extraction reuses the shared, dependency-free zip helpers in
 * scripts/vendor/lib (the same ones fetch-filmcraft.mjs/fetch-effectcraft.mjs
 * use), so the vendored code is never duplicated. The dist folder is
 * gitignored; this script never runs during npm install.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  clearDir,
  commandExists,
  installArchive,
  isDistPresent,
  sha256Hex,
  shouldPruneVendorFile,
  verifySha256,
  writeVendorJson,
} from "./lib/vendor.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "scripts", "vendor", "craft", "manifest.json"), "utf8"),
);

/** The five internal Craft app ids, in a stable order. */
export const CRAFT_APPS = ["wordcraft", "gridcraft", "deckcraft", "photocraft", "designcraft"];

/** User-facing names; never expose the upstream WordCraft/GridCraft/... ids. */
export const CRAFT_APP_NAMES = {
  wordcraft: "Loam Docs",
  gridcraft: "Loam Sheets",
  deckcraft: "Loam Slides",
  photocraft: "Loam Photo",
  designcraft: "Loam Design",
};

const CRAFT_ROOT = path.join(REPO_ROOT, "electron", "craft");
const BUILD_SCRIPT = path.join(REPO_ROOT, "scripts", "vendor", "craft", "build-craft-web.sh");
const CACHE_DIR = path.join(os.homedir(), "Desktop", "loam-vendor");

/** Install target for one app's dist. */
export function craftDistDir(app, root = REPO_ROOT) {
  return path.join(root, "electron", "craft", app, "dist");
}

/** Locate a candidate zip for one app: env override first, then the cache. */
export function resolveZipForApp(app, { env = process.env, cacheDir = CACHE_DIR } = {}) {
  const meta = MANIFEST.apps[app];
  if (!meta) throw new Error(`unknown Craft app "${app}"`);
  const envPath = env[`LOAM_CRAFT_${app.toUpperCase()}_ZIP`];
  if (envPath && envPath.trim()) return { zipPath: path.resolve(envPath.trim()), source: "env" };
  const cachePath = path.join(cacheDir, meta.zip);
  if (fs.existsSync(cachePath)) return { zipPath: cachePath, source: "cache" };
  return null;
}

/** Build one app from source with build-craft-web.sh and return its zip path. */
function buildFromSourceZip(app) {
  const missing = ["bash", "cargo", "trunk"].filter((tool) => !commandExists(tool));
  if (missing.length > 0) {
    throw new Error(
      `building ${app} from source requires ${missing.join(", ")} on PATH ` +
        `(Rust, the wasm32-unknown-unknown target and trunk).`,
    );
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const res = spawnSync("bash", [BUILD_SCRIPT, app, CACHE_DIR], {
    cwd: path.dirname(BUILD_SCRIPT),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0) {
    throw new Error(
      `build from source failed for ${app}: ${(res.stderr || res.stdout || "").trim()}`,
    );
  }
  const zipPath = (res.stdout || "").trim().split(/\r?\n/).pop()?.trim() || "";
  if (!zipPath || !fs.existsSync(zipPath)) {
    throw new Error(`build script did not report a zip for ${app}`);
  }
  return zipPath;
}

function unavailable(app, distDir, message) {
  console.warn(`craft: ${CRAFT_APP_NAMES[app] ?? app}: ${message}`);
  console.warn(`craft: no dist installed at ${distDir}`);
  return { app, skipped: true, distDir, reason: message };
}

/**
 * Materialize one app's dist.
 * @returns {{app: string, skipped: boolean, distDir: string, files?: string[],
 *   reason?: string, rev?: string, sha256?: string, source?: string}}
 */
export async function runCraftFetch(app, options = {}) {
  const meta = MANIFEST.apps[app];
  if (!meta) throw new Error(`unknown Craft app "${app}" (known: ${CRAFT_APPS.join(", ")})`);

  const distDir = options.distDir || craftDistDir(app, options.root);
  if (!options.force && isDistPresent(distDir)) {
    console.log(`craft: ${CRAFT_APP_NAMES[app]} dist already present at ${distDir} (use --force to replace)`);
    return { app, skipped: true, distDir, reason: "already-present" };
  }

  let zipPath;
  let source;
  if (options.fromSource) {
    zipPath = buildFromSourceZip(app);
    source = "from-source";
  } else {
    const found = resolveZipForApp(app, { env: options.env, cacheDir: options.cacheDir });
    if (!found) {
      return unavailable(
        app,
        distDir,
        `no zip found. Run \`node scripts/vendor/fetch-craft.mjs ${app}\` with ` +
          `LOAM_CRAFT_${app.toUpperCase()}_ZIP set, drop ${meta.zip} into ` +
          `${options.cacheDir || CACHE_DIR}, or run with --from-source. ` +
          `Loam will fall back to its own editor for this file type until then.`,
      );
    }
    zipPath = found.zipPath;
    source = found.source;
  }

  if (!fs.existsSync(zipPath)) throw new Error(`zip not found: ${zipPath}`);
  const buf = fs.readFileSync(zipPath);
  const expected = String(options.sha256 ?? meta.sha256).trim().toLowerCase();
  verifySha256(sha256Hex(buf), expected);

  clearDir(distDir);
  const files = installArchive(buf, distDir, { prune: shouldPruneVendorFile });
  if (files.length === 0) throw new Error(`archive contained no files for ${app}`);

  writeVendorJson(distDir, {
    app,
    rev: meta.rev,
    sha256: expected,
    source,
    fetchedAt: new Date().toISOString(),
  });

  console.log(`craft: installed ${CRAFT_APP_NAMES[app]} (${files.length} files) into ${distDir}`);
  return { app, skipped: false, distDir, files, rev: meta.rev, sha256: expected, source };
}

function parseArgs(argv) {
  const apps = [];
  const options = { force: false, fromSource: false };
  for (const arg of argv) {
    if (arg === "--force") options.force = true;
    else if (arg === "--from-source") options.fromSource = true;
    else if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`);
    else apps.push(arg);
  }
  return { apps: apps.length > 0 ? apps : [...CRAFT_APPS], options };
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`craft: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  const { apps, options } = parsed;
  const unknown = apps.filter((app) => !MANIFEST.apps[app]);
  if (unknown.length > 0) {
    console.error(`craft: unknown app(s): ${unknown.join(", ")} (known: ${CRAFT_APPS.join(", ")})`);
    process.exitCode = 1;
    return;
  }

  let hadError = false;
  for (const app of apps) {
    try {
      await runCraftFetch(app, options);
    } catch (err) {
      hadError = true;
      console.error(`craft: ${CRAFT_APP_NAMES[app] ?? app}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (hadError) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`craft: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
