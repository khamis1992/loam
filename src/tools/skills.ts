import fs from "node:fs";
import path from "node:path";
import { SKILLS_DIR } from "../config.js";
import { loadSkills, type Skill } from "../agent/prompt.js";
import type { WriteGate } from "../server/pending.js";
import { gateActive } from "../server/settings.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { bool, num, str } from "./registry.js";
import { installFromCatalog, searchCatalog } from "./skillsRegistry.js";
import { proposeSkillSuggestion, type ProposeResult } from "./skillSuggest.js";
import type { OllamaClient } from "../ollama.js";

export interface SkillRecord {
  name: string;
  description: string;
  dir: string;
  file: string;
}

export type SkillMutation = "skill_create" | "skill_patch" | "skill_delete" | "skill_install";

/** Repo-local skill roots, in precedence order (first wins on a name clash). */
export const REPO_SKILL_ROOTS = [".loam/skills", ".agents/skills"] as const;

/** A skill discovered inside the project folder (`.loam/skills` or `.agents/skills`). */
export interface RepoSkillRecord extends SkillRecord {
  /** Frontmatter `triggers:` values (comma/newline/JSON list). */
  triggers: string[];
  /** Which repo-local root the skill came from. */
  source: string;
}

export function slugify(input: string): string {
  const s = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, 60) || "skill";
}

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  triggers?: string[];
}

/** Parse a `triggers:` value: JSON array, bracketed list, comma list, or a
 *  following YAML block (`- item`). Empty/blank entries are dropped. */
