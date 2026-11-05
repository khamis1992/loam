import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import JSZip from "jszip";
import { createDeckTools } from "../slides/tools.js";
import { createLocalFileTools } from "../localFileTools.js";
import { readPackProject } from "../present.js";
import { exportStudio } from "../../studio/export.js";
import type { Tool, ToolContext } from "../../tools/registry.js";
import type { AgentEvent } from "../../agent/events.js";

function context(workspace: string, events: AgentEvent[] = [], studioOptions?: Record<string, unknown>): ToolContext {
  return { cfg: { model: "test" } as never, workspace, taskId: "task_a1", packId: "loam-slides", emit: (event) => events.push(event), ...(studioOptions ? { studioOptions } : {}) };
}

function toolsByName(tools: Tool[]): Map<string, Tool> {
  return new Map(tools.map((tool) => [tool.name, tool]));
}

const slide = (index: number, title: string, body: string) => ({
  id: `slide-${index}`,
  title,
  body,
  notes: "مصادر المتحف الرسمية",
  background: "#F7F3EA",
  accent: "#187665",
});

describe("loam-slides service pack", () => {
  it("authors, reviews, exports and presents five Arabic Museum of Islamic Art slides", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-deck-a1-"));
    try {
      const tools = toolsByName(createDeckTools());
      assert.equal(tools.has("web_scaffold"), false);
      const ctx = context(workspace);
      const slides = [
        slide(1, "متحف الفن الإسلامي", "معلم ثقافي في الدوحة يجمع فنون الحضارة الإسلامية."),
        slide(2, "آي. إم. بي", "صمم المهندس المعماري I. M. Pei المبنى كتكوين هندسي مستلهم من العمارة الإسلامية."),
        slide(3, "افتتاح 2008", "افتتح المتحف عام 2008 على كورنيش الدوحة."),
        slide(4, "المجموعات", "تضم المقتنيات مخطوطات وخزفًا ومنسوجات من بلاد إسلامية متعددة."),
        slide(5, "تجربة الزيارة", "يجمع المتحف بين المعارض والتعليم والإطلالة البحرية."),
      ];
      const initialized = await tools.get("deck_init")!.run({ title: "متحف الفن الإسلامي في قطر", slides }, ctx);
      assert.equal(initialized.ok, true, initialized.content);
      const blocked = await tools.get("deck_present")!.run({}, ctx);
      assert.equal(blocked.ok, false);
      assert.match(blocked.content, /slide-1/);

      for (const item of slides) {
        const authored = await tools.get("deck_author")!.run({ id: item.id, slide: item }, ctx);
        assert.equal(authored.ok, true, authored.content);
        const reviewed = await tools.get("deck_review")!.run({ id: item.id }, ctx);
        assert.equal(reviewed.ok, true, reviewed.content);
      }
      const exported = await tools.get("deck_export")!.run({ format: "pptx" }, ctx);
      assert.equal(exported.ok, true, exported.content);
      const output = JSON.parse(exported.content) as { path: string; bytes: number };
      assert.ok(output.bytes > 1000);
      assert.ok(fs.statSync(path.join(workspace, output.path)).size > 1000);
      const zip = await JSZip.loadAsync(fs.readFileSync(path.join(workspace, output.path)));
      const xml = await zip.file("ppt/slides/slide2.xml")!.async("string");
      assert.match(xml, /rtl="1"/);
      assert.match(xml, /I\. M\. Pei/);
      const third = await zip.file("ppt/slides/slide3.xml")!.async("string");
      assert.match(third, /2008/);
      assert.equal(readPackProject(workspace, "loam-slides")?.items.every((item) => item.state === "final"), true);

      const events: AgentEvent[] = [];
      const presented = await tools.get("deck_present")!.run({}, context(workspace, events));
      assert.equal(presented.ok, true, presented.content);
      assert.equal(events.filter((event) => event.type === "artifact_published").length, 1);
      assert.match(presented.content, /loam-resource:\/\/loam-slides\/deck\/task_a1/);
      assert.equal(events.some((event) => event.type === "done"), false);

      const attached = await tools.get("deck_attach")!.run({}, ctx);
      assert.equal(attached.ok, true);
      assert.equal(readPackProject(workspace, "loam-slides")?.items.length, 5);
      const html = await tools.get("deck_export")!.run({ format: "html" }, ctx);
      assert.equal(html.ok, true, html.content);
      assert.match(html.content, /text\/html/);
      const image = await tools.get("deck_export")!.run({ format: "image" }, ctx);
      assert.match(image.content, /provider_not_configured/);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("returns only the removed slide id when slide 3 is removed mid-run", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-deck-a2-"));
    try {
      const tools = toolsByName(createDeckTools());
      const ctx = context(workspace);
      const slides = Array.from({ length: 5 }, (_, index) => ({ ...slide(index + 1, `عنوان ${index + 1}`, `محتوى ${index + 1}`), id: String(index + 1) }));
      await tools.get("deck_init")!.run({ title: "متحف الفن الإسلامي", slides }, ctx);
      for (const item of slides) {
        await tools.get("deck_author")!.run({ id: item.id, slide: item }, ctx);
        await tools.get("deck_review")!.run({ id: item.id }, ctx);
      }
      const organized = await tools.get("deck_organize")!.run({ remove: ["3"] }, ctx);
      assert.equal(organized.ok, true, organized.content);
      const presented = await tools.get("deck_present")!.run({}, ctx);
      assert.equal(presented.ok, false);
      assert.deepEqual(JSON.parse(presented.content).missing, ["3"]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("loam-localfile service pack", () => {
  it("preserves copy sources and guards edit-in-place writes with backups and conflicts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-local-a3-"));
    const workspace = path.join(root, "workspace");
    const external = path.join(root, "external");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(external, { recursive: true });
    const copySource = path.join(external, "copy.txt");
    const editSource = path.join(external, "edit.txt");
    const pptxSource = path.join(external, "edit.pptx");
    fs.writeFileSync(copySource, "ORIGINAL_COPY");
    fs.writeFileSync(editSource, "BASELINE");
    const office = await exportStudio({ kind: "presentation", title: "Deck", revision: 1, content: { slides: [slide(1, "الشريحة الأولى", "النص الأصلي"), slide(2, "الشريحة الثانية", "النص الثاني")] } }, workspace);
    fs.writeFileSync(pptxSource, office.buffer);
    try {
      const tools = toolsByName(createLocalFileTools());
      const ctx = context(workspace, [], { localFiles: [copySource, editSource, pptxSource], mode: "edit" });
      const copied = await tools.get("local_bind")!.run({ path: copySource, mode: "copy" }, ctx);
      assert.equal(copied.ok, true, copied.content);
      assert.equal(fs.readFileSync(copySource, "utf8"), "ORIGINAL_COPY");
      const denied = await tools.get("local_write_guarded")!.run({ id: "unknown", expectedSha256: "bad", text: "denied" }, ctx);
      assert.equal(denied.ok, false);

      const bound = await tools.get("local_bind")!.run({ path: editSource, mode: "edit" }, ctx);
      assert.equal(bound.ok, true, bound.content);
      const binding = (JSON.parse(bound.content) as { binding: { id: string; baselineSha256: string } }).binding;
      const written = await tools.get("local_write_guarded")!.run({ id: binding.id, expectedSha256: binding.baselineSha256, text: "EDITED" }, ctx);
      assert.equal(written.ok, true, written.content);
      assert.equal(fs.readFileSync(editSource, "utf8"), "EDITED");
      const writeResult = JSON.parse(written.content) as { backup: string; selfWatchKey: string; sha256: string };
      assert.ok(fs.existsSync(path.join(workspace, writeResult.backup)));
      assert.ok(writeResult.selfWatchKey.length > 10);

      fs.writeFileSync(editSource, "EXTERNAL_CHANGE");
      const conflict = await tools.get("local_write_guarded")!.run({ id: binding.id, expectedSha256: writeResult.sha256, text: "MUST_NOT_WRITE" }, ctx);
      assert.equal(conflict.ok, false);
      assert.match(conflict.content, /baseline_conflict/);
      assert.equal(fs.readFileSync(editSource, "utf8"), "EXTERNAL_CHANGE");
      const watched = await tools.get("local_watch")!.run({ id: binding.id }, ctx);
      assert.match(watched.content, /user_edit/);

      const boundPptx = await tools.get("local_bind")!.run({ path: pptxSource, mode: "edit" }, ctx);
      assert.equal(boundPptx.ok, true, boundPptx.content);
      const pptxBinding = (JSON.parse(boundPptx.content) as { binding: { id: string; baselineSha256: string } }).binding;
      const pptxWrite = await tools.get("local_write_guarded")!.run({ id: pptxBinding.id, expectedSha256: pptxBinding.baselineSha256, contentBase64: office.buffer.toString("base64") }, ctx);
      assert.equal(pptxWrite.ok, true, pptxWrite.content);
      const pptxResult = JSON.parse(pptxWrite.content) as { backup: string; sha256: string };
      assert.ok(fs.existsSync(path.join(workspace, pptxResult.backup)));
      fs.writeFileSync(pptxSource, "EXTERNAL_PPTX_CHANGE");
      const pptxConflict = await tools.get("local_write_guarded")!.run({ id: pptxBinding.id, expectedSha256: pptxResult.sha256, contentBase64: office.buffer.toString("base64") }, ctx);
      assert.equal(pptxConflict.ok, false);
      assert.match(pptxConflict.content, /baseline_conflict/);
      assert.equal(fs.readFileSync(pptxSource, "utf8"), "EXTERNAL_PPTX_CHANGE");
      assert.equal(fs.readFileSync(copySource, "utf8"), "ORIGINAL_COPY");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
