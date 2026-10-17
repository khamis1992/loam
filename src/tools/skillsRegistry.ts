// Skills catalog (aitmpl.com / claude-code-templates) for manus-local.
//
// Skills live in a GitHub repo under <basePath>/<category>/<name>/SKILL.md.
// The whole catalog is enumerated with ONE git-trees request (cached in
// data/skills-catalog.json), then file contents are fetched from
// raw.githubusercontent (not subject to the GitHub API rate limit).
// Set GITHUB_TOKEN to raise the API limit.

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, SKILLS_DIR } from "../config.js";

export const REGISTRY = {
  owner: "davila7",
  repo: "claude-code-templates",
  ref: "main",
  basePath: "cli-tool/components/skills",
  label: "aitmpl.com",
};

const CACHE_FILE = path.join(DATA_DIR, "skills-catalog.json");
const TTL_MS = 6 * 60 * 60 * 1000;

export interface CatalogFile {
  path: string;
  size: number;
}

export interface CatalogSkill {
  id: string;
  name: string;
  files: CatalogFile[];
}

export interface Catalog {
  fetchedAt: number;
  truncated: boolean;
  skills: CatalogSkill[];
}

export interface CatalogHit {
  id: string;
  files: number;
  description?: string;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    "user-agent": "manus-local",
    accept: "application/vnd.github+json",
  };
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

async function httpText(url: string, extra: Record<string, string> = {}): Promise<string> {
  const res = await fetch(url, { headers: { ...headers(), ...extra } });
  const body = await res.text();
  if (!res.ok) {
    const hint = res.status === 403 || res.status === 429 ? " (GitHub rate limit; set GITHUB_TOKEN)" : "";
    throw new Error(`registry request failed: ${res.status}${hint}`);
  }
  return body;
}

function readCache(): Catalog | null {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as Catalog;
    return raw && Array.isArray(raw.skills) ? raw : null;
  } catch {
    return null;
  }
}

export async function getCatalog(refresh = false): Promise<Catalog> {
  if (!refresh) {
    const cached = readCache();
    if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached;
  }
  const url =
    `https://api.github.com/repos/${REGISTRY.owner}/${REGISTRY.repo}/git/trees/` +
    `${encodeURIComponent(`${REGISTRY.ref}:${REGISTRY.basePath}`)}?recursive=1`;
  const tree = JSON.parse(await httpText(url)) as {
    truncated?: boolean;
    tree?: Array<{ path: string; type: string; size?: number }>;
  };
  const blobs = (tree.tree ?? []).filter((n) => n.type === "blob");
  const ids = [
    ...new Set(
      blobs
        .filter((n) => n.path.endsWith("/SKILL.md"))
        .map((n) => n.path.slice(0, -"/SKILL.md".length)),
    ),
  ].sort();
  const skills: CatalogSkill[] = ids.map((id) => ({
    id,
    name: id.split("/").pop() ?? id,
    files: blobs
      .filter((n) => n.path.startsWith(`${id}/`))
      .map((n) => ({ path: n.path.slice(id.length + 1), size: n.size ?? 0 })),
  }));
  const catalog: Catalog = { fetchedAt: Date.now(), truncated: Boolean(tree.truncated), skills };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(catalog), "utf8");
  } catch {
    /* cache is best-effort */
  }
  return catalog;
}

const descCache = new Map<string, string>();

async function describeSkill(id: string): Promise<string> {
  const cached = descCache.get(id);
  if (cached !== undefined) return cached;
  let description = "";
  try {
    const url =
      `https://raw.githubusercontent.com/${REGISTRY.owner}/${REGISTRY.repo}/${REGISTRY.ref}/` +
      `${REGISTRY.basePath}/${id}/SKILL.md`;
    const raw = await httpText(url);
    const m = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(raw);
    const line = m ? /^description\s*:\s*(.+)$/m.exec(m[1] ?? "") : null;
    description = (line?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
  } catch {
    /* leave empty */
  }
  descCache.set(id, description);
  return description;
}

export interface SearchOptions {
  query?: string;
  limit?: number;
  describe?: number;
  refresh?: boolean;
}

export async function searchCatalog(opts: SearchOptions = {}): Promise<{
  source: string;
  total: number;
  shown: number;
  skills: CatalogHit[];
}> {
  const catalog = await getCatalog(opts.refresh === true);
  const q = (opts.query ?? "").trim().toLowerCase();
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 200);
  const matches = (q ? catalog.skills.filter((s) => s.id.toLowerCase().includes(q)) : catalog.skills).slice(0, limit);
  const describe = Math.min(Math.max(opts.describe ?? 0, 0), matches.length, 25);
  const described = await Promise.all(matches.slice(0, describe).map((s) => describeSkill(s.id)));
  const skills: CatalogHit[] = matches.map((s, i) => ({
    id: s.id,
    files: s.files.length,
    ...(i < describe ? { description: described[i] } : {}),
  }));
  return { source: REGISTRY.label, total: catalog.skills.length, shown: skills.length, skills };
}

export function resolveSkillId(id: string): string {
  const clean = id.trim().replace(/^\/+|\/+$/g, "");
  if (!/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*){1,4}$/.test(clean)) {
    throw new Error(`skill id must look like '<category>/<name>', got: ${id}`);
  }
  return clean;
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export interface InstallResult {
  id: string;
  name: string;
  dir: string;
  files: string[];
}

/** Download a catalog skill into skills/<name>/ (never executes anything). */
export async function installFromCatalog(input: { id: string; force?: boolean }): Promise<InstallResult> {
  const id = resolveSkillId(input.id);
  let entry = (await getCatalog()).skills.find((s) => s.id === id);
  if (!entry) entry = (await getCatalog(true)).skills.find((s) => s.id === id);
  if (!entry) throw new Error(`no skill "${id}" in the ${REGISTRY.label} catalog`);

  const dir = path.join(SKILLS_DIR, entry.name);
  if (fs.existsSync(path.join(dir, "SKILL.md")) && input.force !== true) {
    throw new Error(`skill "${entry.name}" already exists (pass force=true to overwrite)`);
  }
  const written: string[] = [];
  for (const file of entry.files) {
    const rel = file.path.split("\\").join("/");
    if (!rel || rel.split("/").includes("..")) continue;
    const abs = path.join(dir, rel);
    if (!isInside(dir, abs)) continue;
    const url =
      `https://raw.githubusercontent.com/${REGISTRY.owner}/${REGISTRY.repo}/${REGISTRY.ref}/` +
      `${REGISTRY.basePath}/${id}/${rel}`;
    const body = await httpText(url);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, "utf8");
    written.push(rel);
  }
  if (!written.includes("SKILL.md")) throw new Error("SKILL.md was not downloaded");
  return { id, name: entry.name, dir, files: written };
}

export async function listCatalogSample(limit = 5): Promise<CatalogHit[]> {
  const { skills } = await searchCatalog({ limit, describe: 0 });
  return skills;
}
