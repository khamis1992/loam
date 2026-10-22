/**
 * Design Studio agent-tool layer tests (tool exposure + hardening).
 *
 * Complements src/server/__tests__/designStudio.test.ts, which covers the pure
 * core (brief parsing, template fill, storage, generate). This file exercises
 * the Tool objects the model actually calls: input validation, the vision
 * image attachment, workspace mirroring, and the injected image-tool guard.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, before, after } from "node:test";

import type { Config } from "../../config.js";
import type { Emit } from "../../agent/events.js";
import type { ImageGenFn } from "../../server/designStudio.js";
import type { ToolContext } from "../registry.js";

type DesignStudioCore = typeof import("../../server/designStudio.js");
type DesignStudioTools = typeof import("../designStudio.js");

let core: DesignStudioCore;
let tools: DesignStudioTools;
let tmpDir = "";
let closeDb: () => void;

const BRIEF = "Promote the Friday nutrition workshop. Light, energetic session with meals and recipes.";

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-design-tools-"));
  process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
  core = await import("../../server/designStudio.js");
  tools = await import("../designStudio.js");
  closeDb = (await import("../../server/sqliteStore.js")).closeDb;
});

after(() => {
  closeDb();
  delete process.env.MANUS_LOCAL_DATA_DIR;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function ctx(workspace: string, taskId?: string): ToolContext {
  return { cfg: {} as Config, workspace, emit: (() => undefined) as Emit, ...(taskId ? { taskId } : {}) };
}

function createTool(imageGen?: ImageGenFn) {
  return tools.createDesignStudioTools(imageGen ? { imageGen } : {}).find((t) => t.name === "design_create")!;
}

function saveKitTool() {
  return tools.createDesignStudioTools().find((t) => t.name === "design_brand_kit_save")!;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("design_create input validation", () => {
  it("rejects an empty brief", async () => {
    const res = await createTool().run({ brief: "   " }, ctx(tmpDir));
    assert.strictEqual(res.ok, false);
    assert.match(res.content, /brief is required/);
  });

  it("fails loudly on an unknown explicit templateId instead of silently falling back", async () => {
    const res = await createTool().run({ brief: BRIEF, templateId: "billboard" }, ctx(tmpDir));
    assert.strictEqual(res.ok, false);
    assert.match(res.content, /unknown design template: billboard/);
    assert.match(res.content, /poster, banner, social_card/);
  });

  it("fails loudly on an unknown brandKitId", async () => {
    const res = await createTool().run({ brief: BRIEF, brandKitId: "kit_missing" }, ctx(tmpDir));
    assert.strictEqual(res.ok, false);
    assert.match(res.content, /unknown brand kit: kit_missing/);
  });

  it("accepts an explicit known templateId and echoes it back", async () => {
    const res = await createTool().run({ brief: BRIEF, templateId: "banner" }, ctx(tmpDir));
    assert.ok(res.ok, res.content);
    assert.strictEqual((JSON.parse(res.content) as { template: string }).template, "banner");
  });
});

describe("design_create output + vision attachment", () => {
  it("returns files and a filled-slot preview, and attaches the rendered PNG", async () => {
    const kit = core.saveBrandKit({ name: "Vision Brand" });
    const res = await createTool().run({ brief: BRIEF, brandKitId: kit.id }, ctx(tmpDir));
    assert.ok(res.ok, res.content);
    const payload = JSON.parse(res.content) as {
      designId: string; svgFile: string; imageFile: string | null; preview: string; workspaceFiles: string[];
    };
    assert.match(payload.designId, /^design_/);
    assert.ok(fs.existsSync(payload.svgFile));
    assert.ok(payload.preview.includes("title:"), payload.preview);
    assert.ok(payload.imageFile && fs.existsSync(payload.imageFile), "builtin sharp raster should exist");
    assert.ok(payload.workspaceFiles.length === 0, "no task context means no workspace mirror");
    assert.strictEqual(res.images?.length, 1, "the rendered PNG must be attached for vision");
    const attached = Buffer.from(res.images![0]!, "base64");
    assert.ok(attached.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC), "attachment must be PNG bytes");
  });

  it("omits the image attachment when the injected PNG exceeds the size cap", async () => {
    const oversized = Buffer.concat([PNG_MAGIC, Buffer.alloc(4 * 1024 * 1024)]);
    const kit = core.saveBrandKit({ name: "Huge Png" });
    const res = await createTool(async () => ({ imageBase64Png: oversized.toString("base64") })).run(
      { brief: "A launch banner", brandKitId: kit.id },
      ctx(tmpDir),
    );
    assert.ok(res.ok, res.content);
    assert.strictEqual(res.images, undefined, "oversized raster must not be attached");
  });

  it("omits the image attachment when the design has no raster", async () => {
    const kit = core.saveBrandKit({ name: "Svg Only" });
    const res = await createTool(async () => ({ svg: "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>" })).run(
      { brief: "An svg-only banner", brandKitId: kit.id },
      ctx(tmpDir),
    );
    assert.ok(res.ok, res.content);
    const payload = JSON.parse(res.content) as { imageFile: string | null };
    assert.strictEqual(payload.imageFile, null);
    assert.strictEqual(res.images, undefined);
  });
});

describe("design_create workspace mirroring", () => {
  it("mirrors the SVG and PNG into the task workspace when a task is active", async () => {
    const kit = core.saveBrandKit({ name: "Mirror Brand" });
    const res = await createTool().run({ brief: BRIEF, brandKitId: kit.id }, ctx(tmpDir, "task_design_mirror"));
    assert.ok(res.ok, res.content);
    const payload = JSON.parse(res.content) as { workspaceFiles: string[] };
    assert.strictEqual(payload.workspaceFiles.length, 2, "svg + png are mirrored");
    assert.ok(payload.workspaceFiles.every((f) => f.startsWith("design/")), payload.workspaceFiles.join(","));
    const mirrorDir = path.join(tmpDir, "design");
    assert.ok(fs.readdirSync(mirrorDir).some((f) => f.endsWith(".svg")), "svg mirrored into the task workspace");
    assert.ok(fs.readdirSync(mirrorDir).some((f) => f.endsWith(".png")), "png mirrored into the task workspace");
  });

  it("stays best-effort when the task workspace is unwritable", async () => {
    const kit = core.saveBrandKit({ name: "Unwritable" });
    const fileBlockingDir = path.join(tmpDir, "blocked");
    fs.writeFileSync(fileBlockingDir, "not a directory");
    const res = await createTool().run({ brief: BRIEF, brandKitId: kit.id }, ctx(fileBlockingDir, "task_design_blocked"));
    assert.ok(res.ok, `a mirror failure must not fail the tool: ${res.content}`);
    assert.deepStrictEqual((JSON.parse(res.content) as { workspaceFiles: string[] }).workspaceFiles, []);
  });
});

describe("design_brand_kit_save tool", () => {
  it("creates a kit and returns the stored record", async () => {
    const res = await saveKitTool().run({ name: "Tool Kit", colors: { primary: "#112233" } }, ctx(tmpDir));
    assert.ok(res.ok, res.content);
    const kit = JSON.parse(res.content) as { id: string; name: string; colors: { primary: string } };
    assert.match(kit.id, /^kit_/);
    assert.strictEqual(kit.name, "Tool Kit");
    assert.strictEqual(kit.colors.primary, "#112233");
    assert.strictEqual(core.getBrandKit(kit.id)?.name, "Tool Kit");
  });

  it("rejects a missing name", async () => {
    const res = await saveKitTool().run({ colors: { primary: "#112233" } }, ctx(tmpDir));
    assert.strictEqual(res.ok, false);
    assert.match(res.content, /name is required/);
  });

  it("reports an unknown id as not found instead of throwing", async () => {
    const res = await saveKitTool().run({ name: "X", id: "kit_missing" }, ctx(tmpDir));
    assert.strictEqual(res.ok, false);
    assert.match(res.content, /not found/);
  });

  it("coerces a non-string id to a clean not-found error", async () => {
    const res = await saveKitTool().run({ name: "X", id: { nope: true } }, ctx(tmpDir));
    assert.strictEqual(res.ok, false);
    assert.match(res.content, /not found/);
  });

  it("drops script-capable and non-image data logo refs", async () => {
    const res = await saveKitTool().run(
      { name: "Guarded", logoRefs: ["https://cdn.example.com/a.png", "uploads/logo.svg", "javascript:alert(1)", "data:text/html,<script>x</script>", "//evil.example/x"] },
      ctx(tmpDir),
    );
    assert.ok(res.ok, res.content);
    const refs = (JSON.parse(res.content) as { logoRefs: string[] }).logoRefs;
    assert.deepStrictEqual(refs, ["https://cdn.example.com/a.png", "uploads/logo.svg"]);
  });
});
