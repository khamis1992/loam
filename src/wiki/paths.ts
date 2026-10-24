import crypto from "node:crypto";
import path from "node:path";
import { dataDir } from "../config.js";
import { PAGE_KINDS, type PageKind } from "./types.js";

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/;

export function slugify(text: string, fallback = "page"): string {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || fallback;
}

/** Stable per-project folder name: readable slug plus a short hash of the full path. */
export function projectKey(workspace: string): string {
  const full = path.resolve(workspace);
  const norm = process.platform === "win32" ? full.toLowerCase() : full;
  const hash = crypto.createHash("sha256").update(norm).digest("hex").slice(0, 10);
  return `${slugify(path.basename(full), "project")}-${hash}`;
}

export function wikiRoot(workspace: string): string {
  return path.join(dataDir(), "wiki", projectKey(workspace));
}

export function assertValidId(id: string): string {
  if (!ID_RE.test(id)) throw new Error(`invalid wiki page id: ${JSON.stringify(id).slice(0, 60)}`);
  return id;
}

export function assertValidKind(kind: string): PageKind {
  if (!(PAGE_KINDS as readonly string[]).includes(kind)) throw new Error(`invalid wiki page kind: ${kind.slice(0, 20)}`);
  return kind as PageKind;
}

/** Absolute page path; id and kind are validated so no input can leave the wiki root. */
export function pagePath(root: string, kind: PageKind, id: string): string {
  assertValidKind(kind);
  assertValidId(id);
  const file = path.join(root, kind, `${id}.md`);
  const rel = path.relative(root, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("wiki path escapes its root");
  return file;
}
