/**
 * Loam UI Kit block registry (V9).
 *
 * The registry is a content library of vetted UI blocks that an agent can copy
 * into a generated web app instead of inventing markup from scratch. Every
 * block lives in `design-registry/blocks/<id>/` and carries a `manifest.json`
 * that describes what it is, where it came from (license) and how to build it.
 *
 * This module is the single source of truth for the manifest contract: it
 * validates manifests, enumerates the registry, compiles each block so a
 * broken block fails the check, and scores blocks for retrieval (the primitive
 * behind `ui_examples_search`). It is deliberately dependency-light so it can
 * run from `node --test` and from the `check:design-registry` gate.
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.js";

export const DESIGN_REGISTRY_DIR = path.join(ROOT, "design-registry");
export const BLOCKS_DIR = path.join(DESIGN_REGISTRY_DIR, "blocks");

/** Bump when the manifest shape changes in a way old manifests cannot express. */
export const MANIFEST_SCHEMA = "loam-design-block/1";

export const BLOCK_CATEGORIES = [
  "hero",
  "bento",
  "pricing",
  "dashboard",
  "auth",
  "table",
  "settings",
  "empty-state",
  "features",
  "cta",
  "social-proof",
  "stats",
  "gallery",
  "blog",
  "faq",
  "contact",
  "navigation",
  "footer",
  "logos",
  "comparison",
  "newsletter",
  "team",
  "timeline",
  "onboarding",
  "chart",
] as const;

export type BlockCategory = (typeof BLOCK_CATEGORIES)[number];

/** Only permissive sources are allowed: shadcn blocks (MIT) or Loam originals. */
export const BLOCK_LICENSES = ["MIT", "original"] as const;
export type BlockLicense = (typeof BLOCK_LICENSES)[number];

export interface BlockManifest {
  schema: string;
  id: string;
  name: string;
  description: string;
  category: BlockCategory;
  license: BlockLicense;
  source: string;
  tags: string[];
  intent: string;
  deps: string[];
  rtl: boolean;
  dir: "ltr" | "rtl";
  lang: string;
  /** Screenshot path relative to the block dir, or the literal "pending". */
  screenshot: string;
  entry: string;
  files: string[];
  /** For RTL variants: the LTR block this one mirrors. */
  base?: string;
}

export interface ManifestIssue {
  block: string;
  field: string;
  message: string;
}

export interface BlockRecord {
  id: string;
  dir: string;
  dirPath: string;
  manifest: BlockManifest;
}

export interface BuildIssue {
  block: string;
  message: string;
}

export interface BuildResult {
  ok: boolean;
  built: number;
  issues: BuildIssue[];
}

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
/** Tags are single words: Latin kebab-case, or Arabic letters/digits. */
const TAG_RE = /^[a-z0-9][a-z0-9-]*$|^[\u0600-\u06FF0-9][\u0600-\u06FF0-9-]*$/;
const ARABIC_WORD_RE = /^[\u0600-\u06FF0-9][\u0600-\u06FF0-9-]*$/;
const ARABIC_RE = /[\u0600-\u06FF]/g;

const CATEGORY_SET = new Set<string>(BLOCK_CATEGORIES);
const LICENSE_SET = new Set<string>(BLOCK_LICENSES);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Read and parse a block manifest, returning null when it is unreadable. */
export function readManifest(blockDir: string): BlockManifest | null {
  const file = path.join(blockDir, "manifest.json");
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!isObj(raw)) return null;
    return raw as unknown as BlockManifest;
  } catch {
    return null;
  }
}

