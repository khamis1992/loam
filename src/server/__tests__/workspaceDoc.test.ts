import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, before, after } from "node:test";

type DocIO = typeof import("../workspace/docIO.js");
type Word = typeof import("../../studio/word.js");
type Docx = typeof import("docx");

let tmpDir: string;
let docIO: DocIO;
let word: Word;
let docx: Docx;

async function builderDocx(): Promise<Buffer> {
  const document = await word.createWordDocument({
    kind: "document",
    title: "خطة المشروع",
    revision: 1,
    content: {
      blocks: [
        { type: "heading", text: "خطة المشروع" },
        { type: "paragraph", text: "المقدمة تحدد أهداف المشروع بعناية." },
        { type: "paragraph", text: "فقرة غامزة للاختبار.", bold: true },
        { type: "bullet", text: "نقطة أولى" },
        { type: "bullet", text: "نقطة ثانية" },
        { type: "table", text: "", columns: ["المهمة", "الحالة"], rows: [["تصميم", "تم"], ["بناء", "قيد العمل"]] },
      ],
    },
  });
  return Buffer.from(await docx.Packer.toBuffer(document));
}

const buildComplexDocx = async (): Promise<Buffer> => {
  const document = await word.createWordDocument({
    kind: "document",
    title: "جدول معقد",
    revision: 1,
    content: { blocks: [{ type: "table", text: "", columns: Array.from({ length: 7 }, (_, i) => `c${i + 1}`), rows: [Array.from({ length: 7 }, (_, i) => `r${i}`)] }] },
  });
  return Buffer.from(await docx.Packer.toBuffer(document));
};

describe("workspace doc editor round trip", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-doc-workspace-"));
    docIO = await import("../workspace/docIO.js");
    word = await import("../../studio/word.js");
    docx = await import("docx");
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("renders editable html from a docx and saves edits back into the same file", async () => {
    fs.writeFileSync(path.join(tmpDir, "report.docx"), await builderDocx());

    const loaded = await docIO.loadWorkspaceDoc(tmpDir, "report.docx");
    assert.equal(loaded.editable, true, loaded.warnings.join(" "));
    assert.ok(loaded.html.startsWith("<!-- doc-session "));
    assert.ok(loaded.html.includes("<h1 data-s="), loaded.html);
    assert.ok(loaded.html.includes("المقدمة تحدد"));
    assert.ok(loaded.html.includes("<li data-s="), "bullets render as list items");
    assert.ok(loaded.html.includes('data-type="table"'), "tables survive rendering");

    const paragraphEdit = loaded.html
      .replace("خطة المشروع</strong></h1>", "الخطة المعدّلة</strong></h1>")
      .replace("المقدمة تحدد أهداف المشروع بعناية.", "المقدمة الجديدة بعد التعديل.");
    assert.notEqual(paragraphEdit, loaded.html, "fixture edits must apply");

    const saved = await docIO.saveWorkspaceDoc(tmpDir, "report.docx", paragraphEdit);
    assert.equal(saved.ok, true);
    assert.ok(saved.size >= 200);

    const reloaded = await docIO.loadWorkspaceDoc(tmpDir, "report.docx");
    assert.ok(reloaded.html.includes("الخطة المعدّلة"));
    assert.ok(reloaded.html.includes("المقدمة الجديدة بعد التعديل."));
    assert.ok(reloaded.html.includes("نقطة أولى"), "bullets survive the save round trip");
    assert.ok(reloaded.html.includes("قيد العمل"), "table survives the save round trip");
  });

  it("rejects a save whose marker is stale relative to the file mtime", async () => {
    fs.writeFileSync(path.join(tmpDir, "stale.docx"), await builderDocx());
    const loaded = await docIO.loadWorkspaceDoc(tmpDir, "stale.docx");
    fs.utimesSync(path.join(tmpDir, "stale.docx"), new Date(), new Date(Date.now() + 5000));
    await assert.rejects(
      () => docIO.saveWorkspaceDoc(tmpDir, "stale.docx", loaded.html),
      /أعد التحميل/,
    );
  });

  it("marks documents with unmodelled body elements as not editable", async () => {
    fs.writeFileSync(path.join(tmpDir, "complex.docx"), await buildComplexDocx());
    const loaded = await docIO.loadWorkspaceDoc(tmpDir, "complex.docx");
    assert.equal(loaded.editable, false);
    assert.match(loaded.warnings[0] ?? "", /غير مدعومة/);
  });
});
