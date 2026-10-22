import { addSchedule } from "./db.js";
import { createAgent, listAgents, sanitizeAvatarFields } from "./agents.js";
import { applySkill, listSkillRecords } from "../tools/skills.js";
import { log } from "../log.js";

/**
 * Grok Bot bundle importer (Phase 2).
 *
 * Accepts a bundle shaped like:
 *   { agents: [{ id?, name?, title?, description?, instructions?, routines: [{name,prompt,schedule,enabled}] | "unknown", referencedSkills? }],
 *     skills: [{ name, description, body }] }
 *
 * Creates Loam agents with source:"grokbot" (idempotent on name+source), each
 * global skill once, and a cron schedule per routine. Returns the count summary
 * { agents, skills, schedules, skipped }.
 */

export interface GrokbotRoutine {
  name: string;
  prompt: string;
  schedule: string;
  enabled: boolean;
}

export interface GrokbotBundleAgent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  routines: GrokbotRoutine[] | "unknown";
  referencedSkills: string[];
  /** Optional Grok Bot-style avatar tokens carried through the bundle. */
  avatarShape?: string;
  avatarColor?: string;
  avatarImage?: string;
}

export interface GrokbotBundleSkill {
  name: string;
  description: string;
  body: string;
}

export interface GrokbotBundle {
  agents: GrokbotBundleAgent[];
  skills: GrokbotBundleSkill[];
}

export interface GrokbotImportSummary {
  agents: number;
  skills: number;
  schedules: number;
  skipped: number;
}

function str(value: unknown, cap: number): string {
  return typeof value === "string" ? value.trim().slice(0, cap) : "";
}

function strList(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) return [];
  const out = value.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim().slice(0, cap));
  return [...new Set(out)];
}

function sanitizeAgent(raw: unknown): GrokbotBundleAgent | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const name = str(r.name, 80) || str(r.title, 80);
  if (!name) return undefined;
  let routines: GrokbotRoutine[] | "unknown" = "unknown";
  if (Array.isArray(r.routines)) {
    routines = [];
    for (const rawRoutine of r.routines.slice(0, 100)) {
      if (!rawRoutine || typeof rawRoutine !== "object") continue;
      const ro = rawRoutine as Record<string, unknown>;
      const prompt = str(ro.prompt, 8000);
      if (!prompt) continue;
      routines.push({
        name: str(ro.name, 80),
        prompt,
        schedule: str(ro.schedule, 80),
        enabled: ro.enabled !== false,
      });
    }
  }
  return {
    id: str(r.id, 80),
    name,
    description: str(r.description, 300),
    instructions: str(r.instructions, 4000),
    routines,
    referencedSkills: strList(r.referencedSkills, 80).slice(0, 40),
    ...sanitizeAvatarFields(r),
  };
}

function sanitizeSkill(raw: unknown): GrokbotBundleSkill | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const name = str(r.name, 60);
  if (!name) return undefined;
  return {
    name,
    description: str(r.description, 300),
    body: str(r.body, 20000),
  };
}

/** Shape/length validation for the /api/agents/import-grokbot handler. */
export function sanitizeGrokbotBundle(raw: unknown): GrokbotBundle | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "bundle must be an object" };
  const b = raw as Record<string, unknown>;
  if (!Array.isArray(b.agents)) return { error: "bundle.agents must be an array" };
  if (b.skills !== undefined && !Array.isArray(b.skills)) return { error: "bundle.skills must be an array" };
  const agents: GrokbotBundleAgent[] = [];
  for (const r of (b.agents as unknown[]).slice(0, 50)) {
    const agent = sanitizeAgent(r);
    if (agent) agents.push(agent);
  }
  const skills: GrokbotBundleSkill[] = [];
  for (const r of ((b.skills as unknown[] | undefined) ?? []).slice(0, 100)) {
    const skill = sanitizeSkill(r);
    if (skill) skills.push(skill);
  }
  return { agents, skills };
}

/** Approximate the interval hint from a cron expression; non-cron values fall back to 3600s. */
export function cronIntervalSeconds(cron: string): number {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return 3600;
  const minute = f[0];
  const hour = f[1];
  const minuteNum = minute === "*" ? NaN : Number(minute);
  const hourNum = hour === "*" ? NaN : Number(hour);
  if (minute === "*") return hour === "*" ? 60 : 3600;
  if (!Number.isFinite(hourNum) && Number.isFinite(minuteNum) && minuteNum >= 0) return 3600;
  if (Number.isFinite(hourNum) && hourNum > 0 && Number.isFinite(minuteNum) && minuteNum >= 0) return hourNum * 3600;
  return 3600;
}

function skillNote(skills: string[]): string {
  return skills.length > 0 ? `\n\nReferenced skills: ${skills.join(", ")}` : "";
}

function grokbotAgentNameExists(name: string): boolean {
  const target = name.trim().toLowerCase();
  return listAgents(true).some((a) => a.source === "grokbot" && a.name.trim().toLowerCase() === target);
}

function existingSkillNames(): Set<string> {
  const lower = new Set<string>();
  for (const rec of listSkillRecords()) lower.add(rec.name.trim().toLowerCase());
  return lower;
}

export function importGrokbotBundle(bundle: GrokbotBundle): GrokbotImportSummary {
  const summary: GrokbotImportSummary = { agents: 0, skills: 0, schedules: 0, skipped: 0 };
  const haveSkills = existingSkillNames();

  // Global skills are created once, keyed by lowercase name.
  for (const skill of bundle.skills) {
    const key = skill.name.trim().toLowerCase();
    if (!key || haveSkills.has(key)) continue;
    const result = applySkill("skill_create", { name: skill.name, description: skill.description, content: skill.body || skill.description });
    if (result.ok) {
      haveSkills.add(key);
      summary.skills += 1;
    } else {
      log.warn(`grokbot import: skill_create "${skill.name}" failed: ${result.content.slice(0, 200)}`);
    }
  }

  for (const agentBundle of bundle.agents) {
    if (grokbotAgentNameExists(agentBundle.name)) {
      summary.skipped += 1;
      continue;
    }
    const instructions = `${agentBundle.description}${skillNote(agentBundle.referencedSkills)}`.slice(0, 8000).trim();
    const agent = createAgent({
      name: agentBundle.name,
      description: agentBundle.description,
      instructions: instructions || (agentBundle.instructions ? agentBundle.instructions.slice(0, 8000) : undefined),
      source: "grokbot",
      ...(agentBundle.avatarShape ? { avatarShape: agentBundle.avatarShape } : {}),
      ...(agentBundle.avatarColor ? { avatarColor: agentBundle.avatarColor } : {}),
      ...(agentBundle.avatarImage ? { avatarImage: agentBundle.avatarImage } : {}),
    });
    summary.agents += 1;
    if (agentBundle.routines === "unknown") continue;
    for (const routine of agentBundle.routines) {
      if (!routine.schedule.trim()) continue;
      try {
        addSchedule(
          routine.prompt,
          cronIntervalSeconds(routine.schedule),
          agent.id,
          undefined,
          "cron",
          undefined,
          routine.enabled,
          { cron: routine.schedule },
        );
        summary.schedules += 1;
      } catch (err) {
        log.warn(`grokbot import: routine "${routine.name}" skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return summary;
}
