/**
 * Phase-2 W2 «تحدث مع ملفاتك»: task_files_ingest + the rag_* redirectors.
 *
 * task_files_ingest is the bulk door into the Knowledge Garden, so the
 * guarantees under test are the ones the ask/build experience leans on:
 *   1. it only ever imports files INSIDE the current task workspace (the walk
 *      is structural: no symlink following, no `..` refs in provenance);
 *   2. binaries, `.loam/` state, dotfiles and oversized files are skipped and
 *      reported, never guessed at;
 *   3. what it imports is immediately retrievable by kb_search — the same
 *      store, the same default base, [seed:ID] citations.
 *
 * The rag_* tools are redirectors now: rag_query must answer from the garden a
 * previous ingest filled (proving no path calls the absent external core), and
 * rag_index must land inline documents in the same garden and point at
 * task_files_ingest for the bulk case.
 *
 * The store is real (SQLite) behind a throwaway data directory per test, like
 * the other garden tests. No network and no model calls.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { closeDb } from "../../server/sqliteStore.js";
import { findBaseByName, deleteBase } from "../../knowledge/store.js";
import { createKnowledgeTools, createTaskFilesIngestTool } from "../knowledge.js";
import { createFrontierBridgeTools } from "../frontierBridge.js";
import type { ToolContext } from "../registry.js";

let tmpDir = "";
let ws = "";
let outside = "";
let prevDataDir: string | undefined;

function ctx(): ToolContext {
  return { cfg: {} as never, workspace: ws, emit: () => {}, taskId: "task_files_ingest_test" };
}

function resetGarden(): void {
  const base = findBaseByName("Knowledge Garden");
  if (base) deleteBase(base.id);
}

describe("task_files_ingest", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-task-ingest-"));
    ws = path.join(tmpDir, "task-ws");
    outside = path.join(tmpDir, "outside");
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    prevDataDir = process.env.MANUS_LOCAL_DATA_DIR;
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    closeDb();
  });

  afterEach(() => {
    closeDb();
    if (prevDataDir === undefined) delete process.env.MANUS_LOCAL_DATA_DIR;
    else process.env.MANUS_LOCAL_DATA_DIR = prevDataDir;
    try {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    tmpDir = "";
  });

  it("ingests the workspace's text files, skips binaries/.loam/oversized, stays contained", async () => {
    fs.writeFileSync(path.join(ws, "notes.md"), "# ملاحظات\nحديقة المعرفة تفلتر ملفات المهمة بالعربية.\n\n# تفاصيل\nسعر الاشتراك 99 ريالًا شهريًا.");
    fs.mkdirSync(path.join(ws, "src"));
    fs.writeFileSync(path.join(ws, "src", "app.ts"), "export const greet = () => 'مرحبا';\n".repeat(20));
    fs.writeFileSync(path.join(ws, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]));
    fs.mkdirSync(path.join(ws, ".loam"));
    fs.writeFileSync(path.join(ws, ".loam", "state.json"), '{"internal":true}');
    fs.writeFileSync(path.join(ws, "big.txt"), "x".repeat(4096));
    fs.writeFileSync(path.join(outside, "outside.md"), "ملف خارج مساحة المهمة لا يجوز استيراده");

    const res = await createTaskFilesIngestTool().run({ maxBytes: 2048 }, ctx());
    assert.equal(res.ok, true);
    // Arabic summary naming the ingested files.
    assert.match(res.content, /حديقة المعرفة/);
    assert.match(res.content, /notes\.md/);
    assert.match(res.content, /src\/app\.ts/);
    // The binary, the garden state dir and the oversized file never import;
    // the oversized one is at least reported as skipped.
    assert.doesNotMatch(res.content, /logo\.png/);
    assert.doesNotMatch(res.content, /\.loam/);
    assert.match(res.content, /big\.txt/);
    assert.ok(Array.isArray(res.kbSeedIds) && res.kbSeedIds.length > 0);

    // Containment: every seed's provenance ref is a workspace-relative path;
    // nothing from outside the workspace landed in the garden.
    const base = findBaseByName("Knowledge Garden");
    assert.ok(base, "ingestion must use the default garden base kb_search reads");
    assert.ok(base.seeds.length > 0);
    for (const seed of base.seeds) {
      const ref = seed.provenance?.ref ?? "";
      assert.ok(!ref.includes(".."), `provenance escaped the workspace: ${ref}`);
      assert.ok(!ref.startsWith("outside"), `file outside the task workspace was ingested: ${ref}`);
      assert.equal(seed.provenance?.source, "file");
      assert.ok(seed.tags.includes("task-files"));
    }
    assert.ok(base.seeds.some((s) => s.provenance?.ref === "notes.md"));
    assert.ok(!base.seeds.some((s) => (s.provenance?.ref ?? "").startsWith("outside")));
  });

  it("makes the ingested files immediately retrievable by kb_search", async () => {
    fs.writeFileSync(path.join(ws, "pricing.md"), "# الأسعار\nالخطة السنوية تكلف 1200 ريال وتشمل الدعم الفني.");

    assert.equal((await createTaskFilesIngestTool().run({}, ctx())).ok, true);
    const kbSearch = createKnowledgeTools().find((t) => t.name === "kb_search")!;
    const res = await kbSearch.run({ query: "الأسعار السنوية" }, ctx());
    assert.equal(res.ok, true);
    assert.match(res.content, /\[seed:/);
    assert.ok(Array.isArray(res.kbSeedIds) && res.kbSeedIds.length > 0);
  });

  it("honors pattern filters and stays honest when nothing matches", async () => {
    fs.writeFileSync(path.join(ws, "a.md"), "محتوى عربي مهم للفلترة");
    fs.writeFileSync(path.join(ws, "b.ts"), "export const x = 1;");

    const onlyMd = await createTaskFilesIngestTool().run({ patterns: ["*.md"] }, ctx());
    assert.equal(onlyMd.ok, true);
    assert.match(onlyMd.content, /a\.md/);
    assert.doesNotMatch(onlyMd.content, /b\.ts/);

    resetGarden();
    const none = await createTaskFilesIngestTool().run({ patterns: ["docs/**/*.md"] }, ctx());
    assert.equal(none.ok, false);
    assert.match(none.content, /لا ملفات نصية/);
  });
});

