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
}

const FILE = path.join(DATA_DIR, "settings.json");
let settings: Settings = { theme: "dark", projectId: null };

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
      };
    }
  } catch {
    settings = { theme: "dark", projectId: null };
  }
  return settings;
}

/** Live check used by mutating tools: writes apply directly unless auto-approval is off. */
export function gateActive(): boolean {
  return getSettings().autoApprove === false;
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
