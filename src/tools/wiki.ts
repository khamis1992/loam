/**
 * Repo wiki (DeepWiki-like) + ask_codebase.
 *
 * `generateWiki` builds a wiki for a workspace: an overview page, an
 * architecture page, one page per major directory/module, plus any pages the
 * user steers via `.loam/wiki.json` ({ repo_notes, pages: [{ title, purpose,
 * parent? }] }). Every page carries deterministic source links (path:line)
 * computed from the workspace symbol index, so the links are always real even
 * when the model prose is thin. The wiki is stored under data/wikis/<project>.
 *
 * `askCodebase` answers a question using the stored wiki plus a codebase
 * search (the registry's file_search tool when available, else a built-in
 * grep fallback) and cites existing files.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import type { ChatMessage } from "../ollama.js";
import type { Tool, ToolContext, ToolRegistry, ToolResult } from "./registry.js";
import { str } from "./registry.js";
import { buildWorkspaceIndex, type FileOutline } from "./symbols.js";

export interface WikiPageConfig {
  title: string;
  purpose?: string;
  parent?: string;
}

export interface WikiConfig {
  project?: string;
  repo_notes?: string[];
  pages?: WikiPageConfig[];
}

export interface WikiSourceLink {
  path: string;
  line: number;
  label?: string;
}

export interface WikiPage {
  title: string;
  slug: string;
  parent?: string;
  purpose?: string;
  content: string;
  sources: WikiSourceLink[];
}

export interface WikiIndex {
  project: string;
  generatedAt: string;
  pages: WikiPage[];
}

/** Minimal model surface so tests can inject a fake without a live server. */
export interface WikiModelClient {
  chat(opts: { model: string; messages: ChatMessage[] }): Promise<{ content: string }>;
}

export interface CodeSearchHit {
  path: string;
  line: number;
  snippet: string;
}

export type CodeSearchFn = (workspace: string, query: string) => Promise<CodeSearchHit[]>;

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "coverage", "release", "vendor", "target"]);

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "page";
}

export function wikiRoot(project: string): string {
  return path.join(DATA_DIR, "wikis", project);
}

export function loadWikiConfig(workspace: string): WikiConfig {
  const file = path.join(path.resolve(workspace), ".loam", "wiki.json");
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<WikiConfig>;
    return {
      project: typeof parsed.project === "string" ? parsed.project : undefined,
      repo_notes: Array.isArray(parsed.repo_notes) ? parsed.repo_notes.filter((n): n is string => typeof n === "string") : [],
      pages: Array.isArray(parsed.pages)
        ? parsed.pages
            .filter((p): p is WikiPageConfig => !!p && typeof p.title === "string" && p.title.trim().length > 0)
            .map((p) => ({
              title: p.title.trim(),
              ...(typeof p.purpose === "string" ? { purpose: p.purpose } : {}),
              ...(typeof p.parent === "string" ? { parent: p.parent } : {}),
            }))
        : [],
    };
  } catch {
    return { repo_notes: [], pages: [] };
  }
}