describe("rag redirectors (the broken frontier bridge is gone)", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-rag-redirect-"));
    ws = path.join(tmpDir, "task-ws");
    outside = path.join(tmpDir, "outside");
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    prevDataDir = process.env.MANUS_LOCAL_DATA_DIR;
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    closeDb();
  });

  afterEach(() => {
    closeDb();
    if (prevDataDir === undefined) delete process.env.MANUS_LOCAL_DATA_DIR;
    else process.env.MANUS_LOCAL_DATA_DIR = prevDataDir;
    try {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    tmpDir = "";
  });

  it("rag_query answers from the garden the task's files were ingested into", async () => {
    fs.writeFileSync(path.join(ws, "contract.md"), "# عقد\nمدة العقد سنتان قابلة للتجديد، وغرامة التأخير 2% شهريًا.");
    assert.equal((await createTaskFilesIngestTool().run({}, ctx())).ok, true);

    const ragQuery = createFrontierBridgeTools().find((t) => t.name === "rag_query")!;
    const res = await ragQuery.run({ query: "مدة العقد وغرامة التأخير", topK: 3 }, ctx());
    assert.equal(res.ok, true);
    // kb-backed answer: seed citations, not the dead external store.
    assert.match(res.content, /\[seed:/);
    assert.match(res.content, /العقد/);
    assert.ok(Array.isArray(res.kbSeedIds) && res.kbSeedIds.length > 0);
  });

  it("rag_index lands inline documents in the garden and points at task_files_ingest", async () => {
    const ragIndex = createFrontierBridgeTools().find((t) => t.name === "rag_index")!;
    const res = await ragIndex.run(
      { documents: [{ id: "d1", content: "قائمة المهام: تسليم التقرير النهائي يوم الخميس." }] },
      ctx(),
    );
    assert.equal(res.ok, true);
    assert.ok(Array.isArray(res.kbSeedIds) && res.kbSeedIds.length > 0);
    assert.match(res.content, /Knowledge Garden/);
    assert.match(res.content, /task_files_ingest/);

    const ragQuery = createFrontierBridgeTools().find((t) => t.name === "rag_query")!;
    const q = await ragQuery.run({ query: "موعد تسليم التقرير" }, ctx());
    assert.equal(q.ok, true);
    assert.match(q.content, /\[seed:/);
  });

  it("rag_index without documents fails honestly instead of calling the absent core", async () => {
    const ragIndex = createFrontierBridgeTools().find((t) => t.name === "rag_index")!;
    const res = await ragIndex.run({}, ctx());
    assert.equal(res.ok, false);
    assert.match(res.content, /task_files_ingest/);
    assert.doesNotMatch(res.content, /frontier tool|Frontier core/i);
  });
});
