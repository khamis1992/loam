import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import sharp from "sharp";
import { createPresentationBrief, planPresentationAssets, repairPresentationBrief, resolvePresentationAssets, slideBodyParts } from "../presentationPipeline.js";

const content = {
  title: "دولة الكويت",
  body: "تقع الكويت على ساحل الخليج العربي وعاصمتها مدينة الكويت. اللغة الرسمية هي العربية والعملة هي الدينار الكويتي. أبراج الكويت معلم وطني بارز، والديوانية تقليد اجتماعي أصيل.",
  background: "#F7F7F2",
  accent: "#007A33",
};

describe("PresentationPipeline", () => {
  it("keeps the full body while dividing it into three editable sections", () => {
    assert.deepEqual(slideBodyParts(content.body), [
      "تقع الكويت على ساحل الخليج العربي وعاصمتها مدينة الكويت.",
      "اللغة الرسمية هي العربية والعملة هي الدينار الكويتي.",
      "أبراج الكويت معلم وطني بارز، والديوانية تقليد اجتماعي أصيل.",
    ]);
  });

  it("uses the licensed Kuwait photo rather than generating a decorative asset", () => {
    const plan = planPresentationAssets("عرض بألوان علم الكويت");
    assert.match(plan.licensed?.path ?? "", /kuwait-towers\.jpg$/);
    assert.equal(plan.generate, undefined);
    assert.equal(planPresentationAssets("عرض عن الكويت").licensed, undefined);
  });

  it("builds an editorial brief and only repairs actionable crowding", () => {
    const image = planPresentationAssets("علم الكويت").licensed!;
    const brief = createPresentationBrief(content, "عرض عن الكويت بألوان علم الكويت", image)!;
    assert.equal(brief.layout, "editorial-cards");
    assert.equal(brief.facts.length, 4);
    assert.deepEqual(brief.headings, ["بطاقة البيانات الأساسية", "أبرز المعالم الوطنية", "اللغة الرسمية والعملة", "الموقع الجغرافي والعاصمة"]);
    assert.equal(brief.arabic, true);
    assert.equal(repairPresentationBrief(brief, ["text is clipped"])?.density, "compact");
    assert.equal(repairPresentationBrief(brief, ["make it more colorful"]), null);
    assert.equal(createPresentationBrief(content, "عرض عن الكويت"), null);
  });

  it("crops the real asset to the presentation frame inside the task", async () => {
    const taskRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loam-presentation-assets-"));
    try {
      const source = path.join(taskRoot, "source.png");
      await sharp({ create: { width: 300, height: 600, channels: 3, background: "#007A33" } }).png().toFile(source);
      const result = await resolvePresentationAssets({
        prompt: "عرض بألوان علم الكويت",
        taskRoot,
        generate: async () => source,
      });
      assert.ok(result.image);
      assert.equal(result.generated, false);
      const metadata = await sharp(result.image.path).metadata();
      assert.equal(metadata.width, 1180);
      assert.equal(metadata.height, 800);
      assert.ok(result.image.path.startsWith(taskRoot));
    } finally {
      fs.rmSync(taskRoot, { recursive: true, force: true });
    }
  });

  it("selects poster, photo and illustration tools by asset kind", async () => {
    assert.equal(planPresentationAssets("أنشئ ملصقًا")?.generate?.kind, "poster");
    assert.equal(planPresentationAssets("أضف شعارًا")?.generate?.requiresProvider, true);
    assert.equal(planPresentationAssets("أضف رسمًا توضيحيًا")?.generate?.kind, "illustration");
    const design = { imageNeeds: [{ role: "hero", description: "Real landmark photo", placement: "Center", alt: "Landmark" }] } as never;
    assert.equal(planPresentationAssets("عرض عام", design)?.generate?.kind, "image");
  });

  it("uses Design Studio for a poster and creates matching section icons", async () => {
    const taskRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loam-presentation-poster-"));
    try {
      const source = path.join(taskRoot, "poster.png");
      await sharp({ create: { width: 300, height: 300, channels: 3, background: "#F7F7F2" } }).png().toFile(source);
      const result = await resolvePresentationAssets({
        prompt: "أنشئ ملصقًا",
        taskRoot,
        createPoster: async () => ({ file: source, generator: "builtin-svg" }),
      });
      assert.equal(result.provider, "builtin-svg");
      assert.equal(result.generated, true);
      assert.equal(Object.keys(result.icons ?? {}).length, 4);
      assert.ok(result.image?.path.endsWith("presentation-hero.jpg"));
    } finally {
      fs.rmSync(taskRoot, { recursive: true, force: true });
    }
  });

  it("rejects a geometric local asset when a real photo is required", async () => {
    const taskRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loam-presentation-photo-"));
    try {
      const source = path.join(taskRoot, "local.png");
      await sharp({ create: { width: 30, height: 30, channels: 3, background: "#FFFFFF" } }).png().toFile(source);
      await assert.rejects(() => resolvePresentationAssets({
        prompt: "أضف شعارًا",
        taskRoot,
        generate: async () => ({ file: source, generator: "local-svg" }),
      }), /real image provider/);
    } finally {
      fs.rmSync(taskRoot, { recursive: true, force: true });
    }
  });

  it("falls back to the local canvas only for an illustration", async () => {
    const taskRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loam-presentation-illustration-"));
    try {
      const source = path.join(taskRoot, "illustration.png");
      await sharp({ create: { width: 30, height: 30, channels: 3, background: "#F7F7F2" } }).png().toFile(source);
      const result = await resolvePresentationAssets({
        prompt: "أضف رسمًا توضيحيًا",
        taskRoot,
        generate: async () => { throw new Error("image provider unavailable"); },
        createCanvas: async () => ({ file: source, generator: "local-svg" }),
      });
      assert.equal(result.generated, true);
      assert.ok(result.image);
    } finally {
      fs.rmSync(taskRoot, { recursive: true, force: true });
    }
  });

  it("rejects generated assets outside the task workspace", async () => {
    const taskRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loam-presentation-task-"));
    const outside = path.join(os.tmpdir(), "loam-outside-asset.png");
    try {
      await assert.rejects(() => resolvePresentationAssets({
        prompt: "أضف شعارًا",
        taskRoot,
        generate: async () => outside,
      }), /outside the task workspace/);
    } finally {
      fs.rmSync(taskRoot, { recursive: true, force: true });
    }
  });
});