export function parseTriggers(raw: string): string[] {
  let value = raw.trim();
  if (!value) return [];
  const list: string[] = [];
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (inner) {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (Array.isArray(parsed)) return parsed.map((t) => String(t).trim()).filter((t) => t.length > 0);
      } catch {
        /* fall through to delimiter splitting on the inner text */
      }
      value = inner;
    } else {
      return [];
    }
  }
  for (const part of value.split(/[,\n]/)) {
    const clean = part.trim().replace(/^[-*]\s*/, "").replace(/^["']|["']$/g, "");
    if (clean.length > 0) list.push(clean);
  }
  return list;
}

export function parseFrontmatter(raw: string): SkillFrontmatter {
  const m = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  const out: SkillFrontmatter = {};
  if (!m) return out;
  const lines = (m[1] ?? "").split(/\r?\n/);
  let collectingTriggers = false;
  const triggerItems: string[] = [];
  for (const line of lines) {
    const listItem = /^\s*[-*]\s+(.+)$/.exec(line);
    if (collectingTriggers && listItem) {
      triggerItems.push(listItem[1]!.trim());
      continue;
    }
    collectingTriggers = false;
    const mm = /^(name|description|triggers)\s*:\s*(.*)$/.exec(line);
    if (!mm) continue;
    const key = mm[1]!;
    const val = (mm[2] ?? "").trim();
    if (key === "name") out.name = val;
    else if (key === "description") out.description = val;
    else {
      const inline = parseTriggers(val);
      if (inline.length > 0) {
        out.triggers = inline;
      } else {
        collectingTriggers = true;
        triggerItems.length = 0;
      }
    }
  }
  if (out.triggers === undefined && triggerItems.length > 0) out.triggers = triggerItems;
  return out;
}

export function listSkillRecords(): SkillRecord[] {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  const out: SkillRecord[] = [];
  for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(SKILLS_DIR, entry.name);
    const file = path.join(dir, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const fm = parseFrontmatter(fs.readFileSync(file, "utf8"));
    out.push({ name: fm.name ?? entry.name, description: fm.description ?? "", dir, file });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface DiscoveryResult {
  skills: RepoSkillRecord[];
  /** Human-readable reasons a candidate SKILL.md was skipped. */
  warnings: string[];
}

/** Discover repo-local skills under `<projectRoot>/.loam/skills` and
 *  `<projectRoot>/.agents/skills`. A SKILL.md without a valid frontmatter
 *  `name` is ignored and reported in `warnings` (never silently loaded). */
export function discoverRepoSkills(projectRoot: string): DiscoveryResult {
  const skills: RepoSkillRecord[] = [];
  const warnings: string[] = [];
  if (!projectRoot || !fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    return { skills, warnings };
  }
  for (const root of REPO_SKILL_ROOTS) {
    const base = path.join(projectRoot, root);
    if (!fs.existsSync(base)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      warnings.push(`cannot read ${root}`);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(base, entry.name);
      const file = path.join(dir, "SKILL.md");
      if (!fs.existsSync(file)) continue;
      let raw: string;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch {
        warnings.push(`cannot read ${root}/${entry.name}/SKILL.md`);
        continue;
      }
      const fm = parseFrontmatter(raw);
      const name = (fm.name ?? "").trim();
      if (!name) {
        warnings.push(`${root}/${entry.name}/SKILL.md has no valid frontmatter name; ignored`);
        continue;
      }
      skills.push({
        name,
        description: (fm.description ?? "").trim(),
        triggers: fm.triggers ?? [],
        dir,
        file,
        source: root,
      });
    }
  }
  return { skills, warnings };
}

export interface ProjectSkillRecords {
  records: SkillRecord[];
  warnings: string[];
}

/** Repo-local skills merged over the global `skills/` dir. Repo-local wins on
 *  a name clash (`.loam/skills` before `.agents/skills`). */
export function listProjectSkillRecords(projectRoot: string): ProjectSkillRecords {
  const { skills, warnings } = discoverRepoSkills(projectRoot);
  const records: SkillRecord[] = skills.map((s) => ({
    name: s.name,
    description: s.description,
    dir: s.dir,
    file: s.file,
  }));
  const seen = new Set(records.map((r) => r.name.toLowerCase()));
  for (const global of listSkillRecords()) {
    if (seen.has(global.name.toLowerCase())) continue;
    seen.add(global.name.toLowerCase());
    records.push(global);
  }
  return { records: records.sort((a, b) => a.name.localeCompare(b.name)), warnings };
}

export interface ProjectSkills {
  skills: Skill[];
  warnings: string[];
}

/** Skills for the system prompt: repo-local bodies first, then global ones not
 *  shadowed by a repo-local skill of the same name. */
export function loadProjectSkills(projectRoot: string): ProjectSkills {
  const { skills, warnings } = discoverRepoSkills(projectRoot);
  const out: Skill[] = [];
  for (const s of skills) {
    const content = fs.readFileSync(s.file, "utf8");
    const body = content.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, "");
    out.push({ name: s.name, description: s.description, body: body.trim() });
  }
  const seen = new Set(out.map((s) => s.name.toLowerCase()));
  for (const global of loadSkills(SKILLS_DIR)) {
    if (seen.has(global.name.toLowerCase())) continue;
    seen.add(global.name.toLowerCase());
    out.push(global);
  }
  return { skills: out, warnings };
}


function findRecord(name: string): SkillRecord | undefined {
  const target = name.trim().toLowerCase();
  return listSkillRecords().find(
    (r) => r.name.toLowerCase() === target || path.basename(r.dir).toLowerCase() === target,
  );
}

export function buildSkillFile(name: string, description: string, body: string, triggers: string[] = []): string {
  const desc = description.trim() || "Procedure the agent loads when relevant.";
  const clean = [...new Set(triggers.map((t) => t.trim()).filter((t) => t.length > 0))];
  const triggersLine = clean.length > 0 ? `triggers: ${clean.join(", ")}\n` : "";
  return `---\nname: ${name}\ndescription: ${desc}\n${triggersLine}---\n\n${body.trim()}\n`;
}

export interface SkillView {
  name: string;
  description: string;
  triggers: string[];
  body: string;
  file: string;
  content: string;
}

/** Read one skill split into frontmatter fields and body (for the UI editor). */
export function readSkillFile(name: string): SkillView | null {
  const rec = findRecord(name);
  if (!rec) return null;
  const content = fs.readFileSync(rec.file, "utf8");
  const fm = parseFrontmatter(content);
  const body = content.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, "");
  return { name: rec.name, description: fm.description ?? "", triggers: fm.triggers ?? [], body, file: rec.file, content };
}

/** Validate a mutation without applying it. Returns an error string, or null when valid. */
export function validateSkill(kind: SkillMutation, payload: Record<string, unknown>): string | null {
  if (kind === "skill_install") {
    return str(payload, "id").trim() ? null : "skill_install requires an id (category/name)";
  }
  const name = str(payload, "name").trim();
  if (!name) return `${kind} requires a name`;
  if (kind === "skill_create") {
    const dirName = slugify(name);
    if (fs.existsSync(path.join(SKILLS_DIR, dirName, "SKILL.md")) && !bool(payload, "overwrite")) {
      return `skill "${name}" already exists; use skill_patch to improve it, or pass overwrite=true`;
    }
    if (!str(payload, "content").trim()) return "skill_create requires content";
    return null;
  }
  const rec = findRecord(name);
  if (!rec) return `skill not found: ${name}`;
  if (kind === "skill_patch") {
    const full = payload["content"];
    const hasFull = typeof full === "string" && full.trim().length > 0;
    if (!hasFull && !str(payload, "old_string")) return "skill_patch needs old_string/new_string or content";
  }
  return null;
}

/** Apply a skill mutation directly (used by the tools and by approval of staged writes). */
export function applySkill(kind: SkillMutation, payload: Record<string, unknown>): ToolResult {
  const invalid = validateSkill(kind, payload);
  if (invalid) return { ok: false, content: invalid };
  if (kind === "skill_install") {
    return { ok: false, content: "skill_install downloads asynchronously; it is applied via the skill_install tool or POST /api/skills/install" };
  }
  const name = str(payload, "name").trim();

  if (kind === "skill_create") {
    const dirName = slugify(name);
    const dir = path.join(SKILLS_DIR, dirName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), buildSkillFile(name, str(payload, "description"), str(payload, "content")), "utf8");
    return { ok: true, content: `created skill "${name}" at skills/${dirName}/SKILL.md` };
  }

  const rec = findRecord(name)!;
  if (kind === "skill_delete") {
    fs.rmSync(rec.dir, { recursive: true, force: true });
    return { ok: true, content: `deleted skill "${rec.name}"` };
  }

  const full = payload["content"];
  if (typeof full === "string" && full.trim().length > 0) {
    fs.writeFileSync(rec.file, `${full.trimEnd()}\n`, "utf8");
    return { ok: true, content: `rewrote skill "${rec.name}"` };
  }
  const oldS = str(payload, "old_string");
  const newS = str(payload, "new_string");
  const raw = fs.readFileSync(rec.file, "utf8");
  const first = raw.indexOf(oldS);
  if (first < 0) return { ok: false, content: "old_string not found in skill" };
  if (raw.indexOf(oldS, first + oldS.length) >= 0) {
    return { ok: false, content: "old_string matches more than once; add more surrounding context" };
  }
  fs.writeFileSync(rec.file, raw.slice(0, first) + newS + raw.slice(first + oldS.length), "utf8");
  return { ok: true, content: `patched skill "${rec.name}"` };
}

