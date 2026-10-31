import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const SCRIPT = path.resolve("scripts/qatar-library-sync.mjs");
function makeSource(dir: string, state: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "search.db"); fs.rmSync(p, { force: true });
  const db = new DatabaseSync(p);
  db.exec("CREATE VIRTUAL TABLE docs USING fts5(kind,folder,title,ref,article,state,body,url UNINDEXED,file UNINDEXED)");
  const ins = db.prepare("INSERT INTO docs VALUES (?,?,?,?,?,?,?,?,?)");
  for (const f of ["laws", "regulations", "decisions", "rulings"]) {
    for (let i = 0; i < 20; i++) ins.run(f === "rulings" ? "ruling" : "legislation", f, "قانون العمل", "14/2004", `مادة ${i}`, i === 3 ? state : "نافذ", "قانون نص", "u", `${f}/a.md`);
    fs.mkdirSync(path.join(dir, f), { recursive: true }); fs.writeFileSync(path.join(dir, f, "a.md"), "# x");
  }
  db.close();
}
const run = (a: string[]): string => execFileSync(process.execPath, [SCRIPT, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

test("sync: install, unchanged, status flip summary, verified laws queued, source untouched", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qsync-"));
  const src = path.join(root, "src"), tgt = path.join(root, "lib");
  makeSource(src, "نافذ");
  const srcStat = fs.statSync(path.join(src, "search.db")).mtimeMs;
  assert.match(run(["--source", src, "--target", tgt]), /swapped in/);
  assert.match(run(["--source", src, "--target", tgt]), /unchanged/);
  assert.equal(fs.statSync(path.join(src, "search.db")).mtimeMs, srcStat);
  // a verified corpus law with the same ref
  const corpus = path.join(root, "qatar-law.db");
  const c = new DatabaseSync(corpus);
  c.exec("CREATE TABLE legislations(key TEXT, number INT, year INT); CREATE TABLE articles(key TEXT, leg_key TEXT); CREATE TABLE article_versions(article_key TEXT, provenance TEXT);");
  c.exec("INSERT INTO legislations VALUES('law/2004/14',14,2004); INSERT INTO articles VALUES('a','law/2004/14'); INSERT INTO article_versions VALUES('a','almeezan_manual');");
  c.close();
  makeSource(src, "ملغاة");
  assert.match(run(["--source", src, "--target", tgt, "--corpus", corpus]), /flips=3 review=3/);
  const queue = fs.readFileSync(path.join(tgt, "REVIEW_QUEUE.md"), "utf8");
  assert.match(queue, /14\/2004 مادة 3: نافذ -> ملغاة/);
  assert.ok(fs.existsSync(path.join(tgt, ".previous", "search.db")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("sync: >5% row drop fails and leaves the live library untouched", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qsync-"));
  const src = path.join(root, "src"), tgt = path.join(root, "lib");
  makeSource(src, "نافذ"); run(["--source", src, "--target", tgt]);
  const before = JSON.parse(fs.readFileSync(path.join(tgt, "manifest.json"), "utf8")).sha256;
  const db = new DatabaseSync(path.join(src, "search.db")); db.exec("DELETE FROM docs WHERE folder='laws' AND article IN ('مادة 1','مادة 2')"); db.close();
  assert.throws(() => run(["--source", src, "--target", tgt]));
  assert.equal(JSON.parse(fs.readFileSync(path.join(tgt, "manifest.json"), "utf8")).sha256, before);
  fs.rmSync(root, { recursive: true, force: true });
});
