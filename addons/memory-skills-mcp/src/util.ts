import crypto from "node:crypto";
import path from "node:path";

export function envValue(name: string): string | undefined {
  const v = process.env[name];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

export interface Paths {
  dataDir: string;
  skillsDir: string;
  dbFile: string;
}

export function resolvePaths(): Paths {
  const cwd = process.cwd();
  const manusData = envValue("MANUS_LOCAL_DATA_DIR");
  const dataDir =
    envValue("MEMSKILLS_DATA_DIR") ?? (manusData ? path.join(manusData, "memory-skills") : path.join(cwd, "data", "memory-skills"));
  const skillsDir = envValue("MEMSKILLS_SKILLS_DIR") ?? envValue("MANUS_LOCAL_SKILLS_DIR") ?? path.join(cwd, "skills");
  return { dataDir, skillsDir, dbFile: path.join(dataDir, "memory-skills.db") };
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

export function slugify(input: string): string {
  const s = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, 60) || "skill";
}

export function sha1(text: string): string {
  return crypto.createHash("sha1").update(text, "utf8").digest("hex");
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

export function splitFrontmatter(raw: string): { body: string } {
  return { body: raw.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, "").trim() };
}

export function buildSkillFile(name: string, description: string, body: string): string {
  const desc = description.trim() || "Procedure the agent loads when relevant.";
  return `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body.trim()}\n`;
}

export function snippet(text: string, n = 240): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

export function str(args: Record<string, unknown>, key: string, fallback = ""): string {
  const v = args[key];
  return typeof v === "string" ? v : fallback;
}

export function num(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function stringArray(value: unknown, max = 40): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const t = item.trim();
    if (t.length > 0) out.push(t.slice(0, 500));
    if (out.length >= max) break;
  }
  return out;
}

export function parseStringList(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export interface FailureNote {
  at: string;
  outcome: string;
  note: string;
}

export function parseNotes(raw: unknown): FailureNote[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
      .map((x) => ({
        at: typeof x["at"] === "string" ? x["at"] : "",
        outcome: typeof x["outcome"] === "string" ? x["outcome"] : "failure",
        note: typeof x["note"] === "string" ? x["note"] : "",
      }))
      .filter((n) => n.note.length > 0);
  } catch {
    return [];
  }
}

export function daysSince(iso: string): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.round((Date.now() - t) / 86_400_000));
}
