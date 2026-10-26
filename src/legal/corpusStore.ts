/**
 * The Qatari law corpus: legislations, articles, article versions, amendments
 * and the derived lexical/vector index, in one SQLite file (node:sqlite, the
 * same driver Loam already uses in src/server/sqliteStore.ts and
 * src/memory/codeIndex.ts).
 *
 * Text enters ONLY through `importPack` (a reviewed LegalPack JSON) and leaves
 * ONLY as the stored official text. Nothing in this module calls a network.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeText } from "../knowledge/text.js";
import { legalTerms, parseLabel, termFrequencies } from "./normalize.js";
import { CORPUS_SCHEMA, CORPUS_SCHEMA_VERSION } from "./schema.js";
import { migrateLegalDatabase } from "./db/migrations.js";
import {
  CITABLE_PROVENANCE,
  LEGISLATION_TYPES,
  type Amendment,
  type AmendmentKind,
  type Article,
  type ArticlePart,
  type ArticleVersion,
  type Legislation,
  type LegislationStatus,
  type LegislationType,
  type ResolvedArticle,
  type SourceRef,
} from "./types.js";

// ---------------------------------------------------------------------------
// LegalPack: the only import format
// ---------------------------------------------------------------------------

export interface LegalPackArticle {
  part?: ArticlePart;
  /** Raw label as printed: "171", "115 مكرراً", "١٢", "الأولى". */
  label: string;
  heading?: string;
  text: string;
}

export interface LegalPackAmendment {
  /** Article of THIS (amending) legislation that carries the change. */
  amendingArticle: string;
  target: { legKey: string; part?: ArticlePart; label: string };
  kind: AmendmentKind;
  newText?: string;
  heading?: string;
  /** Defaults to the amending legislation's effective date. */
  effectiveDate?: string;
}

export interface LegalPack {
  format: "loam-legal-pack/1";
  legislation: {
    type: LegislationType;
    year: number;
    number: number;
    titleAr: string;
    titleEn?: string;
    aliases?: string[];
    issueDate?: string;
    publishDate?: string;
    effectiveDate?: string;
    status?: LegislationStatus;
  };
  source: SourceRef;
  articles: LegalPackArticle[];
  amends?: LegalPackAmendment[];
  /** Whole legislations this one repeals. */
  repeals?: Array<{ legKey: string; effectiveDate?: string }>;
}

