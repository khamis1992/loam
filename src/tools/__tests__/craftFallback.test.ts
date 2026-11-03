import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import JSZip from "jszip";
import { runNativeCraftFallback } from "../craftFallback.js";

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
