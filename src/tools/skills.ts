import fs from "node:fs";
import path from "node:path";
import { SKILLS_DIR } from "../config.js";
import type { WriteGate } from "../server/pending.js";
import { gateActive } from "../server/settings.js";
import type { Tool, ToolResult } from "./registry.js";
import { bool, num, str } from "./registry.js";
import { installFromCatalog, searchCatalog } from "./skillsRegistry.js";

export interface SkillRecord {
  name: string;
  description: string;
  dir: string;
  file: string;
}

export type SkillMutation = "skill_create" | "skill_patch" | "skill_delete" | "skill_install";

function slugify(input: string): string {
  const s = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, 60) || "skill";
}

export function parseFrontmatter(raw: string): { name?: string; description?: string } {
  const m = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  const out: { name?: string; description?: string } = {};
  if (!m) return out;
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const mm = /^(name|description)\s*:\s*(.+)$/.exec(line);
    if (!mm) continue;
    const val = mm[2]!.trim();
    if (mm[1] === "name") out.name = val;
    else out.description = val;
  }
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

function findRecord(name: string): SkillRecord | undefined {
  const target = name.trim().toLowerCase();
  return listSkillRecords().find(
    (r) => r.name.toLowerCase() === target || path.basename(r.dir).toLowerCase() === target,
  );
}

export function buildSkillFile(name: string, description: string, body: string): string {
  const desc = description.trim() || "Procedure the agent loads when relevant.";
  return `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body.trim()}\n`;
}

export interface SkillView {
  name: string;
  description: string;
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
  return { name: rec.name, description: fm.description ?? "", body, file: rec.file, content };
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
  const { onApply, gate } = opts;

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
        "List installed skills (name + description). Call this before creating a skill so you improve an existing one instead of duplicating it.",
      parameters: { type: "object", properties: {} },
      async run(): Promise<ToolResult> {
        const recs = listSkillRecords();
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
        const rec = findRecord(str(args, "name"));
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
  ];
}