export function listWikiProjects(): string[] {
  const root = path.join(DATA_DIR, "wikis");
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export function readWikiIndex(project: string): WikiIndex | null {
  try {
    const raw = fs.readFileSync(path.join(wikiRoot(project), "index.json"), "utf8");
    return JSON.parse(raw) as WikiIndex;
  } catch {
    return null;
  }
}

export function writeWikiIndex(index: WikiIndex): void {
  const dir = wikiRoot(index.project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(index, null, 2), "utf8");
  for (const page of index.pages) {
    fs.writeFileSync(path.join(dir, `${page.slug}.md`), page.content, "utf8");
  }
}

function relPath(workspace: string, p: string): string {
  const abs = path.resolve(p);
  const rel = path.relative(path.resolve(workspace), abs).split(path.sep).join("/");
  return rel.startsWith("..") ? abs : rel;
}

function linksForFiles(files: FileOutline[], limit = 8): WikiSourceLink[] {
  const links: WikiSourceLink[] = [];
  for (const f of files) {
    const sym = f.symbols.find((s) => s.exported) ?? f.symbols[0];
    links.push({ path: f.file, line: sym?.line ?? 1, label: sym?.name });
    if (links.length >= limit) break;
  }
  return links;
}

function majorDirectories(workspace: string): string[] {
  const idx = buildWorkspaceIndex(workspace, true);
  const dirs = new Set<string>();
  for (const f of idx.files) {
    const dir = path.posix.dirname(f.file);
    if (!dir || dir === ".") continue;
    dirs.add(dir.split("/")[0]!);
  }
  return [...dirs].filter((d) => !SKIP_DIRS.has(d)).sort().slice(0, 12);
}

function filesForPurpose(files: FileOutline[], purpose: string): FileOutline[] {
  const terms = purpose
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
  if (terms.length === 0) return files;
  return files
    .map((f) => {
      const p = f.file.toLowerCase();
      const score = terms.reduce((n, t) => n + (p.includes(t) ? 1 : 0), 0);
      return { f, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.f);
}

function renderPage(
  title: string,
  prose: string,
  sources: WikiSourceLink[],
  opts: { purpose?: string; parent?: string } = {},
): WikiPage {
  const lines: string[] = [`# ${title}`, ""];
  if (opts.purpose) {
    lines.push(`_${opts.purpose}_`, "");
  }
  if (prose) {
    lines.push(prose, "");
  }
  lines.push("## Source links", "");
  for (const s of sources) {
    lines.push(`- \`${s.path}:${s.line}\`${s.label ? ` — ${s.label}` : ""}`);
  }
  lines.push("");
  return {
    title,
    slug: slugify(title),
    ...(opts.parent ? { parent: opts.parent } : {}),
    ...(opts.purpose ? { purpose: opts.purpose } : {}),
    content: lines.join("\n"),
    sources,
  };
}

async function modelProse(client: WikiModelClient, model: string, prompt: string): Promise<string> {
  try {
    const res = await client.chat({ model, messages: [{ role: "user", content: prompt }] });
    return (res.content ?? "").trim();
  } catch {
    return "";
  }
}

function pagePrompt(title: string, purpose: string, files: FileOutline[], repoNotes: string[]): string {
  const fileLines = files
    .slice(0, 20)
    .map((f) => {
      const sym = f.symbols.find((s) => s.exported) ?? f.symbols[0];
      return `- ${f.file}${sym ? ` (${sym.kind} ${sym.name} at line ${sym.line})` : ""}`;
    })
    .join("\n");
  const notes = repoNotes.length ? `\nRepository notes:\n${repoNotes.map((n) => `- ${n}`).join("\n")}` : "";
  return [
    `You are writing one page of a repository wiki (DeepWiki-style).`,
    `Page title: ${title}`,
    `Purpose: ${purpose}`,
    `Files in scope:`,
    fileLines || "- (none)",
    notes,
    `Write 2-4 concise paragraphs describing this part of the codebase for a developer who has never seen it.`,
    `Mention the concrete files and their responsibilities. Do NOT invent file paths, symbols, or line numbers, and do NOT include markdown links or a "Source links" section (the wiki adds those itself).`,
  ].join("\n");
}

export interface GenerateWikiOptions {
  workspace: string;
  project?: string;
  model: string;
  client: WikiModelClient;
  config?: WikiConfig;
}

export async function generateWiki(opts: GenerateWikiOptions): Promise<WikiIndex> {
  const workspace = path.resolve(opts.workspace);
  const config = opts.config ?? loadWikiConfig(workspace);
  const project = opts.project ?? config.project ?? path.basename(workspace);
  const idx = buildWorkspaceIndex(workspace, true);
  const rootFiles = idx.files.filter((f) => !f.file.includes("/"));
  const notes = config.repo_notes ?? [];
  const pages: WikiPage[] = [];

  const overviewFiles = [...rootFiles, ...majorDirectories(workspace).map((d) => idx.files.find((f) => path.posix.dirname(f.file) === d)).filter((f): f is FileOutline => !!f)];
  const overview = renderPage(
    "Overview",
    await modelProse(opts.client, opts.model, pagePrompt("Overview", "What this repository is and how to get oriented.", overviewFiles, notes)),
    linksForFiles(overviewFiles),
  );
  pages.push(overview);

  const imported = new Set<string>();
  for (const f of idx.files) {
    for (const imp of f.imports) {
      const base = path.basename(imp).replace(/\.[^.]+$/, "");
      for (const other of idx.files) {
        if (other.file !== f.file && path.basename(other.file).replace(/\.[^.]+$/, "") === base) imported.add(other.file);
      }
    }
  }
  const archFiles = idx.files.filter((f) => imported.has(f.file) || rootFiles.includes(f));
  const architecture = renderPage(
    "Architecture",
    await modelProse(opts.client, opts.model, pagePrompt("Architecture", "How the pieces fit together: entry points, module boundaries and data flow.", archFiles, notes)),
    linksForFiles(archFiles),
  );
  pages.push(architecture);

  for (const dir of majorDirectories(workspace)) {
    const dirFiles = idx.files.filter((f) => path.posix.dirname(f.file) === dir);
    const page = renderPage(
      dir,
      await modelProse(opts.client, opts.model, pagePrompt(dir, `The ${dir} module: what it contains and how it is used.`, dirFiles, notes)),
      linksForFiles(dirFiles),
    );
    pages.push(page);
  }

  for (const cfg of config.pages ?? []) {
    const scoped = filesForPurpose(idx.files, cfg.purpose ?? cfg.title);
    const page = renderPage(
      cfg.title,
      await modelProse(opts.client, opts.model, pagePrompt(cfg.title, cfg.purpose ?? cfg.title, scoped, notes)),
      linksForFiles(scoped),
      { purpose: cfg.purpose, parent: cfg.parent },
    );
    pages.push(page);
  }

  const index: WikiIndex = { project, generatedAt: new Date().toISOString(), pages };
  writeWikiIndex(index);
  return index;
}

/** Validate that a `path:line` link resolves to a real file and line. */
export function isValidSourceLink(workspace: string, link: WikiSourceLink): boolean {
  try {
    const abs = path.resolve(workspace, link.path);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return false;
    const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/).length;
    return link.line >= 1 && link.line <= lines;
  } catch {
    return false;
  }
}

const LINK_RE = /([\p{L}\p{N}_./-]+\.[A-Za-z0-9]+):(\d+)/gu;

export function extractCitations(answer: string, workspace: string): string[] {
  const out: string[] = [];
  for (const m of answer.matchAll(LINK_RE)) {
    const abs = path.isAbsolute(m[1]!) ? m[1]! : path.resolve(workspace, m[1]!);
    const rel = relPath(workspace, abs);
    const line = Number(m[2]!);
    if (isValidSourceLink(workspace, { path: rel, line })) {
      const cite = `${rel}:${line}`;
      if (!out.includes(cite)) out.push(cite);
    }
  }
  return out;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Built-in fallback search: case-insensitive term match over workspace files. */
export function localGrep(workspace: string, query: string, maxResults = 20): CodeSearchHit[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
  if (terms.length === 0) return [];
  const hits: CodeSearchHit[] = [];
  const stack: string[] = [path.resolve(workspace)];
  let visited = 0;
  while (stack.length > 0 && hits.length < maxResults && visited < 800) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (hits.length >= maxResults) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) stack.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      visited += 1;
      try {
        if (fs.statSync(full).size > 500_000) continue;
        const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
        for (let i = 0; i < lines.length && hits.length < maxResults; i++) {
          const line = (lines[i] ?? "").toLowerCase();
          if (terms.some((t) => line.includes(t))) {
            hits.push({ path: relPath(workspace, full), line: i + 1, snippet: (lines[i] ?? "").trim().slice(0, 200) });
          }
        }
      } catch {
        /* ignore unreadable files */
      }
    }
  }
  return hits;
}

