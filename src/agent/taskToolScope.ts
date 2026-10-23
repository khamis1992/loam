import type { ChatMessage } from "../ollama.js";
import type { ToolRegistry } from "../tools/registry.js";

const FILE_TOOLS = ["file_read", "file_write", "file_edit", "file_stat", "file_list", "file_search", "grep", "glob", "file_mkdir", "file_view_image"];

// ---------------------------------------------------------------------------
// Named tool profiles
// ---------------------------------------------------------------------------

/**
 * A named tool profile: a small, purpose-built capability subset that can be
 * applied to a task before mode/allowlist filtering. A profile is the harness
 * equivalent of a "tool set": it decides which tools a task may see, so a long
 * tool list never dilutes a small model's attention.
 */
export interface ToolProfile {
  /** Stable identifier used by callers and persisted in run state. */
  id: string;
  /** Short human label for diagnostics and the UI. */
  label: string;
  /** One-line statement of the profile's intent. */
  description: string;
  /** Ordered allowlist of tool names; names that are not registered are ignored. */
  tools: string[];
}

/**
 * The coding profile: a lean, sharp set for writing and verifying code — read,
 * edit, write, search, run, research, delegate, track and finish, and nothing
 * else. It mirrors the core coding loop: inspect, change, prove, report.
 */
export const CODING_PROFILE: ToolProfile = {
  id: "coding",
  label: "Coding",
  description:
    "A lean coding set: read, edit, write, search, shell, research, delegate, todo and finish.",
  tools: [
    "file_read",
    "file_edit",
    "file_multi_edit",
    "file_write",
    "grep",
    "glob",
    "file_list",
    "shell_run",
    "shell_start",
    "shell_read",
    "shell_kill",
    "todo_write",
    "web_fetch",
    "web_search",
    "delegate_task",
    "plan_exit",
    "suggest_plan",
    "ask_user",
    "finish",
  ],
};

/** Every named profile, keyed by id. */
export const TOOL_PROFILES: ReadonlyMap<string, ToolProfile> = new Map([
  [CODING_PROFILE.id, CODING_PROFILE],
]);

/** Look up a profile by id; undefined when the id is unknown. */
export function getToolProfile(id: string): ToolProfile | undefined {
  return TOOL_PROFILES.get(id);
}

/** Every named profile, in registration order. */
export function listToolProfiles(): ToolProfile[] {
  return [...TOOL_PROFILES.values()];
}

/** Whether id names a known profile. */
export function isToolProfile(id: string): boolean {
  return TOOL_PROFILES.has(id);
}

/** Resolve a profile to the tool names that are actually registered. */
export function profileToolNames(profileId: string, registered: readonly string[]): string[] {
  const profile = getToolProfile(profileId);
  if (!profile) throw new Error(`Unknown tool profile: ${profileId}`);
  const available = new Set(registered);
  return profile.tools.filter((name) => available.has(name));
}

/** Apply a named tool profile to a registry, keeping only the profile's tools. */
export function profileScopedTools(tools: ToolRegistry, profileId: string): ToolRegistry {
  const profile = getToolProfile(profileId);
  if (!profile) throw new Error(`Unknown tool profile: ${profileId}`);
  return tools.forAllowlist(profile.tools);
}

/** The coding task's tool set: the coding profile applied to a registry. */
export function codingTaskTools(tools: ToolRegistry): ToolRegistry {
  return profileScopedTools(tools, CODING_PROFILE.id);
}

/** Deliberately narrow language support: explicit standalone user commands,
 * never instructions discovered in tool output, assistant history or plans.
 * This is not a general natural-language permission classifier. */
export function fileOnlyRequested(prompt: string, history: ChatMessage[] = []): boolean {
  let restricted = false;
  for (const text of [...history.filter(m => m.role === "user").map(m => m.content), prompt]) {
    const normalized = text.normalize("NFKC").replace(/[\u064B-\u065F\u0670]/g, "");
    for (const sentence of normalized.split(/[\n.!?؟]+/)) {
      const s = sentence.trim();
      if (/^(?:(?:استخدم|استعمل) أدوات الملفات فقط|use (?:only file tools|file tools only))(?:\s|[،,:;]|$)/i.test(s)) restricted = true;
      else if (/^(?:ألغ قيد أدوات الملفات فقط|الغ قيد أدوات الملفات فقط|remove the file-tools-only restriction)(?:\s|[،,:;]|$)/i.test(s)) restricted = false;
    }
  }
  return restricted;
}
export function taskScopedTools(
  tools: ToolRegistry,
  prompt: string,
  history?: ChatMessage[],
  forceFileOnly = false,
  profile?: string,
): ToolRegistry {
  const scoped = forceFileOnly || fileOnlyRequested(prompt, history) ? tools.forAllowlist(FILE_TOOLS) : tools;
  return profile ? profileScopedTools(scoped, profile) : scoped;
}
