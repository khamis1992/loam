#!/usr/bin/env node
/**
 * Weekly sync of the Qatar law library into Loam (Node >= 22.13, node:sqlite).
 * Never writes to the source. Never touches the citable corpus (qatar-law.db);
 * it only READS it to flag status flips on laws a person already verified.
 *
 *   node scripts/qatar-library-sync.mjs --source <alaraf laws dir> --target <libraryPath>
 *        [--corpus <qatar-law.db>] [--force] [--dry-run]
 *
 * Steps: checksum detect -> copy to <target>/.staging -> integrity checks
 * (PRAGMA integrity_check, FTS sample query, per-folder counts within ±5% of
 * the previous manifest unless --force) -> change summary (status flips per
 * article) -> atomic swap (live -> .previous, staging -> live) -> manifest.json.
 * Exit codes: 0 ok/unchanged, 1 check failed (live library untouched), 2 usage.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const FOLDERS = ["laws", "regulations", "decisions", "rulings"];
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const flag = (k) => args.includes(`--${k}`);
const source = opt("source"), target = opt("target"), corpusPath = opt("corpus");
if (!source || !target) { console.error("usage: --source <dir> --target <dir> [--corpus db] [--force] [--dry-run]"); process.exit(2); }
const log = (m) => console.log(`[qatar-library-sync ${new Date().toISOString()}] ${m}`);

function sha256File(p) {
  const h = crypto.createHash("sha256"); const fd = fs.openSync(p, "r"); const buf = Buffer.alloc(1 << 20);
  let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  fs.closeSync(fd); return h.digest("hex");
}
const srcDb = path.join(source, "search.db");
if (!fs.existsSync(srcDb)) { console.error(`source search.db missing: ${srcDb}`); process.exit(1); }
fs.mkdirSync(target, { recursive: true });
const manifestPath = path.join(target, "manifest.json");
const prev = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;
const srcSha = sha256File(srcDb);
if (prev && prev.sha256 === srcSha && !flag("force")) { log(`unchanged (sha256 ${srcSha.slice(0, 12)})`); process.exit(0); }
log(`change detected: ${prev?.sha256?.slice(0, 12) ?? "none"} -> ${srcSha.slice(0, 12)}`);

const staging = path.join(target, ".staging");
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });
fs.copyFileSync(srcDb, path.join(staging, "search.db"));
for (const f of FOLDERS) if (fs.existsSync(path.join(source, f))) fs.cpSync(path.join(source, f), path.join(staging, f), { recursive: true });
for (const f of fs.readdirSync(source)) if (/^(\d{2}_.+|INDEX(_FULL)?)\.md$/.test(f)) fs.copyFileSync(path.join(source, f), path.join(staging, f));
if (sha256File(path.join(staging, "search.db")) !== srcSha) { console.error("source changed during copy; retry later"); process.exit(1); }

// ---- integrity
const failures = [];
const db = new DatabaseSync(path.join(staging, "search.db"), { readOnly: true });
const ic = db.prepare("PRAGMA integrity_check").get();
if (Object.values(ic)[0] !== "ok") failures.push(`integrity_check: ${JSON.stringify(ic)}`);
const counts = Object.fromEntries(db.prepare("SELECT folder, count(*) AS n FROM docs GROUP BY folder").all().map((r) => [r.folder, Number(r.n)]));
for (const f of FOLDERS) {
  if (!counts[f]) failures.push(`folder ${f} has 0 rows`);
  const before = prev?.counts?.[f];
  if (before && Math.abs(counts[f] - before) / before > 0.05 && !flag("force")) failures.push(`folder ${f}: ${before} -> ${counts[f]} rows (>5% change; rerun with --force after review)`);
}
const sample = db.prepare("SELECT count(*) AS n FROM docs WHERE docs MATCH ?").get('"قانون"');
if (!Number(sample.n)) failures.push("FTS sample query returned nothing");

// ---- change summary (status flips per document article)
const keyed = (d) => new Map(d.prepare("SELECT file, article, state, title, ref FROM docs WHERE kind = 'legislation'").all().map((r) => [`${r.file}#${r.article}`, r]));
const flips = []; let added = 0, removed = 0;
const liveDb = path.join(target, "search.db");
if (fs.existsSync(liveDb)) {
  const old = new DatabaseSync(liveDb, { readOnly: true });
  const a = keyed(old), b = keyed(db); old.close();
  for (const [k, r] of b) { const o = a.get(k); if (!o) added++; else if ((o.state ?? "") !== (r.state ?? "")) flips.push({ ref: r.ref, title: r.title, article: r.article, from: o.state || "؟", to: r.state || "؟", file: r.file }); }
  for (const k of a.keys()) if (!b.has(k)) removed++;
}
db.close();

// ---- verified laws in the citable corpus are never overwritten: only queued for review
let verifiedRefs = new Set();
if (corpusPath && fs.existsSync(corpusPath)) {
  const c = new DatabaseSync(corpusPath, { readOnly: true });
  verifiedRefs = new Set(c.prepare("SELECT DISTINCT l.number || '/' || l.year AS ref FROM legislations l JOIN articles a ON a.leg_key = l.key JOIN article_versions v ON v.article_key = a.key WHERE v.provenance <> 'research_snapshot'").all().map((r) => r.ref));
  c.close();
}
const review = flips.filter((f) => verifiedRefs.has(f.ref));
const stamp = new Date().toISOString().slice(0, 10);
const summary = [
  `# Qatar law library sync — ${stamp}`, "",
  `- source sha256: ${srcSha}`, `- previous: ${prev?.sha256 ?? "(first install)"}`,
  `- rows per folder: ${JSON.stringify(counts)}`, `- articles added: ${added} · removed: ${removed} · status flips: ${flips.length}`,
  `- flips touching VERIFIED corpus laws (review queue, corpus NOT changed): ${review.length}`,
  failures.length ? `- CHECKS FAILED: ${failures.join(" | ")}` : "- checks: ok", "",
  "> الوسوم مستنتجة من بيانات الميزان — تحقّق قبل الاستشهاد الحاسم.", "",
  "## Status flips", "", "| ref | article | from | to | title |", "|---|---|---|---|---|",
  ...flips.slice(0, 500).map((f) => `| ${f.ref} | ${f.article} | ${f.from} | ${f.to} | ${f.title} |`),
  flips.length > 500 ? `\n…${flips.length - 500} more` : "",
].join("\n");
const reportsDir = path.join(target, "sync-reports"); fs.mkdirSync(reportsDir, { recursive: true });
fs.writeFileSync(path.join(reportsDir, `${stamp}.md`), summary + "\n");
if (review.length) fs.appendFileSync(path.join(target, "REVIEW_QUEUE.md"), `\n## ${stamp}\n` + review.map((f) => `- [ ] ${f.ref} ${f.article}: ${f.from} -> ${f.to} (${f.title})`).join("\n") + "\n");
if (failures.length) { log(`checks failed, live library untouched: ${failures.join(" | ")}`); process.exit(1); }
if (flag("dry-run")) { log("dry run: not swapping"); process.exit(0); }

// ---- atomic swap (rename within the same volume). Close Loam first on Windows if a rename fails with EBUSY/EPERM.
const previous = path.join(target, ".previous");
fs.rmSync(previous, { recursive: true, force: true }); fs.mkdirSync(previous);
const live = fs.readdirSync(staging);
for (const name of live) if (fs.existsSync(path.join(target, name))) fs.renameSync(path.join(target, name), path.join(previous, name));
for (const name of live) fs.renameSync(path.join(staging, name), path.join(target, name));
fs.rmSync(staging, { recursive: true, force: true });
const manifest = { sha256: srcSha, syncedAt: new Date().toISOString(), source, counts, flips: flips.length, reviewQueue: review.length, previousSha256: prev?.sha256 ?? null };
fs.writeFileSync(manifestPath + ".tmp", JSON.stringify(manifest, null, 2)); fs.renameSync(manifestPath + ".tmp", manifestPath);
log(`swapped in. flips=${flips.length} review=${review.length}. report: ${path.join(reportsDir, `${stamp}.md`)}`);
