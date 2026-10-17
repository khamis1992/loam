import path from "node:path";
import type { Config } from "../config.js";
import { log } from "../log.js";
import type { OllamaClient } from "../ollama.js";
import type { ToolRegistry } from "../tools/registry.js";
import { runAgent } from "./loop.js";
import { appendLearning } from "../server/learning.js";
import { listSkillRecords } from "../tools/skills.js";
import type { ToolTraceItem } from "./events.js";

export type { ToolTraceItem };

const FORCE_SKILL_SYSTEM = [
  "You are the skill-writer for a local autonomous agent.",
  "The previous task used a tool that is NOT covered by any existing skill.",
  "You MUST write that skill now: call skill_create exactly once with a concise, executable recipe.",
  "Include the exact commands that worked (with placeholders for variable parts), the headless/scripting entrypoint if any, the pitfalls, and how to verify the result.",
  "Do NOT reply NOTHING. Do NOT only store a memory. Call skill_create.",
].join("\n");

const FORCE_PATCH_SYSTEM = [
  "You are the skill-upgrader for a local autonomous agent.",
  "The previous task used an EXISTING skill and hit a tool failure or pitfall along the way.",
  "You MUST upgrade that skill now: (1) call skill_view on the named skill, then (2) call skill_patch with the full updated content that adds the pitfall and its fix under Pitfalls.",
  "Do NOT reply NOTHING. Call skill_view and then skill_patch.",
].join("\n");

/** Heuristic: if an existing skill was viewed or its tool was used and the trace
 *  contains a failed step, return that skill name + failure summary for auto-upgrade. */
export function detectSkillPitfall(trace: ToolTraceItem[], promptText = ""): { skillName: string; failure: string } | null {
  const failures = trace.filter((t) => !t.ok);
  if (failures.length === 0) return null;
  let skills: Array<{ name: string; description: string }> = [];
  try {
    skills = listSkillRecords();
  } catch {
    return null;
  }
  if (skills.length === 0) return null;

  // 1) Explicit skill_view call in the trace
  for (const item of trace) {
    if (item.name === "skill_view") {
      const argName = typeof (item.args as Record<string, unknown> | undefined)?.name === "string"
        ? String((item.args as Record<string, unknown>).name).trim()
        : "";
      const hit = skills.find((s) => s.name.toLowerCase() === argName.toLowerCase());
      if (hit) {
        return { skillName: hit.name, failure: failures.map((f) => `${f.name}: ${f.summary.slice(0, 180)}`).join(" | ") };
      }
    }
  }

  // 2) Match skill name against failed/used commands or prompt text
  const corpus = [
    promptText,
    ...trace.map((t) => `${t.name} ${JSON.stringify(t.args ?? {})} ${t.summary}`),
  ]
    .join(" ")
    .toLowerCase();

  for (const s of skills) {
    const key = s.name.toLowerCase();
    if (key.length >= 3 && corpus.includes(key)) {
      return { skillName: s.name, failure: failures.map((f) => `${f.name}: ${f.summary.slice(0, 180)}`).join(" | ") };
    }
  }
  return null;
}

