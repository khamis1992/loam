import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";

export interface Settings {
  theme: "dark" | "light" | "system";
  model?: string;
  projectId?: string | null;
  /** Active working folder (repo/project) the agent reads and edits. */
  workspace?: string;
  recentWorkspaces?: string[];
  /** When false, mutating agent operations (skills/memory installs) stage for manual approval instead of applying. */
  autoApprove?: boolean;
  /** Custom electron-updater generic feed URL or GitHub repo ("owner/repo"). */
  updateFeedUrl?: string;
  githubRepo?: string;
  /** In-App Browser (Settings > In-App Browser): headless vs visible window,
   *  and the page opened when browser_open has no URL. */
  browserHeadless?: boolean;
  browserHomepage?: string;
  /** Option 18 Flex tier: OpenAI-compatible provider base URL (the API key itself lives in the secrets vault). */
  flexBaseUrl?: string;
  /** Option 18 Flex tier: model id to call through the Flex provider. */
  flexModel?: string;
  /** Settings › Data controls: when true, user data is excluded from model training. */
  trainingOptOut?: boolean;
  /** MiroFish swarm simulation: user-selected location (any country/city/region). */
  location?: { country?: string; city?: string; region?: string };
}

const FILE = path.join(DATA_DIR, "settings.json");
let settings: Settings = { theme: "dark", projectId: null };

/** True when a persisted value is a plausible location setting. */
function isLocationSetting(value: unknown): value is NonNullable<Settings["location"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.country === "string" || typeof rec.city === "string" || typeof rec.region === "string";
}

export function loadSettings(): Settings {
  try {
    if (fs.existsSync(FILE)) {
      const parsed = JSON.parse(fs.readFileSync(FILE, "utf8")) as Partial<Settings>;
      settings = {
        theme: parsed.theme ?? "dark",
        model: parsed.model,
        projectId: parsed.projectId ?? null,
        ...(typeof parsed.workspace === "string" ? { workspace: parsed.workspace } : {}),
        ...(Array.isArray(parsed.recentWorkspaces) ? { recentWorkspaces: parsed.recentWorkspaces.map(String) } : {}),
        ...(typeof parsed.updateFeedUrl === "string" ? { updateFeedUrl: parsed.updateFeedUrl } : {}),
        ...(typeof parsed.githubRepo === "string" ? { githubRepo: parsed.githubRepo } : {}),
        ...(typeof parsed.browserHeadless === "boolean" ? { browserHeadless: parsed.browserHeadless } : {}),
        ...(typeof parsed.browserHomepage === "string" ? { browserHomepage: parsed.browserHomepage } : {}),
        ...(typeof parsed.flexBaseUrl === "string" ? { flexBaseUrl: parsed.flexBaseUrl } : {}),
        ...(typeof parsed.flexModel === "string" ? { flexModel: parsed.flexModel } : {}),
        ...(typeof parsed.trainingOptOut === "boolean" ? { trainingOptOut: parsed.trainingOptOut } : {}),
        ...(typeof parsed.autoApprove === "boolean" ? { autoApprove: parsed.autoApprove } : {}),
        ...(isLocationSetting(parsed.location) ? { location: parsed.location } : {}),
      };
    }
  } catch {
    settings = { theme: "dark", projectId: null };
  }
  return settings;
}

/** Live check used by mutating tools: writes stage for manual approval unless the
 *  user explicitly turned auto-approval on. Missing/undefined is the conservative
 *  default (approval required), so the preference survives an older settings file. */
export function gateActive(): boolean {
  return getSettings().autoApprove !== true;
}

export function getSettings(): Settings {
  return settings;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  if (patch.theme === "dark" || patch.theme === "light" || patch.theme === "system") settings.theme = patch.theme;
  if (typeof patch.model === "string") settings.model = patch.model;
  if (patch.projectId === null || typeof patch.projectId === "string") settings.projectId = patch.projectId;
  if (typeof patch.workspace === "string") settings.workspace = patch.workspace;
  if (Array.isArray(patch.recentWorkspaces)) settings.recentWorkspaces = patch.recentWorkspaces.map(String).slice(0, 10);
  if (typeof patch.updateFeedUrl === "string") settings.updateFeedUrl = patch.updateFeedUrl.trim();
  if (typeof patch.githubRepo === "string") settings.githubRepo = patch.githubRepo.trim();
  if (typeof patch.autoApprove === "boolean") settings.autoApprove = patch.autoApprove;
  if (typeof patch.browserHeadless === "boolean") settings.browserHeadless = patch.browserHeadless;
  if (patch.browserHomepage !== undefined) settings.browserHomepage = typeof patch.browserHomepage === "string" ? patch.browserHomepage.trim() : "";
  if (typeof patch.flexBaseUrl === "string") settings.flexBaseUrl = patch.flexBaseUrl.trim();
  if (typeof patch.flexModel === "string") settings.flexModel = patch.flexModel.trim();
  if (typeof patch.trainingOptOut === "boolean") settings.trainingOptOut = patch.trainingOptOut;
  if (patch.location !== undefined) {
    settings.location = isLocationSetting(patch.location)
      ? {
          ...(typeof patch.location.country === "string" && patch.location.country.trim() ? { country: patch.location.country.trim() } : {}),
          ...(typeof patch.location.city === "string" && patch.location.city.trim() ? { city: patch.location.city.trim() } : {}),
          ...(typeof patch.location.region === "string" && patch.location.region.trim() ? { region: patch.location.region.trim() } : {}),
        }
      : undefined;
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 1), "utf8");
    fs.renameSync(tmp, FILE);
  } catch {
    /* ignore */
  }
  return settings;
}
