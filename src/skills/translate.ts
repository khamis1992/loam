// src/skills/translate.ts — (MISSING §6.6 reference implementation, tested on the box)
import fs from "node:fs";
import path from "node:path";

/** Export a Loam skill to another agent's format. Lossy fields are reported, never silently dropped. */
export type ExportTarget = "agents-skill" | "cursor-mdc" | "windsurf-rule" | "copilot-instructions";
export interface ExportResult { target: ExportTarget; relPath: string; content: string; lossy: string[]; }

function splitFrontmatter(raw: string): { fm: Record<string, string>; body: string } {
  const m = /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/.exec(raw);
  if (!m) return { fm: {}, body: raw };
  const fm: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) { const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line); if (kv) fm[kv[1]!] = kv[2]!.trim(); }
  return { fm, body: raw.slice(m[0].length) };
}
const yamlStr = (s: string) => JSON.stringify(s); // JSON strings are valid YAML scalars (safe for Arabic and colons)

export function exportSkill(skillDir: string, target: ExportTarget, slug: string): ExportResult {
  const raw = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
  const { fm, body } = splitFrontmatter(raw);
  const name = fm.name ?? slug, description = fm.description ?? "";
  const extraFiles = fs.readdirSync(skillDir).filter((f) => f !== "SKILL.md");
  const lossy = target === "agents-skill" ? [] : [...(fm.triggers ? ["triggers"] : []), ...(extraFiles.length ? [`supporting files: ${extraFiles.join(", ")}`] : [])];
  switch (target) {
    case "agents-skill":
      return { target, relPath: `.agents/skills/${slug}/SKILL.md`, content: raw, lossy };
    case "cursor-mdc":
      return { target, relPath: `.cursor/rules/${slug}.mdc`, lossy,
        content: `---\ndescription: ${yamlStr(description)}\nglobs:\nalwaysApply: false\n---\n# ${name}\n\n${body.trim()}\n` };
    case "windsurf-rule":
      return { target, relPath: `.windsurf/rules/${slug}.md`, lossy,
        content: `---\ntrigger: model_decision\ndescription: ${yamlStr(description)}\n---\n# ${name}\n\n${body.trim()}\n` };
    case "copilot-instructions":
      return { target, relPath: `.github/instructions/${slug}.instructions.md`, lossy,
        content: `---\napplyTo: "**"\n---\n# ${name}\n\n${description ? `${description}\n\n` : ""}${body.trim()}\n` };
  }
}