/** Enumerate block directory names (excluding dotfiles and non-directories). */
export function listBlockDirs(blocksRoot = BLOCKS_DIR): string[] {
  if (!fs.existsSync(blocksRoot)) return [];
  return fs
    .readdirSync(blocksRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

/**
 * Validate one manifest against the contract. `blockDir` is the absolute path so
 * the validator can confirm referenced files exist on disk. Returns every issue
 * it finds (never throws) so a single run can report the whole registry.
 */
export function validateManifest(
  manifest: unknown,
  blockDir: string,
  dirName: string,
): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  const at = (field: string, message: string) => issues.push({ block: dirName, field, message });

  if (!isObj(manifest)) {
    at("manifest", "manifest.json must contain a JSON object");
    return issues;
  }

  const m = manifest;

  if (m["schema"] !== MANIFEST_SCHEMA) {
    at("schema", `must be "${MANIFEST_SCHEMA}"`);
  }

  const id = str(m["id"]);
  if (!ID_RE.test(id)) {
    at("id", `must match ${ID_RE.source}`);
  } else if (id !== dirName) {
    at("id", `must equal its directory name "${dirName}"`);
  }

  if (str(m["name"]).trim().length === 0) at("name", "must be a non-empty string");
  if (str(m["description"]).trim().length < 20) {
    at("description", "must describe the block in at least 20 characters");
  }

  const category = str(m["category"]);
  if (!CATEGORY_SET.has(category)) {
    at("category", `must be one of: ${BLOCK_CATEGORIES.join(", ")}`);
  }

  const license = str(m["license"]);
  if (!LICENSE_SET.has(license)) {
    at("license", `must be one of: ${BLOCK_LICENSES.join(", ")} (shadcn MIT or Loam original)`);
  }

  if (str(m["source"]).trim().length === 0) at("source", "must name the origin (shadcn/ui or Loam)");

  const tags = strs(m["tags"]);
  if (tags.length === 0) {
    at("tags", "must contain at least one tag");
  } else {
    for (const tag of tags) {
      if (!TAG_RE.test(tag)) at("tags", `tag "${tag}" must be kebab-case Latin or Arabic letters`);
    }
  }

  if (str(m["intent"]).trim().length === 0) at("intent", "must state the block's design intent");

  const deps = strs(m["deps"]);
  if (deps.length === 0) at("deps", "must list at least one dependency (e.g. react)");
  for (const dep of deps) {
    if (dep.trim().length === 0) at("deps", "dependency names must be non-empty");
  }

  const rtl = m["rtl"] === true;
  const dir = str(m["dir"]);
  if (dir !== (rtl ? "rtl" : "ltr")) {
    at("dir", `must be "${rtl ? "rtl" : "ltr"}" when rtl=${rtl}`);
  }

  const lang = str(m["lang"]);
  if (rtl && lang !== "ar") at("lang", 'must be "ar" for an RTL block');
  if (!rtl && lang !== "en") at("lang", 'must be "en" for an LTR block');

  const screenshot = str(m["screenshot"]);
  if (screenshot.trim().length === 0) {
    at("screenshot", 'must be a screenshot path or the literal "pending"');
  } else if (screenshot !== "pending") {
    const shotPath = path.join(blockDir, screenshot);
    if (!fs.existsSync(shotPath)) {
      at("screenshot", `referenced screenshot "${screenshot}" does not exist`);
    }
  }

  const entry = str(m["entry"]);
  if (!entry.endsWith(".tsx")) {
    at("entry", "must point at a .tsx component file");
  } else if (!fs.existsSync(path.join(blockDir, entry))) {
    at("entry", `entry file "${entry}" does not exist`);
  }

  const files = strs(m["files"]);
  if (files.length === 0) {
    at("files", "must list the block's files");
  } else {
    if (!files.includes(entry)) at("files", 'must include the "entry" file');
    for (const file of files) {
      if (!fs.existsSync(path.join(blockDir, file))) {
        at("files", `referenced file "${file}" does not exist`);
      }
    }
  }

  if (rtl) {
    const base = str(m["base"]);
    if (base.length === 0) {
      at("base", "an RTL variant must declare the LTR block it mirrors");
    }
    const entryPath = path.join(blockDir, entry);
    if (fs.existsSync(entryPath)) {
      const source = fs.readFileSync(entryPath, "utf8");
      const arabic = source.match(ARABIC_RE)?.length ?? 0;
      if (arabic < 10) {
        at("entry", `RTL block must contain real Arabic copy (found ${arabic} Arabic characters)`);
      }
      if (!/dir=["']rtl["']/.test(source)) {
        at("entry", 'RTL block must set dir="rtl" on its root element');
      }
    }
    // Arabic keywords make the block findable in the user's own language; a
    // block that only carries Latin keywords is effectively invisible to an
    // Arabic query, so require at least one Arabic tag on every RTL block.
    const hasArabicTag = strs(m["tags"]).some((tag) => ARABIC_WORD_RE.test(tag));
    if (!hasArabicTag) {
      at("tags", "an RTL block must carry at least one Arabic tag (e.g. تسعير)");
    }
  }

  return issues;
}

/** Validate a whole registry, checking cross-block invariants (ids, bases). */
export function validateRegistry(
  blocksRoot = BLOCKS_DIR,
): { records: BlockRecord[]; issues: ManifestIssue[] } {
  const records: BlockRecord[] = [];
  const issues: ManifestIssue[] = [];
  const seen = new Map<string, string>();

  for (const dirName of listBlockDirs(blocksRoot)) {
    const blockDir = path.join(blocksRoot, dirName);
    const manifest = readManifest(blockDir);
    if (!manifest) {
      issues.push({ block: dirName, field: "manifest", message: "manifest.json is missing or unreadable" });
      continue;
    }
    issues.push(...validateManifest(manifest, blockDir, dirName));

    const id = manifest.id || dirName;
    if (seen.has(id)) {
      issues.push({ block: dirName, field: "id", message: `duplicate block id (also in "${seen.get(id)}")` });
    } else {
      seen.set(id, dirName);
    }
    records.push({ id, dir: dirName, dirPath: blockDir, manifest });
  }

  for (const record of records) {
    const base = record.manifest.base;
    if (base && !seen.has(base)) {
      issues.push({
        block: record.dir,
        field: "base",
        message: `base block "${base}" does not exist`,
      });
    }
    if (base && seen.get(base) === record.dir) {
      issues.push({ block: record.dir, field: "base", message: "base block cannot reference itself" });
    }
  }

  return { records, issues };
}

/**
 * Compile a block's entry component with esbuild so a block that no longer
 * builds fails the registry gate. React and friends stay external (the block
 * is copied into a generated app that provides them); local imports are bundled
 * and syntax-checked.
 */
export async function buildBlock(blockDir: string): Promise<{ ok: boolean; message: string }> {
  const manifest = readManifest(blockDir);
  if (!manifest) return { ok: false, message: "missing manifest.json" };
  const entry = path.join(blockDir, manifest.entry);
  if (!fs.existsSync(entry)) return { ok: false, message: `missing entry ${manifest.entry}` };

  try {
    const esbuild = (await import("esbuild")).default;
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2020",
      jsx: "automatic",
      logLevel: "silent",
      external: ["react", "react-dom", "react/jsx-runtime", "react-dom/client"],
    });
    return { ok: true, message: "" };
  } catch (err) {
    const anyErr = err as { errors?: Array<{ text?: string }>; message?: string };
    const detail = anyErr.errors?.map((e) => e.text).filter(Boolean).join("; ") ?? anyErr.message ?? String(err);
    return { ok: false, message: detail };
  }
}

