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

  it("snaps inline styles to the studio's segment model (palette, size range, font pattern)", () => {
    assert.equal(docIO.nearestHighlight("#ffff00"), "yellow");
    assert.equal(docIO.nearestHighlight("#F0F000"), "yellow");
    assert.equal(docIO.nearestHighlight("#fefefe"), "white");
    assert.equal(docIO.nearestHighlight("red"), null);
    assert.equal(docIO.inlineFontSizePx(20), 20);
    assert.equal(docIO.inlineFontSizePx(14.33), 14.5);
    assert.equal(docIO.inlineFontSizePx(200), 144);
    assert.equal(docIO.inlineFontSizePx(2), 4);
    assert.equal(docIO.inlineFontSizePx(Number.NaN), null);
    assert.equal(docIO.inlineFontFamily('"Courier New"'), "Courier New");
    assert.equal(docIO.inlineFontFamily("Amiri"), "Amiri");
    assert.equal(docIO.inlineFontFamily("Bad<Font>"), null);
    assert.equal(docIO.inlineFontFamily(""), null);
  });

  it("maps inline span color/highlight/size/font styles onto block segments", async () => {
    const store = await import("../../studio/store.js");
    const baseline = { kind: "document", title: "t", revision: 0, content: { blocks: [] } } as Parameters<typeof docIO.htmlToBlocks>[1];
    const blocks = docIO.htmlToBlocks(
      "<p>"
      + '<span style="color:#ff0000">أحمر</span> <span style="background-color:#00ff00">أخضر</span> '
      + '<span style="font-size:20px">كبير</span> <span style="font-family:Tahoma">خط</span> عادي'
      + "</p>"
      + "<p><strong><span style=\"color:#00ff00\">غامق ملون</span></strong></p>",
      baseline,
    );
    assert.equal(blocks.length, 2);
    const segments = blocks[0]!.segments!;
    const byText = (text: string) => segments.find((segment) => segment.text === text);
    assert.equal(byText("أحمر")!.color, "#ff0000");
    assert.equal(byText("أخضر")!.highlight, "green");
    assert.equal(byText("كبير")!.size, 20);
    assert.equal(byText("خط")!.font, "Tahoma");
    // concatenated segments must reconstruct the block text exactly
    assert.equal(segments.map((segment) => segment.text).join(""), blocks[0]!.text);
    assert.equal(blocks[0]!.text, "أحمر أخضر كبير خط عادي");
    // a single uniformly colored paragraph keeps its segments (no bold/italic-only folding)
    const uniform = blocks[1]!.segments!;
    assert.equal(uniform.length, 1);
    assert.equal(uniform[0]!.bold, true);
    assert.equal(uniform[0]!.color, "#00ff00");
    // the produced segments must satisfy the studio's save validation
    store.validateStudio({ kind: "document", title: "t", revision: 1, content: { blocks } });
  });

  it("ignores inline styles the studio model cannot represent", () => {
    const baseline = { kind: "document", title: "t", revision: 0, content: { blocks: [] } } as Parameters<typeof docIO.htmlToBlocks>[1];
    const blocks = docIO.htmlToBlocks(
      '<p><span style="color:red;font-size:20pt;background-color:gradient(1)">س</span>'
      + '<span style="color:#0000ff">ص</span></p>',
      baseline,
    );
    const segments = blocks[0]!.segments!;
    // the unmappable spellings leave no trace; the valid hex maps through
    assert.equal(segments[0]!.text, "س");
    assert.equal(segments[0]!.color, undefined);
    assert.equal(segments[0]!.size, undefined);
    assert.equal(segments[0]!.highlight, undefined);
    assert.equal(segments[1]!.color, "#0000ff");
  });

  it("carries inline color/highlight/size/font through the save into the docx", async () => {
    fs.writeFileSync(path.join(tmpDir, "inline.docx"), await builderDocx());
    const loaded = await docIO.loadWorkspaceDoc(tmpDir, "inline.docx");
    const styled =
      '<span style="color:#ff0000">المقدمة</span> <span style="background-color:#ffff00">تحدد</span> '
      + '<span style="font-size:20px">أهداف</span> <span style="font-family:Tahoma">المشروع</span> بعناية.';
    const edited = loaded.html.replace("المقدمة تحدد أهداف المشروع بعناية.", styled);
    assert.notEqual(edited, loaded.html, "fixture edit must apply");
    const saved = await docIO.saveWorkspaceDoc(tmpDir, "inline.docx", edited);
    assert.equal(saved.ok, true);

    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(fs.readFileSync(path.join(tmpDir, "inline.docx")));
    const xml = await zip.file("word/document.xml")!.async("string");
    assert.ok(xml.includes('<w:color w:val="ff0000"'), "text color run property");
    assert.ok(xml.includes('<w:highlight w:val="yellow"'), "palette highlight run property");
    assert.ok(/<w:sz w:val="40"/.test(xml), "20px → 20pt → w:sz 40 half-points");
    assert.ok(/w:ascii="Tahoma"/.test(xml), "run font family");
  });
});
