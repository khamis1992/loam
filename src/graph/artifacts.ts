/**
 * Neo N13: the files a document/webpage node can hand over as an artifact.
 *
 * A `webpage` node on the canvas is a *site* the agent produced, not just a page:
 * it points at a directory (`data.path`, e.g. `site/` or `dist/`) whose assets
 * have to travel with the page for the download to open offline. This module
 * resolves that directory and packages it with the same writer the deploy/export
 * path uses (`src/preview/zip.ts`), so a node ZIP and a task export are the same
 * archive format.
 *
 * Nothing here invents files:
 *   - the directory is always inside the task workspace (`isInside`), and
 *   - text files captured as node *versions* (see `nodeVersions.ts`) are merged in
 *     when the archive is missing them, so a ZIP still carries a page the agent
 *     wrote even if the workspace was cleaned.
 */
import fs from "node:fs";
import path from "node:path";
import { collectFiles, zipBuffer, type ZipEntry } from "../preview/zip.js";
import { resolveBuildOutput } from "../preview/deploy.js";
import { isInside } from "../policy/paths.js";

/** A node whose payload may point at a directory of files. */
export interface ArtifactNode {
  id: string;
  type: string;
  data?: unknown;
}

/** A resolved artifact directory plus the entry page inside it, when known. */
export interface ResolvedArtifact {
  /** Absolute directory to package. */
  dir: string;
  /** Page to open first, relative to `dir` with forward slashes. */
  entry: string;
  /** True when the directory came from the node payload rather than a fallback. */
  explicit: boolean;
}

/** Read the payload keys a node may use to name its own files. */
const PATH_KEYS = ["path", "dir", "directory", "root", "outDir", "projectDir"] as const;

function readKey(data: unknown, keys: readonly string[]): string {
  if (typeof data !== "object" || data === null) return "";
  const record = data as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** True when a path exists and is a file. */
function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/** True when a path exists and is a directory. */
function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** The `index.html` of a directory, or the first HTML file, else "". */
export function entryPage(dir: string): string {
  const index = path.join(dir, "index.html");
  if (isFile(index)) return "index.html";
  try {
    for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.isFile() && item.name.toLowerCase().endsWith(".html")) return item.name;
    }
  } catch {
    /* unreadable directory: no entry page */
  }
  return "";
}

/**
 * Resolve the directory a node's artifact lives in.
 *
 * Order: the node's own `path`/`dir` (absolute, or relative to the task
 * workspace), then the workspace's build output (`dist`, `build`, `out`, `www`
 * or a root `index.html`). A node that names a file resolves to its directory, so
 * `site/index.html` and `site/` both package the same site.
 */
export function resolveArtifactDir(node: ArtifactNode, taskRoot: string): ResolvedArtifact | undefined {
  const root = path.resolve(taskRoot);
  const raw = readKey(node.data, PATH_KEYS);
  if (raw) {
    const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
    if (isInside(root, candidate)) {
      const dir = isFile(candidate) ? path.dirname(candidate) : candidate;
      if (isDirectory(dir)) return { dir, entry: entryPage(dir), explicit: true };
    }
  }
  // No usable path on the node: fall back to the workspace build output, which
  // is where a scaffolded site or a built app lands.
  const built = resolveBuildOutput(root);
  if (built && isDirectory(built.dir)) return { dir: built.dir, entry: entryPage(built.dir), explicit: false };
  if (isDirectory(root) && entryPage(root)) return { dir: root, entry: entryPage(root), explicit: false };
  return undefined;
}

/** Staging copies live under `.loam` and must never ship inside an archive. */
function packageFilter(rel: string): boolean {
  return !rel.split("/").some((part) => part.startsWith(".loam"));
}

/**
 * Build the ZIP of one artifact directory.
 *
 * `extra` entries are merged in by archive path: a captured file version only
 * fills a gap the live directory does not already cover, so the archive always
 * reflects the workspace first and the captured text second.
 *
 * With `prefix`, every path is rewritten under one directory (`<prefix>/...`),
 * so the archive extracts into a folder instead of scattering files into the
 * current directory. The entry list is sorted either way, which keeps two
 * archives of the same tree byte-identical: a download is reproducible.
 */
export function buildArtifactZip(
  dir: string,
  options: { prefix?: string; extra?: readonly ZipEntry[] } = {},
): Buffer {
  const prefix = options.prefix ? options.prefix.replace(/[\\/]+$/, "") : "";
  const join = (name: string): string =>
    prefix.length > 0 ? `${prefix}/${name.replace(/^\/+/, "")}` : name;
  const entries = collectFiles(dir, { filter: packageFilter }).map((entry) => ({
    name: join(entry.name),
    data: entry.data,
  }));
  const seen = new Set(entries.map((entry) => entry.name));
  for (const entry of options.extra ?? []) {
    const name = join(entry.name.replace(/\\/g, "/"));
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    entries.push({ name, data: entry.data });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return zipBuffer(entries);
}

/** The captured text files of a node, as archive entries keyed by basename. */
export function capturedFileEntries(
  files: ReadonlyArray<{ title: string; content: string }>,
): ZipEntry[] {
  const entries: ZipEntry[] = [];
  const used = new Set<string>();
  for (const file of files) {
    const base = path.basename(file.title || "file.txt").replace(/\\/g, "/");
    let name = base || "file.txt";
    let n = 2;
    while (used.has(name)) name = `${n++}-${base}`;
    used.add(name);
    entries.push({ name, data: Buffer.from(file.content, "utf8") });
  }
  return entries;
}