/** Build every block; returns a per-block pass/fail summary. */
export async function buildRegistry(blocksRoot = BLOCKS_DIR): Promise<BuildResult> {
  const issues: BuildIssue[] = [];
  let built = 0;
  for (const dirName of listBlockDirs(blocksRoot)) {
    const result = await buildBlock(path.join(blocksRoot, dirName));
    if (result.ok) built += 1;
    else issues.push({ block: dirName, message: result.message });
  }
  return { ok: issues.length === 0, built, issues };
}

// --- retrieval -------------------------------------------------------------

const STOPWORDS = new Set([
  "a", "an", "the", "for", "and", "or", "to", "of", "with", "in", "on", "at", "ui", "page",
  "block", "component", "section", "layout", "design",
  // Arabic particles and prepositions carry no retrieval signal.
  "من", "في", "على", "إلى", "عن", "أن", "إن", "هذا", "هذه", "ذلك", "التي", "الذي",
  "مع", "أو", "لا", "ما", "هو", "هي", "كان", "كل", "بعد", "قبل", "عند", "غير",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export interface ScoredBlock {
  id: string;
  score: number;
  manifest: BlockManifest;
}

/** Block hit returned to the model by `ui_examples_search`. */
export interface BlockHit {
  id: string;
  name: string;
  category: string;
  description: string;
  tags: string[];
  intent: string;
  deps: string[];
  rtl: boolean;
  lang: string;
  /** Entry file path relative to the block directory. */
  entry: string;
  /** Screenshot path relative to the block directory, or null when pending. */
  screenshot: string | null;
  license: string;
  source: string;
  /** Short representative source snippet from the entry component. */
  code?: string;
  score: number;
}

export interface SearchBlockOptions {
  /** Restrict results to one category (e.g. "pricing"). */
  category?: string;
  /** Restrict results to LTR (false) or RTL (true) blocks. */
  rtl?: boolean;
}

/**
 * Rank blocks for a free-text query. Weights favour the block's name and tags,
 * then category/intent, then the long description; every term is IDF-weighted
 * so common words ("dashboard") matter less than distinctive ones ("bento").
 * This is the scoring primitive `ui_examples_search` is expected to call.
 */
export function searchBlocks(query: string, k = 3, blocksRoot = BLOCKS_DIR, options: SearchBlockOptions = {}): ScoredBlock[] {
  const { records, issues } = validateRegistry(blocksRoot);
  if (issues.length > 0) {
    throw new Error(`registry is invalid: ${issues.map((i) => `${i.block}.${i.field}: ${i.message}`).join("; ")}`);
  }

  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];

  const docs = records.map((record) => {
    const m = record.manifest;
    const fields: Array<{ weight: number; text: string }> = [
      { weight: 3, text: m.name },
      { weight: 2, text: m.tags.join(" ") },
      { weight: 2, text: m.category },
      { weight: 1, text: m.intent },
      { weight: 1, text: m.description },
    ];
    const counts = new Map<string, number>();
    let total = 0;
    for (const field of fields) {
      for (const token of tokenize(field.text)) {
        counts.set(token, (counts.get(token) ?? 0) + field.weight);
        total += field.weight;
      }
    }
    return { record, counts, total };
  });

  const n = docs.length;
  const scored: ScoredBlock[] = [];
  for (const doc of docs) {
    if (options.category && doc.record.manifest.category !== options.category) continue;
    if (options.rtl !== undefined && doc.record.manifest.rtl !== options.rtl) continue;
    let score = 0;
    for (const term of terms) {
      const tf = doc.counts.get(term);
      if (!tf) continue;
      const df = docs.filter((d) => d.counts.has(term)).length;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += (tf / doc.total) * idf;
    }
    if (score > 0) scored.push({ id: doc.record.id, score, manifest: doc.record.manifest });
  }

  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored.slice(0, k);
}

/** Read the block entry component, returning null when it is missing/unreadable. */
function readEntry(blockDir: string, entry: string): string | null {
  try {
    const file = path.join(blockDir, entry);
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Trim a component source to a bounded snippet the model can adapt. */
function snippet(source: string, maxChars: number): string {
  const compact = source.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars).trimEnd()}\n// …`;
}

/**
 * Convert a scored record into the model-facing hit shape, attaching the entry
 * file path, screenshot path and a short code snippet.
 */
export function toBlockHit(scored: ScoredBlock, blockRoot = BLOCKS_DIR, maxSnippet = 1200): BlockHit {
  const m = scored.manifest;
  const blockDir = path.join(blockRoot, scored.id);
  const source = readEntry(blockDir, m.entry);
  return {
    id: m.id,
    name: m.name,
    category: m.category,
    description: m.description,
    tags: m.tags,
    intent: m.intent,
    deps: m.deps,
    rtl: m.rtl,
    lang: m.lang,
    entry: m.entry,
    screenshot: m.screenshot === "pending" ? null : m.screenshot,
    license: m.license,
    source: m.source,
    ...(source ? { code: snippet(source, maxSnippet) } : {}),
    score: Number(scored.score.toFixed(4)),
  };
}
