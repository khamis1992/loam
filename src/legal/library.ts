/**
 * Qatar law LIBRARY: a read-only full-text index (search.db, SQLite FTS5) of
 * ~83k Al Meezan documents (laws, regulations, decisions, rulings) copied from
 * the al-Araf research collection, plus the per-document Markdown files.
 *
 * This is a research layer, NOT the citable corpus (qatar-law.db). Every
 * status tag in it is INFERRED from Al Meezan metadata, so every result is
 * labelled unverified and must be checked before it is cited. Nothing here
 * can produce a VERIFIED citation; legal_cite_check remains the gate.
 *
 * Layout of `legal.libraryPath` (default <DATA_DIR>/legal/library):
 *   search.db                    FTS5 table docs(kind,folder,title,ref,article,state,body,url,file)
 *   laws|regulations|decisions|rulings/<file>.md
 *   manifest.json                written by scripts/qatar-library-sync.*
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const LIBRARY_FOLDERS = ["laws", "regulations", "decisions", "rulings"] as const;
export type LibraryFolder = (typeof LIBRARY_FOLDERS)[number];

export type LibraryStatus = "in_force" | "amended" | "added" | "superseded" | "repealed" | "unknown";

export const UNVERIFIED_WARNING_AR = "⚠️ وسم مستنتج — تحقّق من الميزان قبل الاستشهاد";
export const UNVERIFIED_WARNING_EN = "Status tag is inferred from Al Meezan metadata — verify before citing.";

const STATUS_LABEL_AR: Record<LibraryStatus, string> = {
  in_force: "نافذ", amended: "نافذ — معدّل", added: "نافذ — مضافة",
  superseded: "نص سابق (مستبدل)", repealed: "ملغاة", unknown: "حالة غير معروفة",
};

/** Map the library's Arabic status tag (state column or a [..] tag in the text) to a status. */
export function mapLibraryStatus(raw: string | null | undefined): LibraryStatus {
  const s = (raw ?? "").replace(/[[\]]/g, "").replace(/\s+/g, " ").trim();
  if (!s) return "unknown";
  if (s.includes("ملغا")) return "repealed";
  if (s.includes("مستبدل") || s.includes("نص سابق")) return "superseded";
  if (s.includes("مضاف")) return "added";
  if (s.includes("معدّل") || s.includes("معدل")) return "amended";
  if (s.includes("نافذ")) return "in_force";
  return "unknown";
}

export function statusLabelAr(status: LibraryStatus): string { return STATUS_LABEL_AR[status]; }

export interface LibraryHit {
  kind: string;
  folder: string;
  title: string;
  ref: string;
  article: string;
  status: LibraryStatus;
  statusAr: string;
  rawState: string;
  snippet: string;
  url: string;
  file: string;
  verified: false;
  warning: string;
}

export interface LibrarySearchOptions { folder?: LibraryFolder; limit?: number }

/** Plain words become quoted phrases (same rule as the library's search.sh); FTS syntax passes through. */
export function toFtsQuery(q: string): string {
  if (/["*]|\b(AND|OR|NOT|NEAR)\b/.test(q)) return q;
  return q.split(/\s+/).filter(Boolean).map((w) => `"${w.replace(/"/g, "")}"`).join(" ");
}

export class QatarLawLibrary {
  readonly root: string;
  private db: DatabaseSync | null = null;
  constructor(root: string) { this.root = path.resolve(root); }

  get dbPath(): string { return path.join(this.root, "search.db"); }
  available(): boolean { return fs.existsSync(this.dbPath); }

  private open(): DatabaseSync {
    if (!this.db) {
      if (!this.available()) throw new Error(`Qatar law library not installed at ${this.dbPath}`);
      this.db = new DatabaseSync(this.dbPath, { readOnly: true });
    }
    return this.db;
  }

  search(query: string, opts: LibrarySearchOptions = {}): LibraryHit[] {
    const q = toFtsQuery(query.trim());
    if (!q) return [];
    const limit = Math.max(1, Math.min(30, Math.floor(opts.limit ?? 10)));
    const where = opts.folder ? "docs MATCH ? AND folder = ?" : "docs MATCH ?";
    const params: Array<string | number> = opts.folder ? [q, opts.folder, limit] : [q, limit];
    const rows = this.open().prepare(
      `SELECT kind, folder, title, ref, article, state, snippet(docs, 6, '«', '»', '…', 18) AS snip, url, file FROM docs WHERE ${where} ORDER BY rank LIMIT ?`,
    ).all(...params) as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const rawState = String(r.state ?? "");
      const article = String(r.article ?? "").replace(/\s+(ملغاة|ملغى)$/u, "").trim();
      const status = mapLibraryStatus(rawState || (String(r.article ?? "").match(/ملغا[ةه]|ملغى/u)?.[0] ?? ""));
      return {
        kind: String(r.kind ?? ""), folder: String(r.folder ?? ""), title: String(r.title ?? ""), ref: String(r.ref ?? ""),
        article, status, statusAr: statusLabelAr(status), rawState, snippet: String(r.snip ?? "").replace(/\s+/g, " "),
        url: String(r.url ?? ""), file: String(r.file ?? ""), verified: false as const, warning: UNVERIFIED_WARNING_AR,
      };
    });
  }

  /** Read one library Markdown file by its `file` value; refuses paths outside the library. */
  readDoc(file: string): string {
    const rel = file.replace(/\\/g, "/").replace(/^\/+/, "");
    const top = rel.split("/")[0] as LibraryFolder;
    if (!LIBRARY_FOLDERS.includes(top) || !rel.endsWith(".md")) throw new Error("file must be <folder>/<name>.md from a library hit");
    const abs = path.resolve(this.root, rel);
    if (!abs.startsWith(this.root + path.sep)) throw new Error("file outside library");
    if (!fs.existsSync(abs)) throw new Error(`document not in local library copy: ${rel}`);
    return fs.readFileSync(abs, "utf8");
  }

  close(): void { this.db?.close(); this.db = null; }
}

export function defaultLibraryPath(dataDir: string): string { return path.join(dataDir, "legal", "library"); }
