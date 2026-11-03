// src/appbuilder/contextFiles.ts — MISSING §4.5.3 (contract) on the §4.5.2 formats.
// .loam/context/PROJECT.md, PROGRESS.md, ARCHITECTURE.md: skeleton creation,
// section replacement, plan rendering, verification summary, atomic writes.
import fs from "node:fs";
import path from "node:path";
import type { PlanDocument } from "./types.js";

export type ContextFileId = "PROJECT" | "PROGRESS" | "ARCHITECTURE";

export const CONTEXT_HEADINGS: Record<ContextFileId, string[]> = {
  PROJECT: ["## Overview", "## Key Decisions", "## Constraints", "## Out of Scope"],
  PROGRESS: ["## Requirements", "## User Stories", "## Tasks", "## Verification", "## Log"],
  ARCHITECTURE: ["## Overview", "## Stack", "## Modules", "## Data Model", "## Decisions", "## File Plan", "## Implementation Notes"],
};
export const CONTEXT_FILE_MAX_BYTES = 12_000;
export const CONTEXT_TOTAL_MAX_BYTES = 24_000;

/** Section owned by app_verify; model-driven updates refuse it (§4.5.3). */
const VERIFICATION_HEADING = "## Verification";

export interface ContextSectionUpdate {
  file: ContextFileId;
  /** Heading text exactly as in CONTEXT_HEADINGS, e.g. "## Constraints". */
  heading: string;
  /** Markdown body that replaces the section body. Must not contain "## " headings. */
  body: string;
}

const FILE_NAMES: Record<ContextFileId, string> = {
  PROJECT: "PROJECT.md",
  PROGRESS: "PROGRESS.md",
  ARCHITECTURE: "ARCHITECTURE.md",
};

/** Newest entries kept in "## Log"; older ones fold into one line (§4.5.2). */
const LOG_MAX_ENTRIES = 30;
/** Max characters of one log entry line `- YYYY-MM-DD: text` (§4.5.2). */
const LOG_ENTRY_MAX_CHARS = 300;

function contextDir(workspaceDir: string): string {
  return path.join(workspaceDir, ".loam", "context");
}

function fileAbs(workspaceDir: string, id: ContextFileId): string {
  return path.join(contextDir(workspaceDir), FILE_NAMES[id]);
}

// ---------- skeletons (§4.5.2, verbatim shapes; last_updated filled by the writer) ----------

function skeleton(id: ContextFileId, now: Date): string {
  const ts = now.toISOString();
  if (id === "PROJECT") {
    return [
      "---",
      `last_updated: ${ts}`,
      "status: active",
      "---",
      "# Project",
      "",
      "## Overview",
      "",
      "## Key Decisions",
      "| Date | Decision | By | Source | Rationale |",
      "|---|---|---|---|---|",
      "",
      "## Constraints",
      "",
      "## Out of Scope",
      "",
    ].join("\n");
  }
  if (id === "PROGRESS") {
    return [
      "---",
      `last_updated: ${ts}`,
      "---",
      "# Progress",
      "",
      "## Requirements",
      "",
      "## User Stories",
      "",
      "## Tasks",
      "| ID | Task | Role | Status | Deps |",
      "|---|---|---|---|---|",
      "",
      VERIFICATION_HEADING,
      "",
      "## Log",
      "",
    ].join("\n");
  }
  return [
    "---",
    `last_updated: ${ts}`,
    "---",
    "# Architecture",
    "",
    "## Overview",
    "",
    "## Stack",
    "",
    "## Modules",
    "| Module | Responsibility | Files |",
    "|---|---|---|",
    "",
    "## Data Model",
    "",
    "## Decisions",
    "| Decision | Choice | Rationale |",
    "|---|---|---|",
    "",
    "## File Plan",
    "",
    "## Implementation Notes",
    "",
  ].join("\n");
}

// ---------- atomic writes (§4.5.3: temp + fsync + rename, Windows retry) ----------

const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800];

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === "EPERM" || code === "EBUSY") && attempt < RENAME_RETRY_DELAYS_MS.length) {
        sleepSync(RENAME_RETRY_DELAYS_MS[attempt]!);
        continue;
      }
      try { fs.unlinkSync(from); } catch { /* best effort: drop the orphan temp file */ }
      throw err;
    }
  }
}

/** Write one temp file (`<name>.tmp-<pid>-<rand>`), fsync, keep it for a later rename. */
function writeTemp(abs: string, content: string): string {
  const dir = path.dirname(abs);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${path.basename(abs)}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return tmp;
}

function atomicWrite(abs: string, content: string): void {
  renameWithRetry(writeTemp(abs, content), abs);
}

/** Render all files to temp names first; rename only after every temp write succeeded (§4.5.3). */
function atomicWriteAll(files: Array<{ abs: string; content: string }>): void {
  const temps: Array<{ tmp: string; abs: string }> = [];
  try {
    for (const f of files) temps.push({ tmp: writeTemp(f.abs, f.content), abs: f.abs });
  } catch (err) {
    for (const t of temps) { try { fs.unlinkSync(t.tmp); } catch { /* best effort */ } }
    throw err;
  }
  for (const t of temps) renameWithRetry(t.tmp, t.abs);
}

