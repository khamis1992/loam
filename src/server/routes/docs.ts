/**
 * Neo N22 - the in-app help feed.
 *
 *   GET /api/docs                     the guide index (one entry per subject)
 *   GET /api/docs/:file               one page's Markdown, e.g. `canvas.md`
 * The guide itself lives in `docs/neo/*.md` and is built by
 * `src/docs/neoDocs.ts`. This route serves the same build the link checker
 * validates, so what the user reads in the app and what CI checks are one
 * thing rather than two.
 *
 * `:file` is restricted to the manifest's own file names. It is not a path:
 * the route never joins the parameter into a filesystem path, so `..` and
 * absolute paths cannot escape `docs/neo`.
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../../config.js";
import {
  NEO_DOC_FILES,
  buildNeoDocs,
  localeOf,
  type NeoDocPage,
} from "../../docs/neoDocs.js";
import type { IncomingMessage, ServerResponse } from "node:http";

/** `docs/neo`, relative to the repo root. */
export const DOCS_DIR = path.join(ROOT, "docs", "neo");

/** The index file, which has no Arabic twin of its own naming. */
const INDEX_FILE = NEO_DOC_FILES[0];

/**
 * Read a guide page from disk, or `null` when it does not exist.
 *
 * `candidate` comes from `NEO_DOC_FILES`, so it is already a bare file name;
 * the join is a belt-and-braces check that it cannot escape `docs/neo`.
 */
function readFile(candidate: string): string | null {
  if (path.basename(candidate) !== candidate) return null;
  try {
    return fs.readFileSync(path.join(DOCS_DIR, candidate), "utf8");
  } catch {
    return null;
  }
}

/** Build the guide. Ten small files, so once per request is cheap. */
function guide(): ReturnType<typeof buildNeoDocs> {
  return buildNeoDocs(DOCS_DIR, readFile);
}

/** One index entry: an English page and its Arabic twin, side by side. */
export interface NeoDocIndexEntry {
  /** Subject slug, e.g. `canvas`. */
  subject: string;
  /** English file name, e.g. `canvas.md`. */
  file: string;
  title: string;
  /** Arabic file name, or `null` when the page has no twin. */
  arabicFile: string | null;
  arabicTitle: string | null;
  /** Section headings, so the UI can offer an in-page outline. */
  sections: string[];
  /**
   * The anchor for each section, at the same index, computed by the docs build.
   * The UI must not re-derive these: the link checker accepts a `#fragment`
   * only when it matches one of these anchors, so the outline links to what the
   * checker already proved.
   */
  anchors: string[];
}

/**
 * Handle `/api/docs`. Returns true when the path belongs to this module,
 * which is the convention every other route in `http.ts` follows:
 * `if (await handleDocsRoutes(req, res, p)) return;`
 *
 * `:file` is matched against the manifest's own file names, never joined into
 * a path, so `..`, absolute paths and traversal cannot reach outside `docs/neo`.
 */
export async function handleDocsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  p: string,
): Promise<boolean> {
  if (p !== "/api/docs" && !p.startsWith("/api/docs/")) return false;

  const manifest = guide();
  const known = new Set(manifest.files);

  if (req.method !== "GET") {
    res.writeHead(405, { "content-type": "application/json", allow: "GET" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return true;
  }

  const file = p.slice("/api/docs/".length).replace(/\/+$/, "");

  // The index: one entry per subject, English page plus its Arabic twin.
  if (file === "") {
    const byFile = new Map(manifest.pages.map((page) => [page.file, page]));
    const docs: NeoDocIndexEntry[] = [];
    for (const entry of manifest.pages) {
      if (entry.locale !== "en") continue;
      const arabicFile =
        entry.file === INDEX_FILE ? "README.ar.md" : entry.file.replace(/\.md$/, ".ar.md");
      const arabic = byFile.get(arabicFile);
      docs.push({
        subject: entry.file === INDEX_FILE ? "index" : entry.file.replace(/\.md$/, ""),
        file: entry.file,
        title: entry.title,
        arabicFile: arabic ? arabicFile : null,
        arabicTitle: arabic ? arabic.title : null,
        sections: entry.sections,
        anchors: entry.anchors,
      });
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ docs, missing: manifest.missing }));
    return true;
  }

  // One page. Not a path: anything outside the manifest is simply not a page.
  const page: NeoDocPage | undefined = manifest.pages.find((entry) => entry.file === file);
  if (!page || !known.has(file)) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Unknown doc", file }));
    return true;
  }
  res.writeHead(200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-language": page.locale,
    "cache-control": "no-cache",
  });
  res.end(page.body);
  return true;
}

/** The locale of a guide file name, exported for the route's tests. */
export function docsLocale(file: string): "en" | "ar" {
  return localeOf(file);
}
