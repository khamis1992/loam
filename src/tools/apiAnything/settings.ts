import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../../config.js";
import type { ApiAnythingConfig, ApiAnythingUserSettings } from "./types.js";

export const SETTINGS_FILE = path.join(DATA_DIR, "api-anything-settings.json");
const DOMAIN = /^(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/i;
const TASK = /^task_[a-zA-Z0-9_-]+$/;
const SITE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function loadUserSettings(): ApiAnythingUserSettings {
  try {
    const v = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) as Record<string, unknown>;
    return sanitize(v);
  } catch {
    return {};
  }
}

function sanitize(v: Record<string, unknown>): ApiAnythingUserSettings {
  const out: ApiAnythingUserSettings = {};
  for (const k of ["enabled", "allowWrites", "allowWriteLearning"] as const) if (typeof v[k] === "boolean") out[k] = v[k] as boolean;
  const list = (x: unknown, re: RegExp): string[] | undefined =>
    Array.isArray(x) ? [...new Set(x.filter((s): s is string => typeof s === "string" && re.test(s)))].slice(0, 500) : undefined;
  const d = list(v.learnDomains, DOMAIN);
  if (d) out.learnDomains = d.map((s) => s.toLowerCase());
  const t = list(v.peopleOpsTasks, TASK);
  if (t) out.peopleOpsTasks = t;
  if (v.sites === "all") out.sites = "all";
  else {
    const s = list(v.sites, SITE);
    if (s) out.sites = s;
  }
  return out;
}

export function saveUserSettings(patch: ApiAnythingUserSettings): ApiAnythingUserSettings {
  const next = sanitize({ ...loadUserSettings(), ...patch } as Record<string, unknown>);
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(`${SETTINGS_FILE}.tmp`, JSON.stringify(next, null, 1));
  fs.renameSync(`${SETTINGS_FILE}.tmp`, SETTINGS_FILE);
  return next;
}

/** Overlay the settings file on the config. Called once at startup (all keys) and after each save (live keys). */
export function applyUserSettings(cfg: ApiAnythingConfig, s: ApiAnythingUserSettings, includeRestartKeys: boolean): void {
  if (includeRestartKeys) {
    if (s.enabled !== undefined) cfg.enabled = s.enabled;
    if (s.allowWrites !== undefined) cfg.allowWrites = s.allowWrites;
    if (s.allowWriteLearning !== undefined) cfg.allowWriteLearning = s.allowWriteLearning;
  }
  if (s.learnDomains) cfg.learnDomains = s.learnDomains;
  if (s.peopleOpsTasks) cfg.peopleOpsTasks = s.peopleOpsTasks;
  if (s.sites) cfg.sites = s.sites;
}