export async function searchCodebase(
  workspace: string,
  query: string,
  searchFn?: CodeSearchFn,
): Promise<CodeSearchHit[]> {
  if (searchFn) {
    try {
      const hits = await searchFn(workspace, query);
      if (hits.length > 0) return hits;
    } catch {
      /* fall through to the built-in search */
    }
  }
  return localGrep(workspace, query);
}

export interface AskCodebaseOptions {
  workspace: string;
  project?: string;
  question: string;
  model: string;
  client: WikiModelClient;
  search?: CodeSearchFn;
}

export interface AskCodebaseResult {
  ok: boolean;
  answer: string;
  citations: string[];
  content: string;
  reason?: string;
}

export async function askCodebase(opts: AskCodebaseOptions): Promise<AskCodebaseResult> {
  const workspace = path.resolve(opts.workspace);
  const config = loadWikiConfig(workspace);
  const project = opts.project ?? config.project ?? path.basename(workspace);
  const wiki = readWikiIndex(project);
  const hits = await searchCodebase(workspace, opts.question, opts.search);

  const wikiContext = wiki
    ? wiki.pages.map((p) => `# ${p.title}\n${p.content.slice(0, 4000)}`).join("\n\n")
    : "(no wiki has been generated for this repository yet)";
  const searchContext = hits.map((h) => `${h.path}:${h.line}: ${h.snippet}`).join("\n");

  const prompt = [
    `You are answering a question about a codebase using its generated wiki and search results.`,
    `Question: ${opts.question}`,
    ``,
    `Wiki context:`,
    wikiContext,
    ``,
    `Search results:`,
    searchContext || "(no search hits)",
    ``,
    `Answer concisely and cite the files you rely on using the exact form \`path:line\` (for example \`src/index.ts:1\`). Only cite files that appear in the context above.`,
  ].join("\n");

  const answer = await modelProse(opts.client, opts.model, prompt);
  if (!answer) {
    return {
      ok: false,
      answer: "",
      citations: [],
      content: "",
      reason: "The model returned an empty answer. Ensure the wiki is generated (wiki_generate) and the model is reachable.",
    };
  }

  const citations = extractCitations(answer, workspace);
  const fallback = hits.map((h) => `${h.path}:${h.line}`);
  const finalCitations = citations.length > 0 ? citations : fallback;

  const content = `${answer}\n\nSources:\n${finalCitations.map((c) => `- ${c}`).join("\n")}`;
  return { ok: true, answer, citations: finalCitations, content };
}