/** Heuristic: find a command-line tool used in this task that no skill mentions yet. */
function detectNewTool(trace: ToolTraceItem[]): { tool: string; evidence: string } | null {
  let known = "";
  try {
    known = listSkillRecords()
      .map((s) => `${s.name} ${s.description}`)
      .join(" ")
      .toLowerCase();
  } catch {
    known = "";
  }
  const skip = new Set([
    "cd", "dir", "ls", "echo", "type", "where", "which", "node", "npm", "npx", "git", "python", "python3",
    "powershell", "powershell.exe", "cmd", "cmd.exe", "start", "taskkill", "copy", "move", "del", "mkdir",
    "ren", "if", "for", "set", "call", "timeout", "findstr", "find", "sort", "more", "cat", "head", "tail",
  ]);
  for (const item of trace) {
    const args = item.args as Record<string, unknown> | undefined;
    const command = typeof args?.command === "string" ? args.command : "";
    if (!command) continue;
    // first meaningful token, ignoring env prefixes and quotes
    const tokens = command
      .replace(/^["']|["']$/g, "")
      .split(/[\s|&;]+/)
      .map((t) => t.replace(/^["']|["']$/g, ""))
      .filter((t) => t && !t.includes("=") && !t.startsWith("-") && !t.startsWith("/") && !t.startsWith("$"));
    const tool = tokens.find((t) => /^[A-Za-z][\w.-]*$/.test(t) && !skip.has(t.toLowerCase()));
    if (!tool) continue;
    const base = path.basename(tool).replace(/\.exe$/i, "").toLowerCase();
    if (base.length < 3) continue;
    if (known.includes(base)) continue;
    return { tool, evidence: command.slice(0, 200) };
  }
  return null;
}

export interface ReflectOptions {
  cfg: Config;
  ollama: OllamaClient;
  /** Registry containing only the memory + skill tools (nothing destructive). */
  reviewTools: ToolRegistry;
  prompt: string;
  finalText: string;
  toolTrace: ToolTraceItem[];
  /** Collector: each applied change appends its label here. */
  applied: string[];
}

const REVIEW_SYSTEM = [
  "You are the post-task reviewer for a local autonomous agent. You receive a short digest of a task that just finished.",
  "Your job is to make the NEXT task cheaper: turn anything durable that was learned into a skill or a memory.",
  "",
  "ALWAYS record these:",
  "- TOOL DISCOVERY (highest priority): if the trace shows the agent figuring out how to use a tool or app it did not know (locating the binary, checking --version or --help, reading docs, a first successful command, headless/scripting entrypoint), you MUST capture that as a skill named after the tool (skill_create), even if the task itself failed or produced a poor result. Without this, the next task repeats the whole discovery.",
  "- A reusable multi-step procedure -> skill_create.",
  "- A pitfall and its fix -> fold it into the relevant skill with skill_patch (call skill_list, then skill_view first).",
  "- A durable fact or preference about the machine, project, or workflow -> memory_store (one or two self-contained sentences).",
  "",
  "Rules:",
  "- Call skill_list first; prefer skill_patch on an existing skill over skill_create.",
  "- Never record task ids, dates, incident narration, or one-off debugging detail.",
  "- Skills must stay concise and executable: When to Use / Procedure (exact commands) / Pitfalls / Verification.",
  "- If the task FAILED, still record the working parts and the failure mode — the next attempt must not start from zero.",
  "- If you already wrote a skill for this tool in this session, improve it instead of duplicating.",
  "- If truly nothing durable was learned, reply with exactly: NOTHING",
].join("\n");

function buildDigest(o: ReflectOptions): string {
  const trace =
    o.toolTrace.length > 0
      ? o.toolTrace
          .slice(-30)
          .map((t) => `- ${t.ok ? "ok" : "FAIL"} ${t.name}: ${t.summary.replace(/\s+/g, " ").slice(0, 200)}`)
          .join("\n")
      : "(no tools were used)";
  return [
    "USER TASK:",
    o.prompt.slice(0, 1500),
    "",
    "FINAL ANSWER:",
    o.finalText.slice(0, 2000),
    "",
    "TOOL TRACE:",
    trace,
  ].join("\n");
}

/** Background learning review: runs the agent loop with ONLY memory + skill tools,
 *  so durable lessons become skills/memories. Never throws into the task path. */
export async function reflectOnTask(o: ReflectOptions): Promise<string[]> {
  const model = o.cfg.selfImprove.model.length > 0 ? o.cfg.selfImprove.model : o.cfg.model;
  try {
    await runAgent({
      cfg: { ...o.cfg, model, agent: { ...o.cfg.agent, maxSteps: o.cfg.selfImprove.maxSteps } },
      ollama: o.ollama,
      tools: o.reviewTools,
      emit: () => {
        /* review is silent; changes are logged below */
      },
      prompt: buildDigest(o),
      systemOverride: REVIEW_SYSTEM,
    });
  } catch (err) {
    log.warn(`self-improve review error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (o.applied.length > 0) {
    log.info(`self-improve: ${o.applied.join(" | ")}`);
    appendLearning({
      at: new Date().toISOString(),
      task: o.prompt.slice(0, 200),
      applied: o.applied,
    });
  }

  // Forced pass: if a genuinely new command-line tool was used and the review
  // did not turn it into a skill, require one — self-teaching must not depend
  // on the reviewer's mood.
  const wroteSkill = o.applied.some((a) => a.includes("skill_create") || a.includes("skill_patch"));
  if (!wroteSkill && o.cfg.selfImprove.enabled) {
    const found = detectNewTool(o.toolTrace);
    if (found) {
      log.info(`self-improve: new tool "${found.tool}" detected — forcing a skill`);
      try {
        await runAgent({
          cfg: { ...o.cfg, agent: { ...o.cfg.agent, maxSteps: Math.max(6, o.cfg.selfImprove.maxSteps) } },
          ollama: o.ollama,
          tools: o.reviewTools,
          emit: () => {
            /* silent */
          },
          prompt: [
            `TOOL TO DOCUMENT: ${found.tool}`,
            `EVIDENCE (a command from the finished task): ${found.evidence}`,
            "",
            buildDigest(o),
          ].join("\n"),
          systemOverride: FORCE_SKILL_SYSTEM,
        });
      } catch (err) {
        log.warn(`forced skill pass failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (o.applied.length > 0) {
        log.info(`self-improve (forced): ${o.applied.join(" | ")}`);
        appendLearning({ at: new Date().toISOString(), task: o.prompt.slice(0, 200), applied: o.applied });
      }
    } else {
      const pitfall = detectSkillPitfall(o.toolTrace, o.prompt);
      if (pitfall) {
        log.info(`self-improve: pitfall on existing skill "${pitfall.skillName}" — forcing skill_patch upgrade`);
        try {
          await runAgent({
            cfg: { ...o.cfg, agent: { ...o.cfg.agent, maxSteps: Math.max(6, o.cfg.selfImprove.maxSteps) } },
            ollama: o.ollama,
            tools: o.reviewTools,
            emit: () => {
              /* silent */
            },
            prompt: [
              `SKILL TO UPGRADE: ${pitfall.skillName}`,
              `OBSERVED FAILURE / PITFALL: ${pitfall.failure}`,
              "",
              buildDigest(o),
            ].join("\n"),
            systemOverride: FORCE_PATCH_SYSTEM,
          });
        } catch (err) {
          log.warn(`forced skill_patch pass failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (o.applied.length > 0) {
          log.info(`self-improve (patched): ${o.applied.join(" | ")}`);
          appendLearning({ at: new Date().toISOString(), task: o.prompt.slice(0, 200), applied: o.applied });
        }
      }
    }
  }
  return o.applied;
}
