/**
 * Hand-off to and from other coding agents. Export writes one markdown file
 * into the workspace; import turns another tool's markdown notes into wiki
 * notes. Everything passes through the wiki's sanitize boundary on write.
 */
import fs from "node:fs";
import path from "node:path";
import { listHandoffs } from "./handoff.js";
import { slugify } from "./paths.js";
import { sanitizeText } from "./sanitize.js";
import { listPages, readPage, writePage } from "./store.js";

const MAX_FILES = 200;
const MAX_FILE_BYTES = 200_000;

/** Write `<workspace>/.loam/handoff/CURRENT.md`: open handoffs plus the latest session pages. */
export function exportCurrent(root: string, workspace: string, now = new Date()): string {
  const lines = [`# Loam handoff (${now.toISOString()})`, "", "## Open handoffs", ""];
  const open = listHandoffs(root, "open");
  if (!open.length) lines.push("None.");
  for (const h of open) lines.push(`- ${h.title} (${h.id})`);
  lines.push("", "## Recent sessions", "");
  const sessions = listPages(root, "session").sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 5);
  if (!sessions.length) lines.push("None.");
  for (const s of sessions) {
    const page = readPage(root, "session", s.id);
    lines.push(`### ${s.title}`, "", (page?.body ?? "").split("\n").slice(0, 20).join("\n"), "");
  }
  const file = path.join(workspace, ".loam", "handoff", "CURRENT.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, sanitizeText(lines.join("\n")) + "\n", "utf8");
  return file;
}

function importMarkdown(root: string, files: string[], tag: string): number {
  let n = 0;
  for (const file of files.slice(0, MAX_FILES)) {
    let text: string;
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) continue;
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const base = path.basename(file, path.extname(file));
    const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() || base;
    const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
    if (!body) continue;
    writePage(root, { kind: "note", id: `${tag}-${slugify(base, "note")}`, title, body, tags: ["imported", tag] });
    n++;
  }
  return n;
}

/** Import a Claude Code memory folder (`*.md`, skipping MEMORY.md) as notes. Returns the count. */
export function importClaude(root: string, dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f.toLowerCase() !== "memory.md").map((f) => path.join(dir, f));
  return importMarkdown(root, files, "claude");
}

/** Import a Codex `AGENTS.md` (or a folder holding one) as a note. Returns the count. */
export function importCodex(root: string, target: string): number {
  const file = fs.existsSync(target) && fs.statSync(target).isDirectory() ? path.join(target, "AGENTS.md") : target;
  return fs.existsSync(file) ? importMarkdown(root, [file], "codex") : 0;
}
