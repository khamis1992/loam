/**
 * Master system prompt assembler.
 *
 * The prompt text itself lives in `prompts/loam-master.md` and is compiled to
 * `src/agent/masterPromptText.ts` (see src/scripts/gen-master-prompt.ts). This
 * module orders the sections exactly as Appendix B requires, fills every
 * runtime `{{slot}}`, appends the optional per-model Appendix A block and the
 * dynamic context, and never leaves a raw placeholder behind.
 */
import path from "node:path";
import { execFileSync } from "node:child_process";
import { MASTER_PROMPT_SECTIONS, type MasterPromptSection } from "./masterPromptText.js";
import type { Config } from "../config.js";
import { DEFAULT_TIMEZONE } from "../server/scheduleTime.js";
import { CONNECTORS, CONNECTOR_TOOLS, connectedConnectorToolNames } from "../server/connectors/index.js";

export const MASTER_SLOT_NAMES = [
  "user_name",
  "user_tz",
  "now_local",
  "os",
  "workspace_root",
  "shell",
  "project_name",
  "project_path",
  "git_branch",
  "connector_list",
  "model_chain",
  "current_model",
  "max_parallel_agents",
  "spill_threshold",
  "deliverables_dir",
  "local_timeout_s",
] as const;

export type MasterSlotName = (typeof MASTER_SLOT_NAMES)[number];
export type MasterPromptSlots = Record<MasterSlotName, string>;

export interface MasterPromptOptions {
  /** Current model id; selects the Appendix A block. Omit/unknown = no block. */
  model?: string;
  /** Appended after the Appendix A block (Appendix B step 9). */
  dynamicContext?: string;
}

export type ModelFamily = "frontier" | "fast" | "local-ollama";

/** Appendix B assembly order, as section ids. */
export const MASTER_ORDER: readonly (readonly string[])[] = [
  ["1", "2", "3"],
  ["4", "5"],
  ["6", "7"],
  ["8", "9", "10", "11", "12", "13"],
  ["14", "15", "16", "17", "18"],
  ["19", "20", "21", "22", "23"],
  ["24"],
];

/** Appendix C is authored in the master asset but sent only for coding tasks. */
export const CODING_MODE_SECTION_ID = "appendix-c";

/**
 * §25 (long-horizon missions / recipe mode) is authored in the master asset but
 * sent only to runs that actually execute a Recipe, so a plain chat or build run
 * never pays for the mission rules. The orchestrator opts in through
 * `systemSuffix`, which `buildSystemPrompt` appends to the assembled prompt.
 */
export const MISSION_SECTION_ID = "25";

/** Tools whose presence marks a run as a coding task (Appendix C applies). */
const CODING_TASK_TOOLS = [
  "file_edit",
  "file_write",
  "file_multi_edit",
  "code_session",
  "shell_run",
] as const;

/** True when the run has coding tools and should receive Appendix C. */
export function isCodingTask(toolNames: readonly string[]): boolean {
  return CODING_TASK_TOOLS.some((name) => toolNames.includes(name));
}

/** Render the coding-mode appendix (Appendix C) with its heading. */
export function codingModeSection(): string {
  const section = MASTER_PROMPT_SECTIONS.find((s) => s.id === CODING_MODE_SECTION_ID);
  if (!section) return "";
  return `## ${section.title}\n\n${section.body}`;
}

/** Render the long-horizon mission section (§25) with its heading. */
export function missionSection(): string {
  const section = MASTER_PROMPT_SECTIONS.find((s) => s.id === MISSION_SECTION_ID);
  if (!section) return "";
  return `## ${section.title}\n\n${section.body}`;
}

const DEFAULT_MAX_PARALLEL_AGENTS = 4;
const DEFAULT_SPILL_THRESHOLD = 80_000;
const DEFAULT_LOCAL_TIMEOUT_S = 600;

/** Classify a model id into the Appendix A families. Unknown = undefined. */
export function modelFamily(model: string | undefined): ModelFamily | undefined {
  const m = (model ?? "").trim().toLowerCase();
  if (!m) return undefined;
  if (/(flash|mini|haiku|turbo|lite|nano|small|air|express|cheap|glm)/.test(m)) return "fast";
  if (/(gpt-5|gpt-4\.1|gpt-4o|o1|o3|claude|opus|sonnet|gemini|grok|deepseek-r1|deepseek-v3|frontier)/.test(m)) return "frontier";
  if (!m.endsWith(":cloud")) return "local-ollama";
  return undefined;
}

interface FamilyBullet {
  families: ModelFamily[];
  text: string;
}

const BULLET_FAMILIES: Array<{ match: RegExp; family: ModelFamily }> = [
  { match: /frontier/i, family: "frontier" },
  { match: /fast or cheaper/i, family: "fast" },
  { match: /over-editing/i, family: "frontier" },
  { match: /weak at arabic/i, family: "fast" },
  { match: /local models \(ollama\)/i, family: "local-ollama" },
];

