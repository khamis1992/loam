/**
 * Design Studio unit tests (D1): template fill, brand kit storage, generate
 * step with an injected image tool, and agent-run tool exposure through the
 * always-on merge (TOOL EXPOSURE recipe).
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, before, after } from "node:test";

import type { Config } from "../../config.js";
import type { Emit } from "../../agent/events.js";
import type { ToolContext, ToolRegistry as RegistryType } from "../../tools/registry.js";

type DesignStudio = typeof import("../designStudio.js");
let ds: DesignStudio;
let createDesignStudioTools: () => ReturnType<typeof import("../../tools/designStudio.js").createDesignStudioTools>;
let mergeAlwaysOnTools: typeof import("../runTools.js").mergeAlwaysOnTools;
let ALWAYS_ON_TOOLS: readonly string[];
let ToolRegistry: typeof import("../../tools/registry.js").ToolRegistry;
let tmpDir = "";
let closeDb: () => void;

const BRIEF = "Promote the Friday nutrition workshop. Light, energetic session with meals and recipes.";

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-design-"));
  process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
  ds = await import("../designStudio.js");
  ({ createDesignStudioTools } = await import("../../tools/designStudio.js"));
  ({ mergeAlwaysOnTools, ALWAYS_ON_TOOLS } = await import("../runTools.js"));
  ({ ToolRegistry } = await import("../../tools/registry.js"));
  closeDb = (await import("../sqliteStore.js")).closeDb;
});

after(() => {
  closeDb();
  delete process.env.MANUS_LOCAL_DATA_DIR;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function ctx(workspace: string): ToolContext {
  return { cfg: {} as Config, workspace, emit: (() => undefined) as Emit };
}

describe("brief parsing + template fill", () => {
  it("parses title/subtitle/tags deterministically", () => {
    const p = ds.parseBrief(BRIEF);
    assert.strictEqual(p.title, "Promote the Friday nutrition workshop.");
    assert.ok(p.subtitle.includes("Light, energetic session"));
    assert.ok(p.tags.length > 0 && p.tags.length <= 3);
    assert.deepStrictEqual(ds.parseBrief(BRIEF), p, "parseBrief is deterministic");
  });

  it("rejects an empty brief", () => {
    assert.throws(() => ds.parseBrief("   "), /brief is required/);
  });

  it("fills the poster template with brand colors, fonts, and copy", () => {
    const brand = ds.saveBrandKit({
      name: "Acme Clinic",
      colors: { primary: "#123456", secondary: "#654321", accent: "#ABCDEF", background: "#101010", text: "#FFFFFF" },
      fonts: { heading: "Times, serif", body: "Arial, sans-serif" },
      logoRefs: ["uploads/logo.png"],
    });
    const spec = ds.fillTemplate("poster", brand, ds.parseBrief(BRIEF));
    assert.strictEqual(spec.templateId, "poster");
    assert.strictEqual(spec.canvas.width, 800);
    assert.strictEqual(spec.background, "#101010");
    const title = spec.slots.find((s) => s.id === "title")!;
    assert.strictEqual(title.color, "#ffffff");
    assert.strictEqual(title.font, "Times, serif");
    assert.strictEqual(title.text, "Promote the Friday nutrition workshop.");
    const badge = spec.slots.find((s) => s.id === "badge")!;
    assert.strictEqual(badge.color, "#123456");
    const logo = spec.slots.find((s) => s.id === "logo")!;
    assert.strictEqual(logo.src, "uploads/logo.png");
  });

  it("rejects unknown templates and picks templates from brief keywords", () => {
    const brand = ds.saveBrandKit({ name: "B" });
    assert.throws(() => ds.fillTemplate("nope", brand, ds.parseBrief(BRIEF)), /unknown design template/);
    assert.strictEqual(ds.pickTemplateId("make a wide website banner"), "banner");
    assert.strictEqual(ds.pickTemplateId("print poster for the event"), "poster");
    assert.strictEqual(ds.pickTemplateId(BRIEF), "social_card");
  });
});

describe("brand kit storage", () => {
  it("creates, lists, reads, updates, and deletes kits", () => {
    const created = ds.saveBrandKit({ name: "Alpha", colors: { primary: "#ff0000" } });
    assert.match(created.id, /^kit_/);
    assert.strictEqual(created.colors.primary, "#ff0000");
    assert.strictEqual(created.colors.secondary, ds.DEFAULT_BRAND.colors.secondary, "invalid/missing colors fall back");
    const updated = ds.saveBrandKit({ name: "Alpha 2", logoRefs: ["a.svg", "b.svg"] }, created.id);
    assert.strictEqual(updated.id, created.id);
    assert.strictEqual(updated.name, "Alpha 2");
    assert.deepStrictEqual(updated.logoRefs, ["a.svg", "b.svg"]);
    assert.ok(ds.listBrandKits().some((k) => k.id === created.id));
    assert.strictEqual(ds.getBrandKit(created.id)?.name, "Alpha 2");
    assert.strictEqual(ds.deleteBrandKit(created.id), true);
    assert.strictEqual(ds.getBrandKit(created.id), undefined);
    assert.strictEqual(ds.deleteBrandKit(created.id), false);
  });

  it("validates inputs", () => {
    assert.throws(() => ds.saveBrandKit({ colors: { primary: "#111111" } }), /name is required/);
    assert.throws(() => ds.saveBrandKit({ name: "X" }, "kit_missing"), /not found/);
    assert.strictEqual(ds.normalizeHex("not-a-color", "#000000"), "#000000");
    assert.strictEqual(ds.normalizeHex("#ABcDEF", "#000000"), "#abcdef");
  });
});

describe("generate step", () => {
  it("renders a builtin SVG design and stores a retrievable record", async () => {
    const kit = ds.saveBrandKit({ name: "Gen Brand" });
    const { record, spec } = await ds.generateDesign({ brief: BRIEF, brandKitId: kit.id });
    assert.match(record.id, /^design_/);
    assert.strictEqual(record.generator, "builtin-svg");
    assert.ok(fs.existsSync(record.specFile));
    assert.ok(fs.existsSync(record.svgFile));
    const svg = fs.readFileSync(record.svgFile, "utf8");
    assert.ok(svg.includes("<svg"));
    assert.ok(svg.includes("Promote"), `title text missing from svg: ${svg.slice(0, 400)}`);
    assert.strictEqual(spec.background, kit.colors.background);
    assert.strictEqual(ds.getDesign(record.id)?.id, record.id);
  });

  it("calls the injected image tool and keeps its outputs", async () => {
    const kit = ds.saveBrandKit({ name: "Injected" });
    let seenPrompt = "";
    const pngBase64 = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
    const { record } = await ds.generateDesign(
      { brief: "Design a launch banner", brandKitId: kit.id },
      {
        imageGen: async (req) => {
          seenPrompt = req.prompt;
          return { imageBase64Png: pngBase64, svg: "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>" };
        },
      },
    );
    assert.strictEqual(seenPrompt, "Design a launch banner");
    assert.strictEqual(record.generator, "injected-image-tool");
    assert.ok(record.imageFile && fs.existsSync(record.imageFile));
    assert.ok(fs.readFileSync(record.svgFile, "utf8").includes("<svg xmlns"));
  });

  it("falls back to the default brand when no kit exists", async () => {
    for (const k of ds.listBrandKits()) ds.deleteBrandKit(k.id);
    const { record, spec } = await ds.generateDesign({ brief: "A quiet note" });
    assert.strictEqual(record.brandKitId, "kit_default");
    assert.strictEqual(spec.background, ds.DEFAULT_BRAND.colors.background);
  });
});

describe("agent tool exposure (gateway + always-on)", () => {
  it("design tools are registered and reach the effective run tool list", () => {
    assert.ok(ALWAYS_ON_TOOLS.includes("design_create"), "design_create is always-on");
    assert.ok(ALWAYS_ON_TOOLS.includes("design_brand_kit_save"), "design_brand_kit_save is always-on");
    const registry = new ToolRegistry() as RegistryType;
    registry.registerAll(createDesignStudioTools());
    const names = registry.names();
    assert.ok(names.includes("design_create") && names.includes("design_brand_kit_save"));
    const runAllow = mergeAlwaysOnTools({ resolvedAllow: ["file_read"], registeredTools: names });
    assert.ok(runAllow.includes("design_create"), "merged run allowlist must expose design_create");
    const scoped = registry.forAllowlist(runAllow);
    assert.ok(scoped.names().includes("design_create"));
    assert.ok(scoped.toOllama().some((t) => t.function.name === "design_create"), "model sees design_create");
  });

  it("design_create runs end-to-end and returns files + preview", async () => {
    const tool = createDesignStudioTools().find((t) => t.name === "design_create")!;
    const res = await tool.run({ brief: BRIEF }, ctx(tmpDir));
    assert.ok(res.ok, res.content);
    const payload = JSON.parse(res.content) as { designId: string; template: string; svgFile: string; preview: string };
    assert.match(payload.designId, /^design_/);
    assert.ok(["poster", "banner", "social_card"].includes(payload.template));
    assert.ok(fs.existsSync(payload.svgFile));
    assert.ok(payload.preview.includes("title:"));
    const missing = await tool.run({}, ctx(tmpDir));
    assert.strictEqual(missing.ok, false);
    assert.match(missing.content, /brief is required/);
  });
});