export function createWikiTools(client: WikiModelClient, model: string, registry?: ToolRegistry): Tool[] {
  const fileSearch = registry?.get("file_search");
  const searchFn: CodeSearchFn | undefined = fileSearch
    ? async (ws, q) => {
        const res = await fileSearch.run({ pattern: escapeRegex(q), path: ws, maxResults: 20 }, {
          workspace: ws,
          emit: () => {},
        } as unknown as ToolContext);
        if (!res.ok) return [];
        const hits: CodeSearchHit[] = [];
        for (const line of res.content.split("\n")) {
          const m = /^(.*?):(\d+): (.*)$/.exec(line);
          if (m?.[1] && m[2] && m[3]) hits.push({ path: relPath(ws, m[1]), line: Number(m[2]), snippet: m[3] });
        }
        return hits;
      }
    : undefined;

  return [
    {
      name: "wiki_generate",
      description:
        "Build a DeepWiki-style wiki for the current workspace: an overview page, an architecture page, one page per major directory/module, plus any pages steered by .loam/wiki.json. Every page cites real source links (path:line). Stored under data/wikis/<project>.",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "Wiki project name (default: workspace folder name or .loam/wiki.json project)." },
        },
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const project = str(args, "project").trim() || undefined;
        const wiki = await generateWiki({ workspace: ctx.workspace, project, model, client });
        return {
          ok: true,
          content: `Generated wiki "${wiki.project}" with ${wiki.pages.length} pages:\n${wiki.pages.map((p) => `- ${p.title}`).join("\n")}`,
        };
      },
    },
    {
      name: "ask_codebase",
      description:
        "Answer a question about the codebase using the generated repo wiki plus codebase search (file_search when available, else a built-in grep), citing existing files as path:line. Run wiki_generate first for the best results.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question to answer about the codebase." },
        },
        required: ["question"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const question = str(args, "question").trim();
        if (!question) return { ok: false, content: "Provide a question about the codebase." };
        const result = await askCodebase({ workspace: ctx.workspace, question, model, client, search: searchFn });
        if (!result.ok) return { ok: false, content: result.reason ?? "ask_codebase failed" };
        return { ok: true, content: result.content };
      },
    },
  ];
}