export interface SkillToolOptions {
  onApply?: (label: string) => void;
  gate?: WriteGate;
  /** Active project folder; repo-local skills (`.loam/skills`, `.agents/skills`) are listed/loaded from here. */
  projectRoot?: string;
  /** Model client used by the `skill_suggest` tool. */
  ollama?: Pick<OllamaClient, "chat">;
}

function summarize(kind: SkillMutation, payload: Record<string, unknown>): string {
  const name = str(payload, "name");
  if (kind === "skill_create") return `skill_create "${name}": ${str(payload, "description").slice(0, 120)}`;
  if (kind === "skill_delete") return `skill_delete "${name}"`;
  return `skill_patch "${name}"${typeof payload["content"] === "string" ? " (rewrite)" : ""}`;
}

/** Agent-managed skills = procedural memory, persisted under skills/<name>/SKILL.md.
 *  When a WriteGate is supplied, mutations are staged for human approval. */
export function createSkillTools(opts: SkillToolOptions = {}): Tool[] {
  const { onApply, gate, projectRoot, ollama } = opts;

  const findVisibleRecord = (name: string): SkillRecord | undefined => {
    if (projectRoot) {
      const rec = listProjectSkillRecords(projectRoot).records.find(
        (r) => r.name.toLowerCase() === name.trim().toLowerCase() || path.basename(r.dir).toLowerCase() === name.trim().toLowerCase(),
      );
      if (rec) return rec;
    }
    return findRecord(name);
  };

  const mutate = (kind: SkillMutation, args: Record<string, unknown>): ToolResult => {
    const invalid = validateSkill(kind, args);
    if (invalid) return { ok: false, content: invalid };
    if (gate && gateActive()) {
      const item = gate.stage(kind, summarize(kind, args), args);
      onApply?.(`staged ${summarize(kind, args)} (${item.id})`);
      return {
        ok: true,
        content: `staged for approval (id=${item.id}): ${summarize(kind, args)}. It is NOT applied yet — approve it at /learning.html or POST /api/pending/${item.id}/approve`,
      };
    }
    const res = applySkill(kind, args);
    if (res.ok) onApply?.(`${kind} ${str(args, "name")}`);
    return res;
  };

  return [
    {
      name: "skill_list",
      description:
        "List installed skills (name + description), including repo-local skills from .loam/skills and .agents/skills. Call this before creating a skill so you improve an existing one instead of duplicating it.",
      parameters: { type: "object", properties: {} },
      async run(): Promise<ToolResult> {
        const recs = projectRoot ? listProjectSkillRecords(projectRoot).records : listSkillRecords();
        if (recs.length === 0) return { ok: true, content: "(no skills installed)" };
        return {
          ok: true,
          content: recs.map((r) => `- ${r.name}: ${r.description || "(no description)"}`).join("\n"),
        };
      },
    },
    {
      name: "skill_view",
      description: "Read the full content of one skill so you can follow it or patch it.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      async run(args: Record<string, unknown>): Promise<ToolResult> {
        const rec = findVisibleRecord(str(args, "name"));
        if (!rec) return { ok: false, content: `skill not found: ${str(args, "name")}` };
        return { ok: true, content: fs.readFileSync(rec.file, "utf8") };
      },
    },
    {
      name: "skill_create",
      description:
        "Create a new skill (procedural memory). Use it when you worked out a reusable multi-step procedure. A skill is the most correct/efficient way to do a class of task: ordered steps, the exact tool calls that work, pitfalls, and how to verify. Keep it concise.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short kebab-case name." },
          description: { type: "string", description: "One line: WHEN to use this skill." },
          content: {
            type: "string",
            description: "Markdown body with sections: When to Use / Procedure / Pitfalls / Verification.",
          },
          overwrite: { type: "boolean", description: "Replace an existing skill with the same name." },
        },
        required: ["name", "description", "content"],
      },
      async run(args: Record<string, unknown>): Promise<ToolResult> {
        return mutate("skill_create", args);
      },
    },
    {
      name: "skill_patch",
      description:
        "Improve an existing skill. Either replace the whole SKILL.md by passing content, or do a targeted edit with old_string/new_string (old_string must occur exactly once in the file).",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          content: { type: "string", description: "Full new SKILL.md (replaces the file)." },
        },
        required: ["name"],
      },
      async run(args: Record<string, unknown>): Promise<ToolResult> {
        return mutate("skill_patch", args);
      },
    },
    {
      name: "skill_delete",
      description: "Delete a skill by name.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      async run(args: Record<string, unknown>): Promise<ToolResult> {
        return mutate("skill_delete", args);
      },
    },
    {
      name: "skill_search",
      description:
        "Search the aitmpl.com skills catalog (900+ ready skills) and return ids of the form category/name. Prefer installing a proven skill with skill_install over writing one from scratch when a match exists.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Substring matched against id, e.g. pdf, react, data." },
          limit: { type: "number", description: "Max results (default 30)." },
          describe: { type: "number", description: "How many results to describe (default 5)." },
          refresh: { type: "boolean", description: "Force a catalog refresh." },
        },
      },
      async run(args: Record<string, unknown>): Promise<ToolResult> {
        try {
          const res = await searchCatalog({
            query: str(args, "query"),
            limit: num(args, "limit", 30),
            describe: num(args, "describe", 5),
            refresh: bool(args, "refresh"),
          });
          if (res.skills.length === 0) {
            return { ok: true, content: `(no matches; ${res.total} skills in ${res.source})` };
          }
          const lines = res.skills.map((s) => `- ${s.id}${s.description ? `: ${s.description}` : ""}`);
          return { ok: true, content: `${lines.join("\n")}\n(${res.shown}/${res.total} from ${res.source})` };
        } catch (err) {
          return { ok: false, content: err instanceof Error ? err.message : String(err) };
        }
      },
    },
    {
      name: "skill_install",
      description:
        "Install a skill from the aitmpl.com catalog into skills/. Get the id from skill_search. The files are third-party instructions: read the SKILL.md (skill_view) before relying on it.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "category/name from skill_search." },
          force: { type: "boolean", description: "Overwrite an existing skill with the same name." },
        },
        required: ["id"],
      },
      async run(args: Record<string, unknown>): Promise<ToolResult> {
        const id = str(args, "id").trim();
        if (!id) return { ok: false, content: "skill_install requires an id (category/name)" };
        if (gate && gateActive()) {
          const item = gate.stage("skill_install", `skill_install "${id}"`, { id, force: bool(args, "force") });
          onApply?.(`staged skill_install ${id} (${item.id})`);
          return {
            ok: true,
            content: `staged for approval (id=${item.id}): install "${id}". Approve at /learning.html or POST /api/pending/${item.id}/approve`,
          };
        }
        try {
          const res = await installFromCatalog({ id, force: bool(args, "force") });
          onApply?.(`skill_install ${id}`);
          return { ok: true, content: `installed "${id}" → skills/${res.name}/ (${res.files.length} file(s))` };
        } catch (err) {
          return { ok: false, content: err instanceof Error ? err.message : String(err) };
        }
      },
    },
    {
      name: "skill_suggest",
      description:
        "Propose a new repo-local skill from a task transcript digest (setup/verify/before-PR steps that were worked out). The proposal is staged as a pending suggestion the user can accept; it is never written silently.",
      parameters: {
        type: "object",
        properties: {
          digest: { type: "string", description: "Transcript digest: the task, the commands that worked, and how it was verified." },
          project_root: { type: "string", description: "Project folder to write into. Defaults to the active workspace." },
        },
        required: ["digest"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        if (!ollama) return { ok: false, content: "skill_suggest is unavailable: no model client" };
        const root = str(args, "project_root").trim() || projectRoot || "";
        if (!root) return { ok: false, content: "skill_suggest requires a project_root" };
        const res: ProposeResult = await proposeSkillSuggestion({
          projectRoot: root,
          digest: str(args, "digest"),
          model: ctx.cfg.model,
          ollama,
          gate,
        });
        onApply?.(res.ok ? `skill_suggest ${res.suggestion?.name ?? ""}` : "skill_suggest failed");
        return { ok: res.ok, content: res.content };
      },
    },
  ];
}