function parseFamilyBullets(body: string): FamilyBullet[] {
  const bullets: FamilyBullet[] = [];
  let current: string[] | null = null;
  for (const line of body.split("\n")) {
    if (/^- \*\*/.test(line)) {
      if (current) bullets.push({ families: familiesFor(current.join("\n")), text: current.join("\n") });
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) bullets.push({ families: familiesFor(current.join("\n")), text: current.join("\n") });
  return bullets;
}

function familiesFor(text: string): ModelFamily[] {
  const families: ModelFamily[] = [];
  for (const { match, family } of BULLET_FAMILIES) {
    if (match.test(text) && !families.includes(family)) families.push(family);
  }
  return families;
}

function appendixABlock(family: ModelFamily | undefined): string {
  if (!family) return "";
  const appendix = MASTER_PROMPT_SECTIONS.find((s) => s.id === "appendix-a");
  if (!appendix) return "";
  const selected = parseFamilyBullets(appendix.body).filter((b) => b.families.includes(family));
  if (selected.length === 0) return "";
  return `## Appendix A — Per-Model Adaptation Notes\n\n${selected.map((b) => b.text).join("\n")}`;
}

const SLOT_PATTERN = /\{\{([^{}]+)\}\}/g;

/** Fill known slots; keep literal `{{vault:NAME}}` examples; unknown -> "unknown". */
export function fillMasterSlots(text: string, slots: Partial<MasterPromptSlots> | Record<string, string>): string {
  const map = slots as Record<string, string | undefined>;
  return text.replace(SLOT_PATTERN, (raw, name: string) => {
    const key = name.trim();
    if (key in map) {
      const value = map[key];
      return value && value.trim().length > 0 ? value : "unknown";
    }
    if (/^vault:/.test(key)) return raw;
    return "unknown";
  });
}

function renderSection(section: MasterPromptSection): string {
  return `## ${section.title}\n\n${section.body}`;
}

/** Assemble the master prompt in Appendix B order with every slot filled. */
export function buildMasterPrompt(
  slots: Partial<MasterPromptSlots> | Record<string, string> = {},
  opts: MasterPromptOptions = {},
): string {
  const byId = new Map(MASTER_PROMPT_SECTIONS.map((s) => [s.id, s]));
  const parts: string[] = [];
  for (const group of MASTER_ORDER) {
    const rendered = group
      .map((id) => byId.get(id))
      .filter((s): s is MasterPromptSection => s !== undefined)
      .map(renderSection);
    if (rendered.length > 0) parts.push(rendered.join("\n\n"));
  }
  const appendix = appendixABlock(modelFamily(opts.model));
  if (appendix) parts.push(appendix);
  if (opts.dynamicContext && opts.dynamicContext.trim().length > 0) parts.push(opts.dynamicContext.trim());
  return fillMasterSlots(parts.join("\n\n"), slots);
}

function platformOs(): string {
  switch (process.platform) {
    case "win32":
      return "Windows";
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    default:
      return process.platform;
  }
}

function platformShell(): string {
  if (process.platform === "win32") return "powershell";
  return process.env.SHELL && process.env.SHELL.trim() ? process.env.SHELL.trim() : "bash";
}

function resolveUserTz(): string {
  const env = process.env.LOAM_USER_TZ ?? process.env.MANUS_LOCAL_USER_TZ;
  if (env && env.trim()) return env.trim();
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && tz.trim()) return tz.trim();
  } catch {
    /* fall through */
  }
  return DEFAULT_TIMEZONE;
}

function resolveUserName(): string {
  const env =
    process.env.LOAM_USER_NAME ?? process.env.MANUS_LOCAL_USER_NAME ?? process.env.USERNAME ?? process.env.USER;
  return env && env.trim() ? env.trim() : "unknown";
}

function resolveNowLocal(tz: string): string {
  try {
    return new Date().toLocaleString("en-US", { timeZone: tz, dateStyle: "full", timeStyle: "short" });
  } catch {
    return new Date().toISOString();
  }
}

function resolveGitBranch(workspace: string): string {
  try {
    const out = execFileSync("git", ["-C", workspace, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out && out !== "HEAD" ? out : "unknown";
  } catch {
    return "unknown";
  }
}

function resolveConnectorList(toolNames: readonly string[]): string {
  try {
    const available = new Set(toolNames);
    const names = connectedConnectorToolNames().filter((name) => available.has(name));
    if (names.length === 0) return "none";
    const ids = CONNECTORS.filter((c) => names.some((n) => (CONNECTOR_TOOLS[c.id] ?? []).includes(n))).map((c) => c.id);
    return ids.length > 0 ? ids.join(", ") : names.join(", ");
  } catch {
    return "unknown";
  }
}

/** Derive every runtime slot for the master prompt. Best effort, never throws. */
export function deriveMasterSlots(cfg: Config, toolNames: readonly string[] = []): MasterPromptSlots {
  const workspace = cfg.workspace ?? process.cwd();
  const tz = resolveUserTz();
  const model = cfg.model ?? "";
  const fallback = cfg.fallbackModel ?? "";
  const chain = [model, fallback].filter((m) => m && m.trim()).join(" → ");
  const slots: MasterPromptSlots = {
    user_name: resolveUserName(),
    user_tz: tz,
    now_local: resolveNowLocal(tz),
    os: platformOs(),
    workspace_root: workspace,
    shell: platformShell(),
    project_name: path.basename(workspace) || workspace,
    project_path: workspace,
    git_branch: resolveGitBranch(workspace),
    connector_list: resolveConnectorList(toolNames),
    model_chain: chain || "unknown",
    current_model: model || "unknown",
    max_parallel_agents: String(DEFAULT_MAX_PARALLEL_AGENTS),
    spill_threshold: String(DEFAULT_SPILL_THRESHOLD),
    deliverables_dir: path.join(workspace, "deliverables"),
    local_timeout_s: String(DEFAULT_LOCAL_TIMEOUT_S),
  };
  return slots;
}
