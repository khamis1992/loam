import fs from "node:fs";
import path from "node:path";
import { parsePage, serializePage } from "./frontmatter.js";
import { commitAll } from "./git.js";
import { assertValidId, pagePath } from "./paths.js";
import { sanitizePage } from "./sanitize.js";
import { PAGE_KINDS, type Page, type PageKind, type PageMeta } from "./types.js";
import * as index from "./wikiIndex.js";

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Atomic write: temp file then rename. Windows can hold the target briefly (antivirus, indexer), so retry EBUSY/EPERM a few times. */
function atomicWrite(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 4 || (code !== "EBUSY" && code !== "EPERM")) {
        try { fs.unlinkSync(tmp); } catch { /* best effort */ }
        throw err;
      }
      sleepMs(25 * (attempt + 1));
    }
  }
}

export function readPage(root: string, kind: PageKind, id: string): Page | undefined {
  const file = pagePath(root, kind, id);
  if (!fs.existsSync(file)) return undefined;
  return parsePage(fs.readFileSync(file, "utf8"));
}

export function listPages(root: string, kind?: PageKind): PageMeta[] {
  const out: PageMeta[] = [];
  for (const k of kind ? [kind] : PAGE_KINDS) {
    const dir = path.join(root, k);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".md")) continue;
      try { out.push(parsePage(fs.readFileSync(path.join(dir, name), "utf8")).meta); } catch { /* skip a damaged page */ }
    }
  }
  return out.sort((a, b) => b.updated.localeCompare(a.updated));
}

export interface WriteInput {
  kind: PageKind;
  id: string;
  title: string;
  body: string;
  tags?: string[];
  sessionId?: string;
  supersedes?: string;
}

/**
 * Create or replace a page. Everything goes through sanitize first. When
 * `supersedes` names an older page of the same kind it is kept on disk but
 * marked, and drops out of default search.
 */
export function writePage(root: string, input: WriteInput, now = new Date()): Page {
  assertValidId(input.id);
  const existing = readPage(root, input.kind, input.id);
  const stamp = now.toISOString();
  const page = sanitizePage({
    meta: {
      id: input.id,
      kind: input.kind,
      title: input.title,
      created: existing?.meta.created ?? stamp,
      updated: stamp,
      tags: input.tags ?? existing?.meta.tags ?? [],
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.supersedes ? { supersedes: input.supersedes } : {}),
      ...(existing?.meta.supersededBy ? { supersededBy: existing.meta.supersededBy } : {}),
    },
    body: input.body,
  });
  atomicWrite(pagePath(root, input.kind, input.id), serializePage(page));
  index.upsert(root, page);
  if (input.supersedes && input.supersedes !== input.id) {
    const old = readPage(root, input.kind, input.supersedes);
    if (old) {
      old.meta.supersededBy = input.id;
      old.meta.updated = stamp;
      atomicWrite(pagePath(root, input.kind, old.meta.id), serializePage(old));
      index.upsert(root, old);
    }
  }
  writeIndexMd(root);
  commitAll(root, `${existing ? "update" : "add"} ${input.kind}/${input.id}`);
  return page;
}

export function deletePage(root: string, kind: PageKind, id: string): boolean {
  const file = pagePath(root, kind, id);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  index.remove(root, kind, id);
  writeIndexMd(root);
  commitAll(root, `remove ${kind}/${id}`);
  return true;
}

/** Rebuild the search index from the markdown files (the files are the source of truth). */
export function reindex(root: string): number {
  index.reset(root);
  let n = 0;
  for (const meta of listPages(root)) {
    const page = readPage(root, meta.kind, meta.id);
    if (page) { index.upsert(root, page); n++; }
  }
  return n;
}

function writeIndexMd(root: string): void {
  const lines = ["# Project wiki", ""];
  for (const kind of PAGE_KINDS) {
    const metas = listPages(root, kind).filter((m) => !m.supersededBy);
    if (!metas.length) continue;
    lines.push(`## ${kind}`, "");
    for (const m of metas) lines.push(`- [${m.title.replace(/[\[\]]/g, "")}](${kind}/${m.id}.md) (${m.updated.slice(0, 10)})`);
    lines.push("");
  }
  atomicWrite(path.join(root, "INDEX.md"), lines.join("\n"));
}