export interface ImportResult {
  legKey: string;
  created: boolean;
  articles: number;
  versions: number;
  amendmentsApplied: number;
  repealsApplied: number;
  warnings: string[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function legislationKey(type: LegislationType, year: number, number: number): string {
  return `${type}/${year}/${number}`;
}

export function articleKey(legKey: string, part: ArticlePart, label: string): string {
  return `${legKey}:${part}:${label}`;
}

/** Stable short id a model can copy: "QL-" + 10 hex of sha256(articleKey|effectiveFrom). */
export function makeAvid(artKey: string, effectiveFrom: string): string {
  return `QL-${crypto.createHash("sha256").update(`${artKey}|${effectiveFrom}`).digest("hex").slice(0, 10)}`;
}

export function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** Validate a pack before any write. Returns a list of errors (empty = valid). */
export function validatePack(pack: unknown): string[] {
  const errors: string[] = [];
  if (!pack || typeof pack !== "object") return ["pack must be an object"];
  const p = pack as Partial<LegalPack>;
  if (p.format !== "loam-legal-pack/1") errors.push('format must be "loam-legal-pack/1"');
  const leg = p.legislation;
  if (!leg) errors.push("legislation is required");
  else {
    if (!LEGISLATION_TYPES.includes(leg.type)) errors.push(`legislation.type "${String(leg.type)}" is not supported`);
    if (!Number.isInteger(leg.year) || leg.year < 1900 || leg.year > 2200) errors.push("legislation.year must be an integer year");
    if (!Number.isInteger(leg.number) || leg.number < 0) errors.push("legislation.number must be a non-negative integer");
    if (!leg.titleAr || !leg.titleAr.trim()) errors.push("legislation.titleAr is required");
    for (const f of ["issueDate", "publishDate", "effectiveDate"] as const) {
      if (leg[f] !== undefined && !isIsoDate(leg[f])) errors.push(`legislation.${f} must be YYYY-MM-DD`);
    }
    if (!leg.effectiveDate && !leg.publishDate && !leg.issueDate) errors.push("one of effectiveDate/publishDate/issueDate is required");
  }
  const src = p.source;
  if (!src) errors.push("source is required");
  else {
    if (!src.provenance) errors.push("source.provenance is required");
    if (!isIsoDate((src.retrievedAt ?? "").slice(0, 10))) errors.push("source.retrievedAt must start with YYYY-MM-DD");
    if (src.provenance && CITABLE_PROVENANCE.has(src.provenance) && !src.verifiedBy?.trim()) {
      errors.push("source.verifiedBy is required for official provenance (a person must check the text)");
    }
  }
  const seen = new Set<string>();
  for (const [i, a] of (p.articles ?? []).entries()) {
    const parsed = parseLabel(a.label ?? "");
    if (!parsed) { errors.push(`articles[${i}].label "${a.label}" is not a valid article label`); continue; }
    const k = `${a.part ?? "body"}:${parsed.label}`;
    if (seen.has(k)) errors.push(`articles[${i}] duplicates ${k}`);
    seen.add(k);
    if (!a.text || !a.text.trim()) errors.push(`articles[${i}].text is empty`);
  }
  for (const [i, m] of (p.amends ?? []).entries()) {
    if (!["replace", "insert", "repeal"].includes(m.kind)) errors.push(`amends[${i}].kind invalid`);
    if (!parseLabel(m.target?.label ?? "")) errors.push(`amends[${i}].target.label invalid`);
    if (m.kind !== "repeal" && !m.newText?.trim()) errors.push(`amends[${i}].newText required for ${m.kind}`);
    if (m.effectiveDate !== undefined && !isIsoDate(m.effectiveDate)) errors.push(`amends[${i}].effectiveDate must be YYYY-MM-DD`);
  }
  for (const [i, r] of (p.repeals ?? []).entries()) {
    if (!r.legKey) errors.push(`repeals[${i}].legKey required`);
    if (r.effectiveDate !== undefined && !isIsoDate(r.effectiveDate)) errors.push(`repeals[${i}].effectiveDate must be YYYY-MM-DD`);
  }
  if ((p.articles ?? []).length === 0 && (p.amends ?? []).length === 0 && (p.repeals ?? []).length === 0) {
    errors.push("pack has no articles, amendments or repeals");
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
const s = (v: unknown): string => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
const os = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

function rowToLegislation(r: Row): Legislation {
  return {
    key: s(r.key),
    type: s(r.type) as LegislationType,
    year: Number(r.year),
    number: Number(r.number),
    titleAr: s(r.title_ar),
    ...(os(r.title_en) ? { titleEn: os(r.title_en) } : {}),
    aliases: JSON.parse(s(r.aliases_json) || "[]") as string[],
    ...(os(r.issue_date) ? { issueDate: os(r.issue_date) } : {}),
    ...(os(r.publish_date) ? { publishDate: os(r.publish_date) } : {}),
    ...(os(r.effective_date) ? { effectiveDate: os(r.effective_date) } : {}),
    status: s(r.status) as LegislationStatus,
    ...(os(r.repealed_by) ? { repealedBy: os(r.repealed_by) } : {}),
    ...(os(r.repealed_at) ? { repealedAt: os(r.repealed_at) } : {}),
    source: JSON.parse(s(r.source_json)) as SourceRef,
  };
}

function rowToArticle(r: Row): Article {
  return {
    key: s(r.key),
    legKey: s(r.leg_key),
    part: s(r.part) as ArticlePart,
    label: s(r.label),
    ordinal: Number(r.ordinal),
    ...(os(r.heading) ? { heading: os(r.heading) } : {}),
    ...(os(r.repealed_at) ? { repealedAt: os(r.repealed_at) } : {}),
    ...(os(r.repealed_by) ? { repealedBy: os(r.repealed_by) } : {}),
  };
}

function rowToVersion(r: Row): ArticleVersion {
  return {
    avid: s(r.avid),
    articleKey: s(r.article_key),
    text: s(r.text),
    textSha256: s(r.text_sha256),
    effectiveFrom: s(r.effective_from),
    effectiveTo: os(r.effective_to) ?? null,
    origin: s(r.origin) as ArticleVersion["origin"],
    ...(os(r.introduced_by) ? { introducedBy: os(r.introduced_by) } : {}),
    source: JSON.parse(s(r.source_json)) as SourceRef,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface CorpusStats { legislations: number; articles: number; versions: number; avgLen: number }

export class LegalCorpus {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    migrateLegalDatabase(this.db, { schema: CORPUS_SCHEMA, version: CORPUS_SCHEMA_VERSION });
  }

  close(): void { this.db.close(); }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const out = fn(); this.db.exec("COMMIT"); return out; } catch (err) { this.db.exec("ROLLBACK"); throw err; }
  }

  // ---- reads --------------------------------------------------------------

  getLegislation(key: string): Legislation | undefined {
    const r = this.db.prepare("SELECT * FROM legislations WHERE key=?").get(key) as Row | undefined;
    return r ? rowToLegislation(r) : undefined;
  }

  listLegislations(): Legislation[] {
    return (this.db.prepare("SELECT * FROM legislations ORDER BY year DESC, number DESC").all() as Row[]).map(rowToLegislation);
  }

  getArticle(key: string): Article | undefined {
    const r = this.db.prepare("SELECT * FROM articles WHERE key=?").get(key) as Row | undefined;
    return r ? rowToArticle(r) : undefined;
  }

  articlesOf(legKey: string): Article[] {
    return (this.db.prepare("SELECT * FROM articles WHERE leg_key=? ORDER BY part DESC, ordinal, label").all(legKey) as Row[]).map(rowToArticle);
  }

  getVersion(avid: string): ArticleVersion | undefined {
    const r = this.db.prepare("SELECT * FROM article_versions WHERE avid=?").get(avid) as Row | undefined;
    return r ? rowToVersion(r) : undefined;
  }

  versionsOf(artKey: string): ArticleVersion[] {
    return (this.db.prepare("SELECT * FROM article_versions WHERE article_key=? ORDER BY effective_from").all(artKey) as Row[]).map(rowToVersion);
  }

  amendmentsOf(artKey: string): Amendment[] {
    return (this.db.prepare("SELECT * FROM amendments WHERE target_article_key=? ORDER BY effective_date").all(artKey) as Row[]).map((r) => ({
      id: s(r.id),
      amendingLegKey: s(r.amending_leg_key),
      amendingArticle: s(r.amending_article),
      targetArticleKey: s(r.target_article_key),
      kind: s(r.kind) as AmendmentKind,
      effectiveDate: s(r.effective_date),
      ...(os(r.new_text) ? { newText: os(r.new_text) } : {}),
      ...(os(r.heading) ? { heading: os(r.heading) } : {}),
      source: JSON.parse(s(r.source_json)) as SourceRef,
    }));
  }

  provenanceOf(avid: string): string | undefined {
    const r = this.db.prepare("SELECT provenance FROM article_versions WHERE avid=?").get(avid) as Row | undefined;
    return r ? s(r.provenance) : undefined;
  }

  /** Resolve a version id into its legislation/article and the in-force check for `asOf`. */
  resolve(avid: string, asOf: string): ResolvedArticle | undefined {
    const version = this.getVersion(avid);
    if (!version) return undefined;
    const article = this.getArticle(version.articleKey);
    if (!article) return undefined;
    const legislation = this.getLegislation(article.legKey);
    if (!legislation) return undefined;
    const laterVersions = this.versionsOf(article.key).filter((v) => v.effectiveFrom > version.effectiveFrom);
    return { legislation, article, version, laterVersions, inForceAt: inForce(version, asOf), asOf };
  }

  /** The version of an article in force at `asOf`, if any. */
  versionAt(artKey: string, asOf: string): ArticleVersion | undefined {
    return this.versionsOf(artKey).find((v) => inForce(v, asOf));
  }

  /** Look a legislation up by alias ("القانون المدني") or by "law/2004/22". */
  resolveLegislationRef(ref: string): Legislation | undefined {
    const direct = this.getLegislation(ref.trim());
    if (direct) return direct;
    const r = this.db.prepare("SELECT leg_key FROM legislation_aliases WHERE alias_norm=? LIMIT 2").all(normalizeText(ref.trim())) as Row[];
    if (r.length !== 1) return undefined; // ambiguous or unknown aliases never resolve
    return this.getLegislation(s(r[0]?.leg_key));
  }

  /** Every legislation whose number/year matches (any type) — used by the free-mention checker. */
  findByNumberYear(number: number, year: number): Legislation[] {
    return (this.db.prepare("SELECT * FROM legislations WHERE number=? AND year=?").all(number, year) as Row[]).map(rowToLegislation);
  }

  stats(): CorpusStats {
    const one = (sql: string): number => Number((this.db.prepare(sql).get() as Row | undefined)?.n ?? 0);
    return {
      legislations: one("SELECT COUNT(*) AS n FROM legislations"),
      articles: one("SELECT COUNT(*) AS n FROM articles"),
      versions: one("SELECT COUNT(*) AS n FROM article_versions"),
      avgLen: Number((this.db.prepare("SELECT AVG(len) AS n FROM doc_len").get() as Row | undefined)?.n ?? 0),
    };
  }

  postings(term: string): Array<{ avid: string; tf: number }> {
    return (this.db.prepare("SELECT avid, tf FROM postings WHERE term=?").all(term) as Row[]).map((r) => ({ avid: s(r.avid), tf: Number(r.tf) }));
  }

  docLen(avid: string): number {
    return Number((this.db.prepare("SELECT len FROM doc_len WHERE avid=?").get(avid) as Row | undefined)?.len ?? 0);
  }

  vectorsFor(model: string): Array<{ avid: string; vec: Float32Array }> {
    return (this.db.prepare("SELECT avid, dim, vec FROM vectors WHERE model=?").all(model) as Row[]).map((r) => {
      const buf = r.vec as Uint8Array;
      const copy = new Uint8Array(buf.byteLength); copy.set(buf);
      return { avid: s(r.avid), vec: new Float32Array(copy.buffer, 0, Number(r.dim)) };
    });
  }

  versionsMissingVector(model: string, limit: number): ArticleVersion[] {
    return (this.db.prepare(
      "SELECT v.* FROM article_versions v LEFT JOIN vectors x ON x.avid=v.avid AND x.model=? WHERE x.avid IS NULL LIMIT ?",
    ).all(model, limit) as Row[]).map(rowToVersion);
  }

  putVector(avid: string, model: string, vec: Float32Array): void {
    this.db.prepare("INSERT OR REPLACE INTO vectors(avid, model, dim, vec) VALUES(?,?,?,?)")
      .run(avid, model, vec.length, new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength));
  }

  // ---- writes -------------------------------------------------------------

  /** Import one reviewed pack. Identical re-import is a no-op; a changed one is refused. */
  importPack(pack: LegalPack): ImportResult {
    const errors = validatePack(pack);
    if (errors.length > 0) throw new Error(`invalid legal pack: ${errors.join("; ")}`);
    const leg = pack.legislation;
    const legKey = legislationKey(leg.type, leg.year, leg.number);
    const effective = leg.effectiveDate ?? leg.publishDate ?? leg.issueDate ?? "";
    const packHash = sha256(JSON.stringify(pack));
    const warnings: string[] = [];
    if (pack.source.provenance === "research_snapshot") {
      warnings.push("research_snapshot provenance: articles are searchable but can never be cited as VERIFIED");
    }

    return this.tx(() => {
      const prior = this.db.prepare("SELECT value FROM meta WHERE key=?").get(`pack:${legKey}`) as Row | undefined;
      if (prior) {
        if (s(prior.value) === packHash) {
          return { legKey, created: false, articles: 0, versions: 0, amendmentsApplied: 0, repealsApplied: 0, warnings: ["identical pack already imported"] };
        }
        throw new Error(`legislation ${legKey} was already imported from a different pack; use correctVersionText for corrections`);
      }
      const aliases = [...new Set([leg.titleAr, ...(leg.aliases ?? [])].map((a) => a.trim()).filter(Boolean))];
      const source: SourceRef = pack.source;
      this.db.prepare(`INSERT INTO legislations(key,type,year,number,title_ar,title_en,aliases_json,issue_date,publish_date,effective_date,status,source_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        legKey, leg.type, leg.year, leg.number, leg.titleAr.trim(), leg.titleEn ?? null, JSON.stringify(aliases),
        leg.issueDate ?? null, leg.publishDate ?? null, effective, leg.status ?? "in_force", JSON.stringify(source),
      );
      for (const alias of aliases) {
        this.db.prepare("INSERT OR IGNORE INTO legislation_aliases(alias_norm, leg_key) VALUES(?,?)").run(normalizeText(alias), legKey);
      }
      let versions = 0;
      for (const a of pack.articles) {
        const parsed = parseLabel(a.label);
        if (!parsed) continue; // validated above
        const part: ArticlePart = a.part ?? "body";
        const key = articleKey(legKey, part, parsed.label);
        this.db.prepare("INSERT INTO articles(key,leg_key,part,label,ordinal,heading) VALUES(?,?,?,?,?,?)")
          .run(key, legKey, part, parsed.label, parsed.ordinal, a.heading ?? null);
        this.insertVersion(key, a.text, effective, null, "original", undefined, source);
        versions++;
      }
      let amendmentsApplied = 0;
      for (const [i, m] of (pack.amends ?? []).entries()) {
        this.applyAmendment(legKey, `${legKey}#${i}`, m, m.effectiveDate ?? effective, source);
        amendmentsApplied++;
      }
      let repealsApplied = 0;
      for (const r of pack.repeals ?? []) {
        this.repealLegislation(r.legKey, legKey, r.effectiveDate ?? effective);
        repealsApplied++;
      }
      this.db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run(`pack:${legKey}`, packHash);
      return { legKey, created: true, articles: pack.articles.length, versions, amendmentsApplied, repealsApplied, warnings };
    });
  }

  /** Fix a transcription error in one version. The caller must audit this. */
  correctVersionText(avid: string, newText: string, verifiedBy: string): ArticleVersion {
    if (!newText.trim()) throw new Error("corrected text is empty");
    if (!verifiedBy.trim()) throw new Error("verifiedBy is required");
    return this.tx(() => {
      const v = this.getVersion(avid);
      if (!v) throw new Error(`unknown version ${avid}`);
      const source: SourceRef = { ...v.source, verifiedBy, verifiedAt: new Date().toISOString() };
      this.db.prepare("UPDATE article_versions SET text=?, text_sha256=?, source_json=? WHERE avid=?")
        .run(newText, sha256(newText), JSON.stringify(source), avid);
      this.db.prepare("DELETE FROM postings WHERE avid=?").run(avid);
      this.db.prepare("DELETE FROM vectors WHERE avid=?").run(avid);
      this.indexVersion(avid, v.articleKey, newText);
      const out = this.getVersion(avid);
      if (!out) throw new Error("correction lost the version");
      return out;
    });
  }

  private insertVersion(
    artKey: string, text: string, from: string, to: string | null,
    origin: "original" | "amendment", introducedBy: string | undefined, source: SourceRef,
  ): string {
    const avid = makeAvid(artKey, from);
    this.db.prepare(`INSERT INTO article_versions(avid,article_key,text,text_sha256,effective_from,effective_to,origin,introduced_by,provenance,source_json)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(avid, artKey, text, sha256(text), from, to, origin, introducedBy ?? null, source.provenance, JSON.stringify(source));
    this.indexVersion(avid, artKey, text);
    return avid;
  }

  private indexVersion(avid: string, artKey: string, text: string): void {
    const art = this.getArticle(artKey);
    const leg = art ? this.getLegislation(art.legKey) : undefined;
    const header = [art?.heading ?? "", leg?.titleAr ?? "", ...(leg?.aliases ?? [])].join(" ");
    const tf = termFrequencies(`${header}\n${text}`);
    let len = 0;
    const ins = this.db.prepare("INSERT OR REPLACE INTO postings(term, avid, tf) VALUES(?,?,?)");
    for (const [term, count] of tf) { ins.run(term, avid, count); len += count; }
    // Article number terms ("م171", "مادة171") let "المادة 171" queries hit exactly.
    if (art) ins.run(`#art:${art.label}`, avid, 1);
    if (leg) ins.run(`#leg:${leg.key}`, avid, 1);
    this.db.prepare("INSERT OR REPLACE INTO doc_len(avid, len) VALUES(?,?)").run(avid, len);
  }

  private applyAmendment(amendingLegKey: string, id: string, m: LegalPackAmendment, date: string, source: SourceRef): void {
    const parsed = parseLabel(m.target.label);
    if (!parsed) throw new Error(`invalid target label ${m.target.label}`);
    const target = this.getLegislation(m.target.legKey);
    if (!target) throw new Error(`amendment targets unknown legislation ${m.target.legKey}; import it first`);
    const key = articleKey(m.target.legKey, m.target.part ?? "body", parsed.label);
    const open = this.db.prepare("SELECT * FROM article_versions WHERE article_key=? AND effective_to IS NULL").get(key) as Row | undefined;
    const openVersion = open ? rowToVersion(open) : undefined;
    if (m.kind === "insert") {
      if (openVersion) throw new Error(`insert targets ${key}, which already has a version in force`);
      if (!this.getArticle(key)) {
        this.db.prepare("INSERT INTO articles(key,leg_key,part,label,ordinal,heading) VALUES(?,?,?,?,?,?)")
          .run(key, m.target.legKey, m.target.part ?? "body", parsed.label, parsed.ordinal, m.heading ?? null);
      } else {
        this.db.prepare("UPDATE articles SET repealed_at=NULL, repealed_by=NULL WHERE key=?").run(key);
      }
      this.insertVersion(key, m.newText ?? "", date, null, "amendment", amendingLegKey, source);
    } else {
      if (!openVersion) throw new Error(`${m.kind} targets ${key}, which has no version in force`);
      if (date <= openVersion.effectiveFrom) throw new Error(`amendment date ${date} must be after ${openVersion.effectiveFrom} for ${key}`);
      this.db.prepare("UPDATE article_versions SET effective_to=? WHERE avid=?").run(date, openVersion.avid);
      if (m.kind === "replace") {
        this.insertVersion(key, m.newText ?? "", date, null, "amendment", amendingLegKey, source);
        if (m.heading) this.db.prepare("UPDATE articles SET heading=? WHERE key=?").run(m.heading, key);
      } else {
        this.db.prepare("UPDATE articles SET repealed_at=?, repealed_by=? WHERE key=?").run(date, amendingLegKey, key);
      }
    }
    this.db.prepare(`INSERT INTO amendments(id,amending_leg_key,amending_article,target_article_key,kind,effective_date,new_text,heading,source_json)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id, amendingLegKey, m.amendingArticle, key, m.kind, date, m.newText ?? null, m.heading ?? null, JSON.stringify(source));
    const nextStatus: LegislationStatus = m.kind === "repeal" ? "partially_repealed" : "amended";
    if (target.status === "in_force" || (target.status === "amended" && nextStatus === "partially_repealed")) {
      this.db.prepare("UPDATE legislations SET status=? WHERE key=?").run(nextStatus, target.key);
    }
  }

  private repealLegislation(legKey: string, by: string, date: string): void {
    const leg = this.getLegislation(legKey);
    if (!leg) throw new Error(`repeal targets unknown legislation ${legKey}; import it first`);
    this.db.prepare("UPDATE legislations SET status='repealed', repealed_by=?, repealed_at=? WHERE key=?").run(by, date, legKey);
    const open = this.db.prepare(
      "SELECT v.avid, v.effective_from FROM article_versions v JOIN articles a ON a.key=v.article_key WHERE a.leg_key=? AND v.effective_to IS NULL",
    ).all(legKey) as Row[];
    for (const r of open) {
      if (date <= s(r.effective_from)) throw new Error(`repeal date ${date} precedes a version of ${legKey}`);
      this.db.prepare("UPDATE article_versions SET effective_to=? WHERE avid=?").run(date, s(r.avid));
    }
    this.db.prepare("UPDATE articles SET repealed_at=?, repealed_by=? WHERE leg_key=? AND repealed_at IS NULL").run(date, by, legKey);
  }
}

/** True when the version is in force on `asOf` (from inclusive, to exclusive). */
export function inForce(v: Pick<ArticleVersion, "effectiveFrom" | "effectiveTo">, asOf: string): boolean {
  return v.effectiveFrom <= asOf && (v.effectiveTo === null || asOf < v.effectiveTo);
}

/** Query terms used by retrieval (exported so search and tests agree). */
export function queryTermsFor(text: string): string[] {
  return legalTerms(text);
}
