import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { QatarLawLibrary, mapLibraryStatus, toFtsQuery, UNVERIFIED_WARNING_AR } from "../../legal/library.js";
import { normalizeLegalConfig } from "../../legal/config.js";
import { createQatarLibraryTools } from "../qatarLibraryTools.js";
import type { Tool, ToolContext } from "../registry.js";

function fixture(): { root: string; lib: QatarLawLibrary; tool: (n: string) => Tool } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qlib-"));
  const db = new DatabaseSync(path.join(root, "search.db"));
  db.exec("CREATE VIRTUAL TABLE docs USING fts5(kind,folder,title,ref,article,state,body,url UNINDEXED,file UNINDEXED,tokenize='unicode61 remove_diacritics 2')");
  const ins = db.prepare("INSERT INTO docs VALUES (?,?,?,?,?,?,?,?,?)");
  ins.run("legislation", "laws", "قانون العمل", "14/2004", "مادة 54", "نافذ", "يستحق العامل مكافأة نهاية الخدمة", "https://almeezan.qa/x", "laws/labour.md");
  ins.run("legislation", "laws", "قانون العمل", "14/2004", "مادة 55", "نافذ — معدّل", "مكافأة نهاية الخدمة تحسب", "https://almeezan.qa/x", "laws/labour.md");
  ins.run("legislation", "laws", "قانون قديم", "16/1971", "مادة 59  ملغاة", "ملغاة", "مكافأة نهاية الخدمة قديمة", "u", "laws/old.md");
  ins.run("ruling", "rulings", "محكمة التمييز", "طعن 1/2020", "المدنية", "", "مكافأة نهاية الخدمة في الطعن", "u", "rulings/r.md");
  db.close();
  fs.mkdirSync(path.join(root, "laws"));
  fs.writeFileSync(path.join(root, "laws", "labour.md"), "# قانون العمل\n**مادة 54** — [نافذ]");
  const lib = new QatarLawLibrary(root);
  const tools = new Map(createQatarLibraryTools(lib).map((t) => [t.name, t]));
  return { root, lib, tool: (n) => { const t = tools.get(n); assert.ok(t); return t; } };
}
const ctx = { cfg: {}, emit: () => {}, workspace: os.tmpdir(), taskId: "t" } as unknown as ToolContext;

test("status mapping covers all library tags incl. added and unknown", () => {
  assert.equal(mapLibraryStatus("نافذ"), "in_force");
  assert.equal(mapLibraryStatus("نافذ — معدّل"), "amended");
  assert.equal(mapLibraryStatus("نافذ — مضافة"), "added");
  assert.equal(mapLibraryStatus("[نص سابق (مستبدل)]"), "superseded");
  assert.equal(mapLibraryStatus("ملغاة"), "repealed");
  assert.equal(mapLibraryStatus(""), "unknown");
  assert.equal(mapLibraryStatus("شيء آخر"), "unknown");
});

test("plain words become quoted phrases; FTS syntax passes through", () => {
  assert.equal(toFtsQuery("مكافأة نهاية"), '"مكافأة" "نهاية"');
  assert.equal(toFtsQuery('"نهاية الخدمة"'), '"نهاية الخدمة"');
});

test("search returns unverified hits with inferred status, cleaned article label, folder filter", () => {
  const { lib, root } = fixture();
  const hits = lib.search("مكافأة نهاية الخدمة");
  assert.equal(hits.length, 4);
  assert.ok(hits.every((h) => h.verified === false && h.warning === UNVERIFIED_WARNING_AR));
  const old = hits.find((h) => h.ref === "16/1971")!;
  assert.equal(old.article, "مادة 59");
  assert.equal(old.status, "repealed");
  assert.equal(hits.find((h) => h.folder === "rulings")!.status, "unknown");
  assert.deepEqual(lib.search("مكافأة", { folder: "rulings" }).map((h) => h.folder), ["rulings"]);
  lib.close(); fs.rmSync(root, { recursive: true, force: true });
});

test("library is opened read-only", () => {
  const { lib, root } = fixture();
  lib.search("مكافأة");
  const st = fs.statSync(path.join(root, "search.db")).mtimeMs;
  lib.search("نهاية");
  assert.equal(fs.statSync(path.join(root, "search.db")).mtimeMs, st);
  assert.ok(!fs.existsSync(path.join(root, "search.db-wal")));
  lib.close(); fs.rmSync(root, { recursive: true, force: true });
});

test("qatar_library_search output carries the verify-before-cite banner and no cite token", async () => {
  const { tool, root, lib } = fixture();
  const r = await tool("qatar_library_search").run({ query: "مكافأة نهاية الخدمة" }, ctx);
  assert.ok(r.ok);
  assert.match(r.content, /تحقّق من الميزان قبل الاستشهاد/);
  assert.match(r.content, /غير مُتحقَّق/);
  assert.match(r.content, /حالة غير معروفة/);
  assert.doesNotMatch(r.content, /⟦cite:/);
  const bad = await tool("qatar_library_search").run({ query: "x", folder: "nope" }, ctx);
  assert.equal(bad.ok, false);
  lib.close(); fs.rmSync(root, { recursive: true, force: true });
});

test("qatar_library_doc reads library files only", async () => {
  const { tool, root, lib } = fixture();
  const r = await tool("qatar_library_doc").run({ file: "laws/labour.md" }, ctx);
  assert.ok(r.ok); assert.match(r.content, /مادة 54/); assert.match(r.content, /تحقّق/);
  assert.equal((await tool("qatar_library_doc").run({ file: "laws/../../etc/passwd.md" }, ctx)).ok, false);
  assert.equal((await tool("qatar_library_doc").run({ file: "/etc/passwd" }, ctx)).ok, false);
  lib.close(); fs.rmSync(root, { recursive: true, force: true });
});

test("missing library gives a clear install message", async () => {
  const lib = new QatarLawLibrary(path.join(os.tmpdir(), "no-such-qlib"));
  const [search] = createQatarLibraryTools(lib);
  const r = await search!.run({ query: "قانون" }, ctx);
  assert.equal(r.ok, false); assert.match(r.content, /not installed/);
});

test("legal.libraryPath is normalized", () => {
  assert.equal(normalizeLegalConfig({ libraryPath: " D:/lib " }).libraryPath, "D:/lib");
  assert.equal(normalizeLegalConfig({}).libraryPath, undefined);
});
