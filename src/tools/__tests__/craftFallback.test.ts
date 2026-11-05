import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import JSZip from "jszip";
import { runNativeCraftFallback } from "../craftFallback.js";
import { saveStudio, validateStudio } from "../../studio/store.js";

function ctx(workspace: string) {
  return { cfg: {} as never, workspace, emit: () => undefined, taskId: "task_fallback" } as never;
}

async function part(buffer: Buffer, name: string): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file(name);
  assert.ok(file, name);
  return file.async("string");
}

describe("native craft fallback", () => {
  it("writes a pptx, docx, and xlsx, and marks Arabic slides rtl", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-craft-fallback-"));
    try {
      const slides = await runNativeCraftFallback("slides", { title: "متحف الفن", instruction: "آي. إم. باي 2008", path: "deck.pptx" }, ctx(workspace));
      assert.equal(slides.ok, true);
      const pptx = fs.readFileSync(path.join(workspace, "deck.pptx"));
      const slide = await part(pptx, "ppt/slides/slide1.xml");
      assert.match(slide, /rtl="1"/);
      assert.match(slide, /باي/);

      const docs = await runNativeCraftFallback("docs", { title: "مذكرة", body: "نص", path: "memo.docx" }, ctx(workspace));
      assert.equal(docs.ok, true);
      assert.ok(fs.existsSync(path.join(workspace, "memo.docx")));
      await part(fs.readFileSync(path.join(workspace, "memo.docx")), "word/document.xml");

      const sheets = await runNativeCraftFallback("sheets", { title: "جدول", body: "1", path: "book.xlsx" }, ctx(workspace));
      assert.equal(sheets.ok, true);
      await part(fs.readFileSync(path.join(workspace, "book.xlsx")), "xl/worksheets/sheet1.xml");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("keeps the edited Arabic content and requested filename through open, edit, and export", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-craft-fallback-"));
    try {
      await runNativeCraftFallback("slides", { action: "open" }, ctx(workspace));
      await runNativeCraftFallback("slides", { action: "edit", title: "دولة الكويت", body: "العاصمة مدينة الكويت والعملة الدينار الكويتي", background: "#F7F3EA" }, ctx(workspace));
      const result = await runNativeCraftFallback("slides", { action: "export", title: "دولة الكويت", file: "دولة الكويت.pptx", accent: "#CE1126" }, ctx(workspace));
      assert.equal(result.ok, true, result.content);
      const saved = JSON.parse(result.content) as { path: string };
      assert.equal(saved.path, "uploads/دولة الكويت.pptx");
      const slide = await part(fs.readFileSync(path.join(workspace, saved.path)), "ppt/slides/slide1.xml");
      assert.match(slide, /دولة الكويت/);
      assert.match(slide, /العاصمة مدينة الكويت والعملة الدينار الكويتي/);
      assert.match(slide, /sz="4000"/);
      assert.match(slide, /sz="2400"/);
      assert.doesNotMatch(slide, /<a:t>عرض<\/a:t>/);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("fills an empty presentation instead of exporting a blank deck", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-craft-fallback-"));
    try {
      saveStudio(workspace, {
        kind: "presentation",
        title: "دولة قطر",
        content: { slides: [] },
      }, 0);
      const result = await runNativeCraftFallback("slides", {
        instruction: "شبه جزيرة على الخليج العربي وعاصمتها الدوحة",
        path: "qatar.pptx",
      }, ctx(workspace));
      assert.equal(result.ok, true);
      const studio = JSON.parse(fs.readFileSync(path.join(workspace, ".loam", "studio.json"), "utf8")) as {
        title: string;
        revision: number;
        content: { slides: Array<{ title: string; body: string }> };
      };
      assert.equal(studio.title, "دولة قطر");
      assert.equal(studio.revision, 2);
      assert.equal(studio.content.slides.length, 1);
      assert.match(studio.content.slides[0]!.body, /الدوحة/);
      const slide = await part(fs.readFileSync(path.join(workspace, "qatar.pptx")), "ppt/slides/slide1.xml");
      assert.match(slide, /الدوحة/);
      assert.match(slide, /rtl="1"/);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("accepts a slide that omits notes and body", () => {
    const clean = validateStudio({
      kind: "presentation",
      title: "دولة قطر",
      content: {
        slides: [{
          id: "overview",
          title: "دولة قطر",
          textBoxes: [
            { id: "t1", text: "الموقع", x: 8, y: 10, w: 80, h: 12 },
            { id: "t2", text: ["الدوحة", "2.7 مليون"], x: 8, y: 28, w: 80, h: 40 },
          ],
        }],
      },
    });
    assert.equal(clean.kind, "presentation");
    if (clean.kind !== "presentation" || !("slides" in clean.content)) return;
    assert.equal(clean.content.slides[0]!.notes, "");
    assert.equal(clean.content.slides[0]!.body, "");
    assert.equal(clean.content.slides[0]!.background, "#F7F3EA");
    const boxes = clean.content.slides[0]!.textBoxes ?? [];
    assert.equal(boxes[1]?.text, "الدوحة\n2.7 مليون");
  });

  it("returns fallback_unavailable for photo and design", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-craft-fallback-"));
    try {
      for (const app of ["photo", "design"]) {
        const result = await runNativeCraftFallback(app, { title: "x" }, ctx(workspace));
        assert.equal(result.ok, false);
        const body = JSON.parse(result.content) as { reason?: string; retry?: boolean };
        assert.equal(body.reason, "fallback_unavailable");
        assert.equal(body.retry, false);
      }
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
