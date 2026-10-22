// Availability of the vendored Loam Craft web apps (Loam Docs, Loam Sheets,
// Loam Slides, Loam Photo, Loam Design). The dists live in
// electron/craft/<app>/dist (gitignored) and are described by a .vendor.json
// sidecar written by scripts/vendor/fetch-craft.mjs. When a dist is missing the
// matching file type falls back to Loam's own editors.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.js";

/** The five internal Craft app ids (user-facing names come from CRAFT_APP_NAMES). */
export const CRAFT_APPS = ["wordcraft", "gridcraft", "deckcraft", "photocraft", "designcraft"] as const;

/** User-facing names; never expose the upstream WordCraft/GridCraft/... ids. */
export const CRAFT_APP_NAMES: Record<string, string> = {
  wordcraft: "Loam Docs",
  gridcraft: "Loam Sheets",
  deckcraft: "Loam Slides",
  photocraft: "Loam Photo",
  designcraft: "Loam Design",
};

export interface CraftAppStatus {
  app: string;
  name: string;
  installed: boolean;
  rev: string | null;
  source: string | null;
}

function craftDistDir(root: string, app: string): string {
  return path.join(root, "electron", "craft", app, "dist");
}

function readVendorJson(root: string, app: string): { rev?: unknown; source?: unknown } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(craftDistDir(root, app), ".vendor.json"), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Read the installed/available state of every Craft app dist. */
export function readCraftStatus(root: string = ROOT): CraftAppStatus[] {
  return CRAFT_APPS.map((app) => {
    const vendor = readVendorJson(root, app);
    const installed = Boolean(vendor) && fs.existsSync(craftDistDir(root, app));
    return {
      app,
      name: CRAFT_APP_NAMES[app] ?? app,
      installed,
      rev: installed && typeof vendor?.rev === "string" ? vendor.rev : null,
      source: installed && typeof vendor?.source === "string" ? vendor.source : null,
    };
  });
}

/**
 * Non-failing startup check: log how to fetch any missing Craft dist. Never
 * downloads anything and never blocks startup — a missing dist just means the
 * app falls back to Loam's own editor for that file type.
 */
export function logMissingCraftDists(root: string = ROOT): void {
  const missing = readCraftStatus(root).filter((app) => !app.installed);
  if (missing.length === 0) return;
  const ids = missing.map((app) => app.app).join(", ");
  console.warn(
    `[craft] missing Craft dist(s): ${ids}. ` +
      `Run \`node scripts/vendor/fetch-craft.mjs\` (or set LOAM_CRAFT_<APP>_ZIP) to install them; ` +
      `Loam will fall back to its own editor for those file types until then.`,
  );
}