// ---------- frontmatter and sections ----------

interface ParsedFile { frontmatter: string[]; body: string }

function parseFile(text: string): ParsedFile {
  if (!text.startsWith("---\n")) return { frontmatter: ["---", "---"], body: text };
  const end = text.indexOf("\n---\n", 3);
  if (end === -1) return { frontmatter: ["---", "---"], body: text };
  const frontmatter = text.slice(0, end + 5).split("\n");
  // split keeps a trailing "" after the closing "---"; drop it, re-added on emit.
  if (frontmatter[frontmatter.length - 1] === "") frontmatter.pop();
  return { frontmatter, body: text.slice(end + 5) };
}

function emitFile(parsed: ParsedFile, now: Date): string {
  const lines = [...parsed.frontmatter];
  const stamp = `last_updated: ${now.toISOString()}`;
  const idx = lines.findIndex((l) => l.startsWith("last_updated:"));
  if (idx >= 0) lines[idx] = stamp;
  else lines.splice(1, 0, stamp);
  return `${lines.join("\n")}\n${parsed.body}`;
}

/** Replace one `## Heading` section body; null when the heading is absent. */
function replaceSection(body: string, heading: string, newBody: string): string | null {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith("## ")) { end = i; break; }
  }
  const out = [...lines.slice(0, start), heading, "", newBody.trim()];
  const rest = lines.slice(end);
  if (rest.length > 0) out.push("");
  return [...out, ...rest].join("\n");
}

function sectionBody(body: string, heading: string): string {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith("## ")) { end = i; break; }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

/** Fold "## Log" to the newest 30 entries, each capped at 300 chars (§4.5.2). */
function foldLog(parsed: ParsedFile): void {
  const entry = /^- \d{4}-\d{2}-\d{2}: /;
  const raw = sectionBody(parsed.body, "## Log").split("\n").filter((l) => l.trim().length > 0);
  const kept: string[] = [];
  let folded = 0;
  for (const line of raw) {
    const isEntry = entry.test(line);
    if (isEntry && kept.filter((k) => entry.test(k)).length >= LOG_MAX_ENTRIES) {
      folded += 1;
      continue;
    }
    kept.push(line.length > LOG_ENTRY_MAX_CHARS ? line.slice(0, LOG_ENTRY_MAX_CHARS) : line);
  }
  if (folded > 0) kept.push(`- Earlier: ${folded} entries, see version history.`);
  parsed.body = replaceSection(parsed.body, "## Log", kept.join("\n")) ?? parsed.body;
}

// ---------- public API ----------

