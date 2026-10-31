/**
 * qatar_library_search / qatar_library_doc — read-only research tools over the
 * Qatar law library (src/legal/library.ts). Results are NEVER citable: they
 * carry no ⟦cite:ID⟧ token, every hit is marked unverified with the
 * "tag is inferred, verify before citing" warning, and the model is told to
 * confirm through legal_search/legal_article (verified corpus) or mark the
 * point [غير موثّق — يحتاج بحث محامٍ].
 */
import { LIBRARY_FOLDERS, UNVERIFIED_WARNING_AR, UNVERIFIED_WARNING_EN, type LibraryFolder, type QatarLawLibrary } from "../legal/library.js";
import { LIBRARY_MARKER } from "../legal/verify.js";
import { num, str, type Tool, type ToolResult } from "./registry.js";

export const QATAR_LIBRARY_TOOL_NAMES = ["qatar_library_search", "qatar_library_doc"] as const;

const MAX_OUT = 15_000;
const ok = (content: string): ToolResult => ({ ok: true, content: content.length > MAX_OUT ? `${content.slice(0, MAX_OUT)}\n…[truncated]` : content });
const fail = (content: string): ToolResult => ({ ok: false, content });
const BANNER = `${UNVERIFIED_WARNING_AR}\n${UNVERIFIED_WARNING_EN}\nLibrary results are research leads only: they are NOT citable. Confirm with legal_search/legal_article before citing. If you mention a library-only lead in a draft, write ${LIBRARY_MARKER} right after it (it blocks final export until verified).`;

export function createQatarLibraryTools(library: QatarLawLibrary): Tool[] {
  const search: Tool = {
    name: "qatar_library_search",
    description:
      "Search the full Qatar law RESEARCH library (≈83k Al Meezan laws, regulations, decisions and court rulings; SQLite FTS5). " +
      "Each hit has an INFERRED status tag (in force / amended / added / superseded / repealed / unknown) and is UNVERIFIED. " +
      "Use it to discover which law/article/ruling is relevant, then confirm via legal_search/legal_article. Never cite it directly.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Arabic words (each matched as a phrase) or FTS5 syntax: \"exact phrase\", a AND b, prefix*." },
        folder: { type: "string", enum: [...LIBRARY_FOLDERS], description: "Restrict to laws | regulations | decisions | rulings." },
        limit: { type: "number", description: "1-30, default 10." },
      },
      required: ["query"],
    },
    async run(args) {
      const query = str(args, "query").trim();
      if (!query) return fail("query is required");
      if (!library.available()) return fail(`Qatar law library is not installed (expected ${library.dbPath}). Ask the user to run the library sync.`);
      const folderArg = str(args, "folder");
      if (folderArg && !LIBRARY_FOLDERS.includes(folderArg as LibraryFolder)) return fail(`folder must be one of ${LIBRARY_FOLDERS.join(", ")}`);
      let hits;
      try { hits = library.search(query, { ...(folderArg ? { folder: folderArg as LibraryFolder } : {}), limit: num(args, "limit", 10) }); }
      catch (e) { return fail(`library search failed: ${(e as Error).message}`); }
      if (!hits.length) return ok(`${BANNER}\n\nNO_RESULTS for ${query}`);
      const lines = hits.map((h, i) =>
        `${i + 1}. [${h.statusAr} · غير مُتحقَّق] ${h.title} [${h.ref}] — ${h.article}\n   ${h.snippet}\n   ${h.url} | file: ${h.file}`);
      return ok(`${BANNER}\n\n${lines.join("\n\n")}`);
    },
  };
  const doc: Tool = {
    name: "qatar_library_doc",
    description: "Read one Qatar law library document (Markdown with metadata and per-article inferred status tags) by the `file` value from qatar_library_search. Unverified research text; never cite directly.",
    parameters: { type: "object", properties: { file: { type: "string", description: "e.g. laws/2004_14_...md" }, maxChars: { type: "number" } }, required: ["file"] },
    async run(args) {
      const file = str(args, "file");
      try {
        const text = library.readDoc(file);
        const max = Math.max(1000, Math.min(14_000, num(args, "maxChars", 12_000)));
        return ok(`${BANNER}\n\n${text.length > max ? `${text.slice(0, max)}\n…[truncated; ${text.length} chars total]` : text}`);
      } catch (e) { return fail((e as Error).message); }
    },
  };
  return [search, doc];
}
