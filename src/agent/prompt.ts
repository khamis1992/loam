import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";

export interface Skill {
  name: string;
  description: string;
  body: string;
}

export function loadSkills(dir: string): Skill[] {
  const out: Skill[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, "utf8");
    const m = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
    let name = entry.name;
    let description = "";
    let body = raw;
    if (m) {
      const fm = m[1] ?? "";
      body = m[2] ?? "";
      for (const line of fm.split(/\r?\n/)) {
        const mm = /^(name|description)\s*:\s*(.+)$/.exec(line);
        if (mm) {
          if (mm[1] === "name") name = mm[2]!.trim();
          else description = mm[2]!.trim();
        }
      }
    }
    out.push({ name, description, body: body.trim() });
  }
  return out;
}

export interface RecalledMemory {
  text: string;
  score: number;
}

export function buildSystemPrompt(
  cfg: Config,
  skills: Skill[],
  toolNames: string[],
  memories: RecalledMemory[] = [],
  extraContext?: string,
): string {
  const lines: string[] = [
    "You are Loam, a local assistant working in the current task's isolated workspace.",
    "Reply in the user's language. Use the provided tools and observed results; never invent success.",
    "Only the tools listed below are available in this mode. Do not bypass missing capabilities through another tool.",
    "Files and history belong to this task only. Do not inspect parent directories or other task workspaces.",
    "Verify every output before reporting completion. If a dependency is unavailable, state the limitation plainly.",
    "Keep secrets out of responses. Ask for missing input when it prevents a reliable result.",
    "Do not send messages, submit forms, purchase, or publish unless the user's request authorizes that action.",
    `Workspace: ${cfg.workspace}`,
    `Network access: ${cfg.policy.networkEnabled ? "enabled" : "disabled"}`,
    `Available tools (${toolNames.length}): ${toolNames.join(", ")}`,
  ];
  if (toolNames.includes("browser_table")) lines.push("Browser workflow: open page, inspect browser_table, then act on observed indexes and inspect again. Never guess selectors or report actions without evidence.");
  if (toolNames.includes("shell_run")) lines.push("Commands run on the user's machine. Stay within this task's workspace, avoid destructive commands, and verify the result.");
  if (toolNames.includes("loam_dataset")) lines.push("Use loam_dataset to calculate CSV statistics. Report missing values and assumptions; never invent data.");
  if (toolNames.includes("loam_document")) lines.push("Use loam_document for Markdown or printable HTML. Do not label HTML or Markdown as a native office document.");
  if (toolNames.includes("loam_studio")) lines.push("For documents, presentations and spreadsheets, prefer loam_studio: the user sees and edits this live canvas next to the conversation. Read the current artifact and revision first. Preserve existing user content; generate incrementally with small append calls (one slide, a few blocks or rows), using each returned revision. On a revision conflict read again and merge the requested change with the user's latest edits. Never write .loam/studio.json through file tools. Native DOCX/PPTX/XLSX export is available from the studio UI; finish by reading and verifying the artifact. Use loam_document only when Markdown or HTML is explicitly requested.");
  if (toolNames.includes("loam_canvas")) lines.push("loam_canvas produces vector SVG artwork, not generated photographs. File tools can create custom SVG or HTML designs.");
  if (memories.length > 0) {
    lines.push("Context explicitly supplied by this task:");
    for (const memory of memories) lines.push(memory.text);
  }
  if (extraContext?.trim()) lines.push(extraContext.trim());
  if (toolNames.includes("skill_view") && skills.length > 0) {
    lines.push("Available skills:");
    for (const skill of skills) lines.push(`- ${skill.name}: ${skill.description}`);
  }
  return lines.join("\n");
}
