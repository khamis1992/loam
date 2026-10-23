// Auto-suggest repo-local skills after a successful session.
//
// A completed task often works out setup / verify / before-PR steps that are
// worth keeping. This module asks the model to turn the transcript digest into
// a concrete SKILL.md proposal, then stages it as a pending suggestion. The
// user accepts it (POST /api/pending/:id/approve) and only then is the file
// written under the project's repo-local skill root.
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import type { ChatMessage, OllamaClient } from "../ollama.js";
import type { ToolTraceItem } from "../agent/events.js";
import type { PendingItem, WriteGate } from "../server/pending.js";
import { buildSkillFile, slugify } from "./skills.js";

export const SKILL_SUGGEST_KIND = "skill_suggest" as const;

export interface SkillSuggestion {
  name: string;
  description: string;
  triggers: string[];
  content: string;
}

export interface ProposeOptions {
  projectRoot: string;
  digest: string;
  /** Model id ("" = the run's main model). */
  model?: string;
  /** Injectable model call (tests). Defaults to `ollama.chat`. */
  callModel?: (messages: ChatMessage[]) => Promise<string>;
  ollama?: Pick<OllamaClient, "chat">;
  /** When set the proposal is staged for approval instead of written. */
  gate?: WriteGate;
  /** Repo-local root to write into. Defaults to `.loam/skills`. */
  target?: string;
}

export interface ProposeResult {
  ok: boolean;
  content: string;
  suggestion?: SkillSuggestion;
  /** Set when the proposal was staged for approval. */
  pending?: PendingItem;
  /** Set when the proposal was written directly (no gate). */
  written?: string;
}

const SYSTEM = [
  "You propose repo-local skills for the project the agent just worked in.",
  "From the transcript digest, extract a reusable procedure worth keeping: the exact setup / verify / before-PR steps that worked, with commands and pitfalls.",
  "Reply with ONLY a JSON object of the form:",
  '{"name":"kebab-case-name","description":"one line: when to use this skill","triggers":["setup","verify"],"content":"Markdown body with When to Use / Procedure / Pitfalls / Verification."}',
  "If nothing durable or reusable was learned, reply with exactly {\"skip\":true}.",
].join("\n");

async function defaultCall(ollama: Pick<OllamaClient, "chat">, model: string, messages: ChatMessage[]): Promise<string> {
  const res = await ollama.chat({ model, messages, temperature: 0 });
  return res.content;
}

/** Extract the first JSON object from a model reply, tolerating code fences. */
export function parseSuggestion(raw: string): Record<string, unknown> | null {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  return null;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter((v) => v.length > 0);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

/** Build the full SKILL.md text (frontmatter + body) for a suggestion. */
export function renderSuggestion(s: SkillSuggestion): string {
  return buildSkillFile(s.name, s.description, s.content, s.triggers);
}

/** Ask the model for a skill proposal and stage it (gate) or write it. */
export async function proposeSkillSuggestion(opts: ProposeOptions): Promise<ProposeResult> {
  const digest = opts.digest.trim();
  if (!digest) return { ok: false, content: "skill_suggest requires a transcript digest" };
  const projectRoot = opts.projectRoot.trim();
  if (!projectRoot) return { ok: false, content: "skill_suggest requires a project_root" };

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: digest },
  ];
  let raw: string;
  try {
    raw = opts.callModel
      ? await opts.callModel(messages)
      : await defaultCall(opts.ollama!, opts.model ?? "", messages);
  } catch (err) {
    return { ok: false, content: `skill_suggest model failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const parsed = parseSuggestion(raw);
  if (!parsed) return { ok: false, content: "skill_suggest: model did not return a JSON proposal" };
  if (parsed["skip"] === true) return { ok: true, content: "skill_suggest: nothing reusable to propose" };

  const name = String(parsed["name"] ?? "").trim();
  const description = String(parsed["description"] ?? "").trim();
  const body = String(parsed["content"] ?? "").trim();
  if (!name || !description || !body) {
    return { ok: false, content: "skill_suggest: proposal is missing name, description or content" };
  }
  const triggers = toStringArray(parsed["triggers"]);
  const suggestion: SkillSuggestion = { name, description, triggers, content: renderSuggestion({ name, description, triggers, content: body }) };
  const target = opts.target === ".agents/skills" ? ".agents/skills" : ".loam/skills";

  if (opts.gate) {
    const pending = opts.gate.stage(SKILL_SUGGEST_KIND, `skill_suggest "${name}": ${description}`.slice(0, 200), {
      projectRoot,
      target,
      name,
      description,
      triggers,
      content: suggestion.content,
    });
    return {
      ok: true,
      suggestion,
      pending,
      content: `staged skill suggestion (id=${pending.id}): "${name}". It is NOT written yet — approve it at /learning.html or POST /api/pending/${pending.id}/approve`,
    };
  }

  const written = writeSuggestion({ projectRoot, target, name, content: suggestion.content });
  return { ok: true, suggestion, written, content: `wrote repo-local skill "${name}" → ${written}` };
}

export interface WriteSuggestionInput {
  projectRoot: string;
  target?: string;
  name: string;
  content: string;
}

/** Write a proposed SKILL.md into the project's repo-local skill root. */
export function writeSuggestion(input: WriteSuggestionInput): string {
  const target = input.target === ".agents/skills" ? ".agents/skills" : ".loam/skills";
  const dir = path.join(input.projectRoot, target, slugify(input.name));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(file, `${input.content.trimEnd()}\n`, "utf8");
  return `${target}/${slugify(input.name)}/SKILL.md`;
}

/** Apply a staged suggestion (called by the pending-approval route). */
export function acceptSkillSuggestion(item: PendingItem): string {
  const payload = item.payload as Record<string, unknown>;
  const projectRoot = String(payload["projectRoot"] ?? "").trim();
  const name = String(payload["name"] ?? "").trim();
  const content = String(payload["content"] ?? "");
  const target = payload["target"] === ".agents/skills" ? ".agents/skills" : ".loam/skills";
  if (!projectRoot || !name || !content.trim()) throw new Error("skill_suggest payload is incomplete");
  const written = writeSuggestion({ projectRoot, target, name, content });
  return `created repo-local skill "${name}" at ${written}`;
}

export interface AfterSessionOptions {
  cfg: Config;
  ollama: Pick<OllamaClient, "chat">;
  projectRoot: string;
  prompt: string;
  finalText: string;
  trace: ToolTraceItem[];
  gate?: WriteGate;
}

/** Build the digest the suggester sees from a finished task. */
export function buildSuggestDigest(o: Pick<AfterSessionOptions, "prompt" | "finalText" | "trace">): string {
  const trace =
    o.trace.length > 0
      ? o.trace
          .slice(-40)
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

/** After a successful session: propose a repo-local skill (staged for approval). */
export async function suggestSkillsAfterSession(o: AfterSessionOptions): Promise<ProposeResult | null> {
  const res = await proposeSkillSuggestion({
    projectRoot: o.projectRoot,
    digest: buildSuggestDigest(o),
    model: o.cfg.skills.suggestModel || o.cfg.model,
    ollama: o.ollama,
    gate: o.gate,
  });
  return res.ok ? res : null;
}