/** Read all three for a role's starting context. Missing files are created from skeletons. */
export function readContext(workspaceDir: string): Record<ContextFileId, string> {
  const now = new Date();
  const out = {} as Record<ContextFileId, string>;
  for (const id of Object.keys(FILE_NAMES) as ContextFileId[]) {
    const abs = fileAbs(workspaceDir, id);
    if (!fs.existsSync(abs)) atomicWrite(abs, skeleton(id, now));
    out[id] = fs.readFileSync(abs, "utf8");
  }
  return out;
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/**
 * Applies updates to the files in memory, validates, then writes atomically
 * (temp + rename). Refuses `## Verification` (owned by app_verify) and bodies
 * that introduce `## ` headings; enforces the per-file and total byte caps.
 */
export function applyContextUpdates(
  workspaceDir: string,
  updates: ContextSectionUpdate[],
  now = new Date(),
): { ok: true; bytes: Record<ContextFileId, number> } | { ok: false; error: string } {
  if (updates.length === 0) return { ok: false, error: "no updates given" };
  if (updates.length > 16) return { ok: false, error: "at most 16 updates per call" };
  const parsed: Record<ContextFileId, ParsedFile> = {} as Record<ContextFileId, ParsedFile>;
  for (const id of Object.keys(FILE_NAMES) as ContextFileId[]) {
    parsed[id] = parseFile(readContext(workspaceDir)[id]!);
  }
  const touched = new Set<ContextFileId>();
  for (const u of updates) {
    const headings = CONTEXT_HEADINGS[u.file];
    if (!headings) return { ok: false, error: `unknown context file ${String(u.file)}` };
    if (!headings.includes(u.heading)) return { ok: false, error: `${u.file} has no section ${u.heading}` };
    if (u.heading === VERIFICATION_HEADING) return { ok: false, error: "## Verification is written by app_verify only" };
    if (u.body.split("\n").some((l) => l.startsWith("## "))) {
      return { ok: false, error: `${u.file} ${u.heading}: body must not contain "## " headings` };
    }
    const next = replaceSection(parsed[u.file]!.body, u.heading, u.body);
    if (next === null) return { ok: false, error: `${u.file} has no section ${u.heading}` };
    parsed[u.file]!.body = next;
    touched.add(u.file);
  }
  if (touched.has("PROGRESS")) foldLog(parsed.PROGRESS!);
  const rendered: Record<ContextFileId, string> = {} as Record<ContextFileId, string>;
  const bytes: Record<ContextFileId, number> = {} as Record<ContextFileId, number>;
  let total = 0;
  for (const id of Object.keys(FILE_NAMES) as ContextFileId[]) {
    rendered[id] = emitFile(parsed[id]!, now);
    bytes[id] = byteLength(rendered[id]!);
    total += bytes[id]!;
    if (bytes[id]! > CONTEXT_FILE_MAX_BYTES) {
      return { ok: false, error: `${FILE_NAMES[id]} would be ${bytes[id]} bytes, over the ${CONTEXT_FILE_MAX_BYTES} limit. Shorten the section and try again.` };
    }
  }
  if (total > CONTEXT_TOTAL_MAX_BYTES) {
    return { ok: false, error: `the three context files would be ${total} bytes together, over the ${CONTEXT_TOTAL_MAX_BYTES} limit. Shorten them and try again.` };
  }
  atomicWriteAll([...touched].map((id) => ({ abs: fileAbs(workspaceDir, id), content: rendered[id]! })));
  return { ok: true, bytes };
}

function decisionTable(doc: PlanDocument): string {
  return doc.keyDecisions
    .map((d) => `| ${d.date} | ${d.decision} | Lead | ${d.source} | ${d.rationale} |`)
    .join("\n");
}

function list(items: readonly string[]): string {
  return items.map((s) => `- ${s}`).join("\n");
}

function taskTable(doc: PlanDocument): string {
  return doc.tasks
    .map((t) => `| ${t.id} | ${t.title} | ${t.role} | ${t.status} | ${t.deps.length ? t.deps.join(", ") : "—"} |`)
    .join("\n");
}

/**
 * Lead approval path: render all three files from an approved PlanDocument and
 * write them atomically — all three temp files first, then the renames (§4.5.3).
 */
export function writeAllFromPlan(workspaceDir: string, doc: PlanDocument, now = new Date()): void {
  const day = now.toISOString().slice(0, 10);
  const project: ParsedFile = {
    frontmatter: ["---", `last_updated: ${now.toISOString()}`, "status: active", "---"],
    body: [
      "# Project",
      "",
      "## Overview",
      doc.overview,
      "",
      "## Key Decisions",
      "| Date | Decision | By | Source | Rationale |",
      "|---|---|---|---|---|",
      decisionTable(doc),
      "",
      "## Constraints",
      list(doc.constraints),
      "",
      "## Out of Scope",
      "",
    ].join("\n"),
  };
  const progress: ParsedFile = {
    frontmatter: ["---", `last_updated: ${now.toISOString()}`, "---"],
    body: [
      "# Progress",
      "",
      "## Requirements",
      list(doc.requirements),
      "",
      "## User Stories",
      list(doc.userStories),
      "",
      "## Tasks",
      "| ID | Task | Role | Status | Deps |",
      "|---|---|---|---|---|",
      taskTable(doc),
      "",
      VERIFICATION_HEADING,
      "",
      "## Log",
      `- ${day}: Plan "${doc.title}" approved; ${doc.tasks.length} tasks created.`,
      "",
    ].join("\n"),
  };
  const architecture: ParsedFile = {
    frontmatter: ["---", `last_updated: ${now.toISOString()}`, "---"],
    body: [
      "# Architecture",
      "",
      "## Overview",
      doc.overview,
      "",
      "## Stack",
      `Template: ${doc.templateId}. Features: ${doc.features.length ? doc.features.join(", ") : "none"}.`,
      "",
      "## Modules",
      "| Module | Responsibility | Files |",
      "|---|---|---|",
      "",
      "## Data Model",
      "",
      "## Decisions",
      "| Decision | Choice | Rationale |",
      "|---|---|---|",
      doc.keyDecisions.map((d) => `| ${d.decision} | ${d.source} | ${d.rationale} |`).join("\n"),
      "",
      "## File Plan",
      "",
      "## Implementation Notes",
      "",
    ].join("\n"),
  };
  atomicWriteAll([
    { abs: fileAbs(workspaceDir, "PROJECT"), content: emitFile(project, now) },
    { abs: fileAbs(workspaceDir, "PROGRESS"), content: emitFile(progress, now) },
    { abs: fileAbs(workspaceDir, "ARCHITECTURE"), content: emitFile(architecture, now) },
  ]);
}

/** Replace only "## Verification" in PROGRESS.md. Called by app_verify. */
export function writeVerificationSummary(workspaceDir: string, summary: string, now = new Date()): void {
  const abs = fileAbs(workspaceDir, "PROGRESS");
  const parsed = parseFile(fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : skeleton("PROGRESS", now));
  const next = replaceSection(parsed.body, VERIFICATION_HEADING, summary);
  if (next !== null) parsed.body = next;
  atomicWrite(abs, emitFile(parsed, now));
}
