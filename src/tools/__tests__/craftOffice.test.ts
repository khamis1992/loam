/**
 * Unit tests for the `office_craft` agent tool (src/tools/craftOffice.ts).
 *
 * The workspace relay is mocked, so these tests never touch an editor, the
 * network or a real task stream: they assert the exact relay sequence each
 * action produces, the command-id validation, the fail-closed fallback contract
 * and the untouched `war_room` engine.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { after, describe, it } from "node:test";
import JSZip from "jszip";

import type { ToolContext } from "../../tools/registry.js";
import type { CraftOfficeApp, CraftOfficeRelayLike } from "../../tools/craftOffice.js";

interface Dispatched {
  taskId: string;
  target: string;
  method: string;
  params: Record<string, unknown>;
}

/** In-memory relay: records every dispatch and answers from a command catalog. */
class MockRelay implements CraftOfficeRelayLike {
  readonly dispatched: Dispatched[] = [];
  commands: unknown = [];
  /** When set, every dispatch throws this error (code + message). */
  failWith: { code?: string; message: string } | null = null;
  /** Answer for `craft.waitSave` (the exported task file). */
  saved: unknown = { path: "out/final.docx", bytes: 4096 };
  /** Answer for `document.inspect`. */
  document: unknown = { pages: 1, text: "hello" };
  /** Answer for `sheet.read`. */
  sheet: unknown = { range: "used", cells: 3 };
  /** Answer for `ui.inspect`. */
  ui: unknown = { zoom: 1 };
  /** Answer for `document.pixel`. */
  pixel: unknown = null;
  slide: unknown = { shapes: [] };
  exportBytes: Buffer | null = null;
  applyTextEdits = true;

  private async officeBytes(target: CraftOfficeApp): Promise<Buffer> {
    if (this.exportBytes) return this.exportBytes;
    const zip = new JSZip();
    if (target === "slides") {
      zip.file("ppt/presentation.xml", "<p:presentation/>");
      zip.file("ppt/slides/slide1.xml", "<p:sld><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val=\"FFFFFF\"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type=\"ctrTitle\"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:pPr/><a:r><a:rPr lang=\"ar-SA\"/><a:t>دولة الكويت</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type=\"subTitle\"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:pPr/><a:r><a:rPr sz=\"1800\" lang=\"ar-SA\"/><a:t>العاصمة مدينة الكويت</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>");
    } else {
      zip.file("xl/workbook.xml", "<workbook/>");
    }
    this.exportBytes = await zip.generateAsync({ type: "nodebuffer" });
    return this.exportBytes;
  }

  async enqueue(
    taskId: string,
    target: CraftOfficeApp,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    this.dispatched.push({ taskId, target, method, params });
    if (this.failWith) {
      throw Object.assign(new Error(this.failWith.message), { code: this.failWith.code });
    }
    if (method === "engine.commands") return this.commands;
    if (method === "ui.screenshot") return { base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" };
    if (method === "craft.waitSave") {
      const saved = this.saved as { path?: unknown } | null;
      if (saved && typeof saved.path === "string" && saved.path) {
        const absolute = path.join(ws, ".loam-tasks", taskId, saved.path);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        const bytes = saved.path.toLowerCase().endsWith(".pptx") ? await this.officeBytes("slides") : Buffer.from("stored-export");
        fs.writeFileSync(absolute, bytes);
      }
      return this.saved;
    }
    if (method === "document.inspect") return this.document;
    if (method === "sheet.read") return this.sheet;
    if (method === "ui.inspect") return this.ui;
    if (method === "craft.open") return { opened: params["path"] ?? null };
    if (method === "engine.execute" && params["command"] === "document.pixel" && this.pixel) return this.pixel;
    if (method === "engine.execute" && params["command"] === "image.crop" && this.pixel) {
      this.document = { documentWidth: 4, documentHeight: 4 };
      return this.document;
    }
    if (method === "engine.execute" && params["command"] === "document.inspect" && this.document && typeof this.document === "object" && ("width" in (this.document as object) || JSON.stringify(this.document).includes("documentWidth"))) {
      return this.document;
    }
    if (method === "engine.execute" && params["command"] === "slide.inspect") return this.slide;
    if (method === "engine.execute" && params["command"] === "text.set" && this.applyTextEdits) {
      const edit = params["params"] as { id?: string | number; text?: string };
      for (const holder of [this.slide, this.document]) {
        if (!holder || typeof holder !== "object") continue;
        for (const shape of (holder as { shapes?: Array<Record<string, unknown>> }).shapes ?? []) {
          if (shape.id === edit.id) shape.text = edit.text;
        }
      }
    }
    if (method === "engine.execute" && params["command"] === "file.saveBytes") {
      return { data: (await this.officeBytes(target)).toString("base64") };
    }
    if (method === "engine.execute" && params["command"] === "file.exportPdf" && target === "design") {
      return { base64: Buffer.from("%PDF-1.4 flyer").toString("base64"), bytes: 14 };
    }
    return { ok: true };
  }
}

const CATALOG = [
  "file.new",
  "file.save",
  "edit.undo",
  "edit.redo",
  "text.insert",
  "format.set",
  "file.exportPdf",
];

const {
  CRAFT_OFFICE_ACTIONS,
  CRAFT_OFFICE_APP_NAMES,
  CRAFT_OFFICE_APPS,
  CRAFT_OFFICE_FALLBACK_TOOL,
  CRAFT_OFFICE_FORMATS,
  CRAFT_OFFICE_INTERNAL_IDS,
  CRAFT_OFFICE_TOOL_NAMES,
  buildExportParams,
  craftOfficeAppFromAlias,
  craftOfficeDistDir,
  createCraftOfficeTool,
  installedCraftOfficeApps,
  isCraftOfficeAction,
  isCraftOfficeAppInstalled,
  isCraftOfficeFormat,
  isCraftOfficeMutatingAction,
  manualEditNotice,
  normalizeBatchSteps,
  resolveOfficeCommandId,
  parseSheetGrid,
  slideTextTargets,
  summarizeCraftState,
} = await import("../../tools/craftOffice.js");

let root = "";
let ws = "";
let relay: MockRelay;

function freshRoot(): void {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-oc-root-"));
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "loam-oc-ws-"));
}

/** Create the vendored dist + .vendor.json sidecar for one app. */
function installApp(app: CraftOfficeApp): void {
  const dir = craftOfficeDistDir(app, root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
  fs.writeFileSync(path.join(dir, ".vendor.json"), JSON.stringify({ rev: "abc123", source: "test" }));
}

function installAllApps(): void {
  for (const app of CRAFT_OFFICE_APPS) installApp(app);
}

function ctx(): ToolContext {
  return { cfg: {} as never, workspace: ws, emit: () => undefined, taskId: "task_1" } as never;
}

/** A solid RGB PNG big enough for the photo export to read its pixel size. */
function tinyPng(width: number, height: number, r: number, g: number, b: number): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.concat([Buffer.from(type), data]);
    let crc = ~0;
    for (const byte of head) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    head.copy(out, 4);
    out.writeUInt32BE(~crc >>> 0, 8 + data.length);
    return out;
  };
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

type FallbackCall = { app: string; action: string };

function tool(
  options: {
    withFallback?: { calls: FallbackCall[]; result?: { ok: boolean; content: string } };
    withWarRoom?: { calls: number };
  } = {},
): ReturnType<typeof createCraftOfficeTool> {
  return createCraftOfficeTool({
    relay,
    root,
    fallback: options.withFallback
      ? async (app, args) => {
          options.withFallback!.calls.push({ app, action: String(args["action"] ?? "") });
          return options.withFallback!.result ?? { ok: true, content: JSON.stringify({ builtin: app }) };
        }
      : undefined,
    warRoom: options.withWarRoom
      ? async (args) => {
          options.withWarRoom!.calls += 1;
          return { ok: true, content: JSON.stringify({ engine: "war_room", title: args["title"] ?? null }) };
        }
      : undefined,
  });
}

function methods(): string[] {
  return relay.dispatched.map((d) => d.method);
}

after(() => {
  for (const dir of [root, ws]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

// ---------------------------------------------------------------------------
// App aliases and constants
// ---------------------------------------------------------------------------

describe("craftOffice apps", () => {
  it("keeps the five apps in panel order with Loam brand names", () => {
    assert.deepEqual([...CRAFT_OFFICE_APPS], ["docs", "sheets", "slides", "photo", "design"]);
    assert.equal(CRAFT_OFFICE_APP_NAMES.docs, "Loam Docs");
    assert.equal(CRAFT_OFFICE_APP_NAMES.sheets, "Loam Sheets");
    assert.equal(CRAFT_OFFICE_APP_NAMES.slides, "Loam Slides");
    assert.equal(CRAFT_OFFICE_APP_NAMES.photo, "Loam Photo");
    assert.equal(CRAFT_OFFICE_APP_NAMES.design, "Loam Design");
  });

  it("resolves the canonical names, the internal ids and the legacy engine spellings", () => {
    assert.equal(craftOfficeAppFromAlias("docs"), "docs");
    assert.equal(craftOfficeAppFromAlias("wordcraft"), "docs");
    assert.equal(craftOfficeAppFromAlias("word"), "docs");
    assert.equal(craftOfficeAppFromAlias("excel"), "sheets");
    assert.equal(craftOfficeAppFromAlias("gridcraft"), "sheets");
    assert.equal(craftOfficeAppFromAlias("deck"), "slides");
    assert.equal(craftOfficeAppFromAlias("deckcraft"), "slides");
    assert.equal(craftOfficeAppFromAlias("photocraft"), "photo");
    assert.equal(craftOfficeAppFromAlias("designcraft"), "design");
  });

  it("normalises case, spaces and separators before matching", () => {
    assert.equal(craftOfficeAppFromAlias("  Loam Slides "), "slides");
    assert.equal(craftOfficeAppFromAlias("Loam_Design"), "design");
    assert.equal(craftOfficeAppFromAlias("loam-photo"), "photo");
  });

  it("returns null for an unknown or non-string app", () => {
    assert.equal(craftOfficeAppFromAlias("banana"), null);
    assert.equal(craftOfficeAppFromAlias(""), null);
    assert.equal(craftOfficeAppFromAlias(undefined), null);
    assert.equal(craftOfficeAppFromAlias(7), null);
  });

  it("maps each app to its internal vendored id and dist dir", () => {
    freshRoot();
    assert.deepEqual({ ...CRAFT_OFFICE_INTERNAL_IDS }, {
      docs: "wordcraft",
      sheets: "gridcraft",
      slides: "deckcraft",
      photo: "photocraft",
      design: "designcraft",
    });
    assert.equal(
      craftOfficeDistDir("slides", root),
      path.join(root, "electron", "craft", "deckcraft", "dist"),
    );
  });
});

// ---------------------------------------------------------------------------
// Actions, formats, batch normalisation, export params
// ---------------------------------------------------------------------------

describe("craftOffice action surface", () => {
  it("exposes the driver actions and marks the mutating ones", () => {
    assert.deepEqual(
      [...CRAFT_OFFICE_ACTIONS],
      ["open", "state", "commands", "execute", "batch", "export", "edit", "undo", "redo"],
    );
    for (const action of ["execute", "batch", "export", "edit", "undo", "redo"] as const) {
      assert.equal(isCraftOfficeMutatingAction(action), true, action);
    }
    for (const action of ["open", "state", "commands"] as const) {
      assert.equal(isCraftOfficeMutatingAction(action), false, action);
    }
  });

  it("validates action and format values", () => {
    assert.equal(isCraftOfficeAction("state"), true);
    assert.equal(isCraftOfficeAction("raw"), false);
    assert.equal(isCraftOfficeAction(1), false);
    assert.deepEqual([...CRAFT_OFFICE_FORMATS], ["native", "pdf", "png"]);
    assert.equal(isCraftOfficeFormat("pdf"), true);
    assert.equal(isCraftOfficeFormat("docx"), false);
  });

  it("resolves the first candidate the live catalog exposes", () => {
    assert.equal(resolveOfficeCommandId(["file.save", "edit.undo"], ["edit.undo", "history.undo"]), "edit.undo");
    assert.equal(resolveOfficeCommandId(["file.save"], ["edit.undo", "history.undo"]), null);
    assert.equal(resolveOfficeCommandId([], ["file.save"]), null);
  });

  it("normalises batch steps and reports the first malformed one", () => {
    const ok = normalizeBatchSteps([
      { command: "text.insert", params: { text: "hi" } },
      { command: "format.set" },
    ]);
    assert.deepEqual(ok, [
      { command: "text.insert", params: { text: "hi" } },
      { command: "format.set", params: {} },
    ]);
    assert.match(String(normalizeBatchSteps([])), /non-empty steps array/);
    assert.match(String(normalizeBatchSteps("nope")), /non-empty steps array/);
    assert.match(String(normalizeBatchSteps([null])), /steps\[0\] must be an object/);
    assert.match(String(normalizeBatchSteps([{ params: {} }])), /steps\[0\] is missing a "command" id/);
  });

  it("builds export params from the format, target file and caller params", () => {
    assert.deepEqual(buildExportParams("native", "out/a.docx", {}), { path: "out/a.docx" });
    assert.deepEqual(buildExportParams("native", "out/a.docx", { path: "custom.docx" }), { path: "custom.docx" });
    assert.deepEqual(buildExportParams("pdf", "out/a.pdf", {}), { path: "out/a.pdf", layout: "handouts" });
    assert.deepEqual(buildExportParams("pdf", "out/a.pdf", { layout: "notes" }), { path: "out/a.pdf", layout: "notes" });
    assert.deepEqual(buildExportParams("native", "", { quality: 90 }), { quality: 90 });
  });

  it("summarises state reads per app shape", () => {
    assert.deepEqual(
      summarizeCraftState("sheets", [
        { method: "sheet.read", ok: true, result: { range: "used" } },
        { method: "document.inspect", ok: true, result: { name: "wb" } },
      ]),
      { app: "sheets", name: "Loam Sheets", document: { name: "wb" }, usedRange: { range: "used" } },
    );
    assert.deepEqual(
      summarizeCraftState("photo", [
        { method: "document.inspect", ok: true, result: { w: 10 } },
        { method: "ui.inspect", ok: true, result: { zoom: 2 } },
      ]),
      { app: "photo", name: "Loam Photo", document: { w: 10 }, ui: { zoom: 2 } },
    );
    assert.deepEqual(summarizeCraftState("docs", [{ method: "document.inspect", ok: false }]), {
      app: "docs",
      name: "Loam Docs",
      failedReads: ["document.inspect"],
    });
  });

  it("notices incomplete state reads so the agent adapts", () => {
    assert.equal(manualEditNotice(null), null);
    assert.equal(manualEditNotice({ reads: [{ method: "document.inspect", ok: true }], summary: {} }), null);
    assert.match(
      String(manualEditNotice({ reads: [{ method: "ui.inspect", ok: false }], summary: {} })),
      /ui\.inspect/,
    );
  });
});

// ---------------------------------------------------------------------------
// Tool schema + branding
// ---------------------------------------------------------------------------

describe("craftOffice tool schema", () => {
  it("is still named office_craft and exposes the app/action/engine enums", () => {
    freshRoot();
    relay = new MockRelay();
    const t = tool();
    assert.equal(t.name, "office_craft");
    assert.deepEqual([...CRAFT_OFFICE_TOOL_NAMES], ["office_craft"]);
    const props = (t.parameters as { properties: Record<string, { enum?: string[] }> }).properties;
    assert.deepEqual(props["app"]!.enum, [...CRAFT_OFFICE_APPS]);
    assert.deepEqual(props["action"]!.enum, [...CRAFT_OFFICE_ACTIONS]);
    assert.deepEqual(props["format"]!.enum, [...CRAFT_OFFICE_FORMATS]);
    assert.deepEqual(props["engine"]!.enum, ["word", "excel", "deck", "studio", "war_room"]);
  });

  it("guides the model through the read/validate/verify/export loop", () => {
    freshRoot();
    relay = new MockRelay();
    const description = tool().description;
    for (const appName of Object.values(CRAFT_OFFICE_APP_NAMES)) {
      assert.ok(description.includes(appName), `description should name ${appName}`);
    }
    assert.ok(description.includes("never invent"), "must forbid inventing command ids");
    assert.ok(description.includes("read the current state"), "must require a state read first");
    assert.ok(description.includes("war_room"), "must document the untouched war_room engine");
    assert.ok(description.includes(CRAFT_OFFICE_FALLBACK_TOOL), "must name the fallback tool");
  });

  it("never leaks an upstream project name", () => {
    freshRoot();
    relay = new MockRelay();
    const t = tool();
    const surface = `${t.description} ${JSON.stringify(t.parameters)}`;
    for (const internal of Object.values(CRAFT_OFFICE_INTERNAL_IDS)) {
      assert.ok(!surface.includes(internal), `internal id ${internal} must stay internal`);
    }
    for (const upstream of ["WordCraft", "GridCraft", "DeckCraft", "PhotoCraft", "DesignCraft"]) {
      assert.ok(!surface.includes(upstream), `${upstream} must never appear`);
    }
  });
});

// ---------------------------------------------------------------------------
// Availability + fail-closed fallback
// ---------------------------------------------------------------------------

describe("craftOffice availability", () => {
  it("reports a missing dist as a fallback without touching the panel", async () => {
    freshRoot();
    relay = new MockRelay();
    assert.equal(isCraftOfficeAppInstalled("docs", root), false);
    const res = await tool().run({ app: "docs", action: "state" }, ctx());
    assert.equal(res.ok, false);
    const body = JSON.parse(res.content) as { fallback: string; reason: string; message: string };
    assert.equal(body.fallback, CRAFT_OFFICE_FALLBACK_TOOL);
    assert.equal(body.reason, "craft_dist_missing");
    assert.match(body.message, /Loam Docs/);
    assert.deepEqual(relay.dispatched, []);
  });

  it("detects installed dists and lists only those apps", () => {
    freshRoot();
    assert.deepEqual(installedCraftOfficeApps(root), []);
    installApp("sheets");
    installApp("photo");
    assert.equal(isCraftOfficeAppInstalled("sheets", root), true);
    assert.equal(isCraftOfficeAppInstalled("docs", root), false);
    const previous = process.env.LOAM_CRAFT_DISABLED;
    process.env.LOAM_CRAFT_DISABLED = "1";
    try {
      assert.equal(isCraftOfficeAppInstalled("sheets", root), false);
    } finally {
      if (previous === undefined) delete process.env.LOAM_CRAFT_DISABLED;
      else process.env.LOAM_CRAFT_DISABLED = previous;
    }
    assert.deepEqual(installedCraftOfficeApps(root), ["sheets", "photo"]);
  });

  it("runs the built-in implementation when the dist is missing", async () => {
    freshRoot();
    relay = new MockRelay();
    const withFallback = { calls: [] as FallbackCall[] };
    const res = await tool({ withFallback }).run({ app: "slides", action: "state" }, ctx());
    assert.equal(res.ok, true);
    assert.deepEqual(withFallback.calls, [{ app: "slides", action: "state" }]);
    const body = JSON.parse(res.content) as { fallback: string; fallbackReason: string };
    assert.equal(body.fallback, CRAFT_OFFICE_FALLBACK_TOOL);
    assert.match(body.fallbackReason, /not installed/);
    assert.deepEqual(relay.dispatched, []);
  });

  it("honours fallback:true even when the dist is installed", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    const withFallback = { calls: [] as FallbackCall[] };
    const res = await tool({ withFallback }).run({ app: "docs", action: "execute", fallback: true }, ctx());
    assert.equal(res.ok, true);
    assert.deepEqual(withFallback.calls, [{ app: "docs", action: "execute" }]);
    assert.deepEqual(relay.dispatched, []);
  });

  it("fails clearly when fallback:true is requested with no built-in wired", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    const res = await tool().run({ app: "docs", action: "state", fallback: true }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.content, /fallback_unavailable/);
  });
});

// ---------------------------------------------------------------------------
// Engines: war_room (untouched) and legacy studio
// ---------------------------------------------------------------------------

describe("craftOffice engines", () => {
  it("routes engine:war_room to the untouched handler and skips the relay", async () => {
    freshRoot();
    relay = new MockRelay();
    const withWarRoom = { calls: 0 };
    const res = await tool({ withWarRoom }).run({ engine: "war_room", title: "خطة" }, ctx());
    assert.equal(res.ok, true);
    assert.equal(withWarRoom.calls, 1);
    const body = JSON.parse(res.content) as { engine: string; title: string };
    assert.equal(body.engine, "war_room");
    assert.equal(body.title, "خطة");
    assert.deepEqual(relay.dispatched, []);
  });

  it("reports war_room as unavailable when no handler is wired", async () => {
    freshRoot();
    relay = new MockRelay();
    const res = await tool().run({ engine: "war_room" }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.content, /war_room_unavailable/);
  });

  it("sends the legacy studio engine to the built-in implementation", async () => {
    freshRoot();
    relay = new MockRelay();
    const withFallback = { calls: [] as FallbackCall[] };
    const res = await tool({ withFallback }).run({ engine: "studio", prompt: "make a report" }, ctx());
    assert.equal(res.ok, true);
    assert.deepEqual(withFallback.calls, [{ app: "docs", action: "" }]);
    assert.deepEqual(relay.dispatched, []);
  });

  it("reports the legacy studio engine as unavailable without a built-in", async () => {
    freshRoot();
    relay = new MockRelay();
    const res = await tool().run({ engine: "studio" }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.content, /fallback_unavailable/);
  });

  it("keeps the legacy word/excel/deck engines generating files when no action is given", async () => {
    freshRoot();
    relay = new MockRelay();
    const withFallback = { calls: [] as FallbackCall[] };
    const res = await tool({ withFallback }).run({ engine: "excel", title: "أرقام" }, ctx());
    assert.equal(res.ok, true);
    assert.deepEqual(withFallback.calls, [{ app: "sheets", action: "" }]);
    assert.deepEqual(relay.dispatched, []);
  });

  it("drives the Craft editor for a legacy engine once an action is given", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    const withFallback = { calls: [] as FallbackCall[] };
    const res = await tool({ withFallback }).run({ engine: "excel", action: "state" }, ctx());
    assert.equal(res.ok, true, res.content);
    assert.deepEqual(withFallback.calls, []);
    assert.deepEqual(relay.dispatched.map((d) => d.target), ["sheets", "sheets"]);
  });
});

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

describe("craftOffice argument validation", () => {
  it("needs an app", async () => {
    freshRoot();
    relay = new MockRelay();
    const res = await tool().run({ action: "state" }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.content, /needs an app/);
  });

  it("rejects an unknown app", async () => {
    freshRoot();
    relay = new MockRelay();
    const res = await tool().run({ app: "banana", action: "state" }, ctx());
    assert.equal(res.ok, false);
    const body = JSON.parse(res.content) as { message: string };
    assert.match(body.message, /unknown app "banana"/);
  });

  it("rejects an unknown action", async () => {
    freshRoot();
    relay = new MockRelay();
    const res = await tool().run({ app: "docs", action: "raw" }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.content, /action must be one of/);
  });

  it("needs a task id", async () => {
    freshRoot();
    relay = new MockRelay();
    const res = await createCraftOfficeTool({ relay, root }).run({ app: "docs", action: "state" }, {
      cfg: {} as never,
      workspace: ws,
      emit: () => undefined,
    } as never);
    assert.equal(res.ok, false);
    assert.match(res.content, /requires a taskId/);
  });
});

// ---------------------------------------------------------------------------
// Panel-driven actions
// ---------------------------------------------------------------------------

describe("craftOffice state and commands", () => {
  it("state reads only the app's state methods", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    const res = await tool().run({ app: "sheets", action: "state" }, ctx());
    assert.equal(res.ok, true, res.content);
    assert.deepEqual(relay.dispatched, [
      { taskId: "task_1", target: "sheets", method: "sheet.read", params: { range: "used" } },
      { taskId: "task_1", target: "sheets", method: "document.inspect", params: {} },
    ]);
    const body = JSON.parse(res.content) as { summary: { usedRange: unknown }; notice: unknown };
    assert.deepEqual(body.summary.usedRange, { range: "used", cells: 3 });
    assert.equal(body.notice, null);
  });

  it("state defaults the action when it is omitted", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    const res = await tool().run({ app: "docs" }, ctx());
    assert.equal(res.ok, true, res.content);
    assert.deepEqual(methods(), ["document.inspect"]);
  });

  it("reports state_unavailable when the panel never answers", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.failWith = { code: "PANEL_NOT_OPEN", message: "no panel" };
    const res = await tool().run({ app: "docs", action: "state" }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.content, /state_unavailable/);
  });

  it("commands returns the raw catalog and its count", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = CATALOG.map((id) => ({ id, label: id }));
    const res = await tool().run({ app: "docs", action: "commands" }, ctx());
    assert.equal(res.ok, true, res.content);
    assert.deepEqual(methods(), ["engine.commands", "engine.commands"]);
    const body = JSON.parse(res.content) as { count: number; commands: unknown[] };
    assert.equal(body.count, CATALOG.length);
    assert.equal(body.commands.length, CATALOG.length);
  });

  it("returns only commands that match the search", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = [
      { id: "file.new", label: "New" },
      { id: "image.crop", label: "Crop", params: "{\"width\":px}" },
      { id: "actions.save", label: "Save" },
    ];
    const res = await tool().run({ app: "photo", action: "commands", search: "crop" }, ctx());
    assert.equal(res.ok, true, res.content);
    const body = JSON.parse(res.content) as { count: number; commands: Array<{ id: string }> };
    assert.deepEqual(body.commands.map((command) => command.id), ["image.crop"]);
    assert.equal(body.count, 1);
  });

  it("passes the search term through on commands and omits it otherwise", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    await tool().run({ app: "sheets", action: "commands", search: "bold" }, ctx());
    assert.deepEqual(relay.dispatched.map((d) => d.params), [{ search: "bold" }, { search: "bold" }]);
    relay.dispatched.length = 0;
    await tool().run({ app: "sheets", action: "commands" }, ctx());
    assert.deepEqual(relay.dispatched.map((d) => d.params), [{}, {}]);
  });

  it("surfaces a relay failure on commands", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.failWith = { message: "boom" };
    const res = await tool().run({ app: "docs", action: "commands" }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.content, /bridge_unavailable/);
  });
});

describe("craftOffice open", () => {
  it("opens an attached file then reads the state", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    const res = await tool().run({ app: "docs", action: "open", file: "in/report.docx" }, ctx());
    assert.equal(res.ok, true, res.content);
    assert.deepEqual(relay.dispatched, [
      { taskId: "task_1", target: "docs", method: "craft.open", params: { path: "in/report.docx" } },
      { taskId: "task_1", target: "docs", method: "document.inspect", params: {} },
    ]);
    const body = JSON.parse(res.content) as { file: string; summary: unknown };
    assert.equal(body.file, "in/report.docx");
    assert.ok(body.summary);
  });

  it("creates a new document through the catalog when no file is given", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = CATALOG;
    const res = await tool().run({ app: "docs", action: "open" }, ctx());
    assert.equal(res.ok, true, res.content);
    assert.deepEqual(methods(), ["engine.commands", "engine.execute", "document.inspect"]);
    const execute = relay.dispatched.find((d) => d.method === "engine.execute")!;
    assert.deepEqual(execute.params, { command: "file.new", params: {} });
    const body = JSON.parse(res.content) as { file: unknown };
    assert.equal(body.file, null);
  });

  it("refuses to invent a new-document command the build does not expose", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = ["text.insert", "format.set"];
    const res = await tool().run({ app: "docs", action: "open" }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.content, /does not expose/);
    assert.ok(!methods().includes("engine.execute"), "must not guess a command id");
  });
});

describe("craftOffice execute", () => {
  it("validates the id, runs it, then re-reads the state", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = CATALOG;
    const res = await tool().run(
      { app: "docs", action: "execute", command: "text.insert", params: { text: "hi" } },
      ctx(),
    );
    assert.equal(res.ok, true, res.content);
    assert.deepEqual(methods(), ["engine.commands", "document.inspect", "engine.execute", "document.inspect"]);
    const execute = relay.dispatched.find((d) => d.method === "engine.execute")!;
    assert.deepEqual(execute.params, { command: "text.insert", params: { text: "hi" } });
    const body = JSON.parse(res.content) as { command: string; before: unknown; summary: unknown };
    assert.equal(body.command, "text.insert");
    assert.ok(body.before, "a mutating action reports the pre-edit state");
    assert.ok(body.summary);
  });

  it("refuses an unknown command id with close matches and the available ids", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = CATALOG;
    const res = await tool().run({ app: "docs", action: "execute", command: "file.sav" }, ctx());
    assert.equal(res.ok, false);
    const body = JSON.parse(res.content) as { message: string };
    assert.match(body.message, /unknown command id "file\.sav"/);
    assert.match(body.message, /Close matches: file\.save/);
    assert.match(body.message, /Available commands:/);
    assert.ok(!methods().includes("engine.execute"));
  });

  it("needs a command id", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = CATALOG;
    const res = await tool().run({ app: "docs", action: "execute" }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.content, /needs a command id/);
  });

  it("skips validation when the app returns no catalog", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = [];
    const res = await tool().run({ app: "docs", action: "execute", command: "anything" }, ctx());
    assert.equal(res.ok, true, res.content);
    assert.ok(methods().includes("engine.execute"));
  });

  it("reports panel_not_open with a retry hint", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = CATALOG;
    relay.failWith = { code: "PANEL_NOT_OPEN", message: "no panel" };
    const res = await tool().run({ app: "docs", action: "execute", command: "file.save" }, ctx());
    assert.equal(res.ok, false);
    const body = JSON.parse(res.content) as { reason: string; retry: boolean };
    assert.equal(body.reason, "panel_not_open");
    assert.equal(body.retry, false);
  });
});

describe("craftOffice batch", () => {
  it("runs the steps in order and reports the completed count", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = CATALOG;
    const res = await tool().run(
      {
        app: "docs",
        action: "batch",
        steps: [
          { command: "text.insert", params: { text: "a" } },
          { command: "format.set", params: { bold: true } },
        ],
      },
      ctx(),
    );
    assert.equal(res.ok, true, res.content);
    const executed = relay.dispatched.filter((d) => d.method === "engine.execute");
    assert.deepEqual(executed.map((d) => d.params["command"]), ["text.insert", "format.set"]);
    const body = JSON.parse(res.content) as { completed: number; steps: unknown[] };
    assert.equal(body.completed, 2);
    assert.equal(body.steps.length, 2);
  });

  it("stops at the first unknown id and reports the failed step", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = CATALOG;
    const res = await tool().run(
      {
        app: "docs",
        action: "batch",
        steps: [{ command: "text.insert" }, { command: "nope.nope" }],
      },
      ctx(),
    );
    assert.equal(res.ok, false);
    const body = JSON.parse(res.content) as { failedStep: number; command: string; completed: number };
    assert.equal(body.failedStep, 1);
    assert.equal(body.command, "nope.nope");
    assert.equal(body.completed, 1);
    assert.deepEqual(
      relay.dispatched.filter((d) => d.method === "engine.execute").map((d) => d.params["command"]),
      ["text.insert"],
    );
  });

  it("reports a rejected step as a command_rejected failure", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = CATALOG;
    let calls = 0;
    const original = relay.enqueue.bind(relay);
    relay.enqueue = async (taskId, target, method, params) => {
      if (method === "engine.execute") {
        calls += 1;
        if (calls === 2) throw Object.assign(new Error("bad params"), { code: "COMMAND_REJECTED" });
      }
      return original(taskId, target, method, params);
    };
    const res = await tool().run(
      { app: "docs", action: "batch", steps: [{ command: "text.insert" }, { command: "format.set" }] },
      ctx(),
    );
    assert.equal(res.ok, false);
    const body = JSON.parse(res.content) as { reason: string; failedStep: number; message: string };
    assert.equal(body.reason, "command_rejected");
    assert.equal(body.failedStep, 1);
    assert.match(body.message, /refused step 1/);
  });

  it("surfaces a panel failure during a batch with the failed step attached", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = CATALOG;
    let calls = 0;
    const original = relay.enqueue.bind(relay);
    relay.enqueue = async (taskId, target, method, params) => {
      if (method === "engine.execute") {
        calls += 1;
        if (calls === 2) throw Object.assign(new Error("no panel"), { code: "PANEL_NOT_OPEN" });
      }
      return original(taskId, target, method, params);
    };
    const res = await tool().run(
      { app: "docs", action: "batch", steps: [{ command: "text.insert" }, { command: "format.set" }] },
      ctx(),
    );
    assert.equal(res.ok, false);
    const body = JSON.parse(res.content) as { reason: string; failedStep: number; completed: number };
    assert.equal(body.reason, "panel_not_open");
    assert.equal(body.failedStep, 1);
    assert.equal(body.completed, 1);
  });

  it("needs a non-empty steps array", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = CATALOG;
    const res = await tool().run({ app: "docs", action: "batch", steps: [] }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.content, /non-empty steps array/);
  });
});

describe("craftOffice export, undo and redo", () => {
  it("replaces an uncropped photo export with the document pixels", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = ["file.new", "file.save", "image.crop"];
    relay.document = { documentWidth: 4, documentHeight: 4 };
    relay.pixel = { r: 255, g: 80, b: 80 };
    const taskRoot = path.join(ws, ".loam-tasks", "task_1");
    fs.mkdirSync(path.join(taskRoot, "uploads"), { recursive: true });
    fs.mkdirSync(path.join(taskRoot, "attachments"), { recursive: true });
    const wide = tinyPng(8, 4, 200, 0, 0);
    fs.writeFileSync(path.join(taskRoot, "attachments", "photo.png"), wide);
    fs.writeFileSync(path.join(taskRoot, "uploads", "1-edited.png"), wide);
    const res = await tool().run({ app: "photo", action: "export", format: "png", params: "{\"path\":\"edited.png\"}" }, ctx());
    assert.equal(res.ok, true, res.content);
    const body = JSON.parse(res.content) as { command: string; path: string };
    assert.equal(body.command, "document.pixel");
    const saved = fs.readFileSync(path.join(taskRoot, body.path));
    assert.equal(saved.readUInt32BE(16), 4);
    assert.equal(saved.readUInt32BE(20), 4);
  });

  it("uses a nested document size and an array pixel", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = ["file.new", "file.save", "image.crop"];
    relay.document = { width: 8, height: 4, frame: { documentWidth: 4, documentHeight: 4 } };
    relay.pixel = [255, 80, 80];
    const taskRoot = path.join(ws, ".loam-tasks", "task_1");
    fs.mkdirSync(path.join(taskRoot, "uploads"), { recursive: true });
    fs.mkdirSync(path.join(taskRoot, "attachments"), { recursive: true });
    const wide = tinyPng(8, 4, 200, 0, 0);
    fs.writeFileSync(path.join(taskRoot, "attachments", "photo.png"), wide);
    fs.writeFileSync(path.join(taskRoot, "uploads", "1-edited.png"), wide);
    const res = await tool().run({ app: "photo", action: "export", format: "png", params: "{\"path\":\"edited.png\"}" }, ctx());
    assert.equal(res.ok, true, res.content);
    const body = JSON.parse(res.content) as { command: string; path: string };
    assert.equal(body.command, "document.pixel");
    const saved = fs.readFileSync(path.join(taskRoot, body.path));
    assert.equal(saved.readUInt32BE(16), 4);
    assert.equal(saved.readUInt32BE(20), 4);
  });

  it("applies the export crop when the open document is still the source size", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = ["file.new", "file.save", "image.crop"];
    relay.document = { width: 8, height: 4, canUndo: false };
    relay.pixel = [255, 80, 80];
    const taskRoot = path.join(ws, ".loam-tasks", "task_1");
    fs.mkdirSync(path.join(taskRoot, "uploads"), { recursive: true });
    fs.mkdirSync(path.join(taskRoot, "attachments"), { recursive: true });
    const wide = tinyPng(8, 4, 200, 0, 0);
    fs.writeFileSync(path.join(taskRoot, "attachments", "photo.png"), wide);
    const res = await tool().run(
      { app: "photo", action: "export", format: "png", params: "{\"path\":\"edited.png\",\"crop\":{\"x\":2,\"y\":0,\"width\":4,\"height\":4},\"brightness\":40,\"contrast\":10}" },
      ctx(),
    );
    assert.equal(res.ok, true, res.content);
    const body = JSON.parse(res.content) as { path: string };
    const saved = fs.readFileSync(path.join(taskRoot, body.path));
    assert.equal(saved.readUInt32BE(16), 4);
    assert.equal(saved.readUInt32BE(20), 4);
  });

  it("exports through craft.waitSave and returns the stored path", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = CATALOG;
    const res = await tool().run({ app: "docs", action: "export", file: "out/final.docx" }, ctx());
    assert.equal(res.ok, true, res.content);
    const wait = relay.dispatched.find((d) => d.method === "craft.waitSave")!;
    assert.deepEqual(wait.params, { command: "file.save", params: {}, name: "final.docx" });
    const body = JSON.parse(res.content) as { format: string; path: string; command: string };
    assert.equal(body.format, "native");
    assert.equal(body.command, "file.save");
    assert.equal(body.path, "out/final.docx");
  });

  it("passes pdf layout params and resolves the pdf export command", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = CATALOG;
    const res = await tool().run({ app: "docs", action: "export", format: "pdf", file: "out/a.pdf" }, ctx());
    assert.equal(res.ok, true, res.content);
    const wait = relay.dispatched.find((d) => d.method === "craft.waitSave")!;
    assert.deepEqual(wait.params, { command: "file.exportPdf", params: { path: "out/a.pdf", layout: "handouts" }, name: "a.pdf" });
  });

  it("exports a design pdf without the slides handout layout", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = CATALOG;
    const res = await tool().run({ app: "design", action: "export", format: "pdf", params: "{\"path\":\"flyer.pdf\"}" }, ctx());
    assert.equal(res.ok, true, res.content);
    const saved = relay.dispatched.find((d) => d.method === "engine.execute" && (d.params["command"] as string) === "file.exportPdf")!;
    assert.deepEqual(saved.params, { command: "file.exportPdf", params: {} });
    const body = JSON.parse(res.content) as { command: string; path: string };
    assert.equal(body.command, "file.exportPdf");
    const fileBytes = fs.readFileSync(path.join(ws, ".loam-tasks", "task_1", body.path));
    assert.equal(fileBytes.subarray(0, 5).toString("latin1"), "%PDF-");
  });

  it("rejects an unknown export format", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = CATALOG;
    const res = await tool().run({ app: "docs", action: "export", format: "docx" }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.content, /format must be one of/);
  });

  it("refuses an export command the build does not expose", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = ["text.insert"];
    const res = await tool().run({ app: "docs", action: "export", format: "pdf" }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.content, /does not expose/);
    assert.ok(!methods().includes("craft.waitSave"));
  });

  it("resolves undo and redo from the catalog", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = CATALOG;
    const undo = await tool().run({ app: "docs", action: "undo" }, ctx());
    assert.equal(undo.ok, true, undo.content);
    assert.equal((JSON.parse(undo.content) as { command: string }).command, "edit.undo");
    const redo = await tool().run({ app: "docs", action: "redo" }, ctx());
    assert.equal(redo.ok, true, redo.content);
    assert.equal((JSON.parse(redo.content) as { command: string }).command, "edit.redo");
  });

  it("refuses undo when the build exposes no history command", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = ["text.insert"];
    const res = await tool().run({ app: "docs", action: "undo" }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.content, /does not expose/);
  });
});

// ---------------------------------------------------------------------------
// Relay error mapping
// ---------------------------------------------------------------------------

describe("craftOffice relay error mapping", () => {
  it("maps a cancelled task to a fallback envelope", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = CATALOG;
    relay.failWith = { code: "CANCELLED", message: "stopped" };
    const res = await tool().run({ app: "docs", action: "execute", command: "file.save" }, ctx());
    assert.equal(res.ok, false);
    const body = JSON.parse(res.content) as { reason: string; fallback: string };
    assert.equal(body.reason, "cancelled");
    assert.equal(body.fallback, CRAFT_OFFICE_FALLBACK_TOOL);
  });

  it("maps an app rejection to a command_rejected fallback with a fix hint", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = CATALOG;
    relay.failWith = { code: "COMMAND_REJECTED", message: "no document open" };
    const res = await tool().run({ app: "docs", action: "execute", command: "file.save" }, ctx());
    assert.equal(res.ok, false);
    const body = JSON.parse(res.content) as { reason: string; hint: string };
    assert.equal(body.reason, "command_rejected");
    assert.match(body.hint, /retrying it unchanged will fail again/);
  });

  it("maps an unknown relay failure to bridge_unavailable", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = CATALOG;
    relay.failWith = { message: "socket closed" };
    const res = await tool().run({ app: "docs", action: "execute", command: "file.save" }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.content, /bridge_unavailable/);
  });
});

describe("craftOffice slide edit", () => {
  it("writes and confirms the title and body of the current slide", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = [...CATALOG, "slide.inspect", "text.set", "file.export", "design.background"];
    relay.slide = {
      shapes: [
        { id: 10, kind: "placeholder", placeholder: "ctrTitle", text: "" },
        { id: 11, kind: "placeholder", placeholder: "body", text: "" },
      ],
    };
    relay.document = relay.slide;
    const res = await tool().run(
      { app: "slides", action: "edit", title: "متحف الفن الإسلامي", body: "صممه آي. إم. باي عام 2008.", background: "#E8F5E9" },
      ctx(),
    );
    assert.equal(res.ok, true, res.content);
    const writes = relay.dispatched.filter((call) => call.method === "engine.execute" && call.params["command"] === "text.set");
    assert.deepEqual(
      writes.map((call) => call.params["params"]),
      [
        { id: 10, text: "متحف الفن الإسلامي" },
        { id: 11, text: "صممه آي. إم. باي عام 2008." },
      ],
    );
    assert.deepEqual(relay.dispatched.find((call) => call.params["command"] === "design.background")?.params["params"], { color: "#E8F5E9" });
  });

  it("rejects placeholder slide content before issuing an edit", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = [...CATALOG, "slide.inspect", "text.set"];
    const res = await tool().run({ app: "slides", action: "edit", title: "دولة الكويت", body: "<Arabic body>" }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.content, /real slide content/);
    assert.equal(relay.dispatched.some((call) => call.params["command"] === "text.set"), false);
  });

  it("fails when the live slide does not confirm the edit", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = [...CATALOG, "slide.inspect", "text.set"];
    relay.applyTextEdits = false;
    relay.slide = { shapes: [{ id: 10, kind: "placeholder", placeholder: "ctrTitle", text: "" }, { id: 11, kind: "placeholder", placeholder: "body", text: "" }] };
    relay.document = relay.slide;
    const res = await tool().run({ app: "slides", action: "edit", title: "دولة الكويت", body: "العاصمة مدينة الكويت" }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.content, /did not confirm/);
  });

  it("exports a valid slides deck with a meaningful filename", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = [...CATALOG, "file.export", "file.save", "file.saveBytes"];
    const res = await tool().run({ app: "slides", action: "export", title: "دولة الكويت", accent: "#CE1126", background: "#F7F3EA" }, ctx());
    assert.equal(res.ok, true, res.content);
    const body = JSON.parse(res.content) as { command: string; path: string };
    assert.equal(body.command, "file.saveBytes");
    assert.match(body.path, /^uploads\/\d+-دولة الكويت\.pptx$/);
    const written = fs.readFileSync(path.join(ws, ".loam-tasks", "task_1", body.path));
    const zip = await JSZip.loadAsync(written);
    assert.ok(zip.file("ppt/presentation.xml"));
    assert.ok(zip.file("ppt/slides/slide1.xml"));
    const slide = await zip.file("ppt/slides/slide1.xml")!.async("string");
    assert.match(slide, /CE1126/);
    assert.match(slide, /007A33/);
    assert.match(slide, /F7F3EA/);
    assert.match(slide, /<a:rPr lang="ar-SA" sz="4000"\/>/);
    assert.match(slide, /<a:rPr lang="ar-SA" sz="2400"\/>/);
    assert.doesNotMatch(slide, /sz="1800"/);
    assert.equal(relay.dispatched.some((call) => call.method === "craft.waitSave"), false);
  });

  it("rejects invalid Office bytes instead of writing a fake pptx", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = [...CATALOG, "file.saveBytes"];
    relay.exportBytes = Buffer.from("not-a-pptx");
    const res = await tool().run({ app: "slides", action: "export" }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.content, /not a readable Office package/);
  });

  it("fails an export that returns no stored path", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = CATALOG;
    relay.saved = { path: null };
    const res = await tool().run({ app: "docs", action: "export" }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.content, /did not return a task file path/);
  });

  it("inserts a document page and exports a workbook from bytes", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = [...CATALOG, "text.insert"];
    const edited = await tool().run({ app: "docs", action: "edit", title: "Q4", body: "Ship the plan." }, ctx());
    assert.equal(edited.ok, true, edited.content);
    const insert = relay.dispatched.find((call) => call.params["command"] === "text.insert");
    assert.deepEqual(insert?.params["params"], { text: "Q4\nShip the plan." });
    relay.commands = [...CATALOG, "file.saveBytes"];
    const exported = await tool().run({ app: "sheets", action: "export" }, ctx());
    assert.equal(exported.ok, true, exported.content);
    const body = JSON.parse(exported.content) as { command: string; path: string };
    assert.equal(body.command, "file.saveBytes");
    assert.match(body.path, /^uploads\/\d+-workbook\.xlsx$/);
  });

  it("writes five budget rows and a SUM formula into a sheet", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = [...CATALOG, "range.setValues", "cell.set"];
    const grid = parseSheetGrid("Item|Amount;Rent|1200;Food|450;Transit|180;Utilities|260;Supplies|90;Total|=SUM(B2:B6)");
    assert.equal(grid?.range, "A1:B7");
    assert.equal(grid?.formula?.cell, "B7");
    const edited = await tool().run({ app: "sheets", action: "edit", body: "Item|Amount;Rent|1200;Food|450;Transit|180;Utilities|260;Supplies|90;Total|=SUM(B2:B6)" }, ctx());
    assert.equal(edited.ok, true, edited.content);
    const values = relay.dispatched.find((call) => call.params["command"] === "range.setValues");
    assert.equal((values?.params["params"] as { range?: string } | undefined)?.range, "A1:B7");
    const formula = relay.dispatched.find((call) => call.params["command"] === "cell.set");
    assert.deepEqual(formula?.params["params"], { cell: "B7", input: "=SUM(B2:B6)" });
  });

  it("picks title and body shapes from an inspect result", () => {
    const targets = slideTextTargets({
      shapes: [
        { id: 3, kind: "placeholder", placeholder: "subTitle", text: "" },
        { id: 2, kind: "placeholder", placeholder: "title", text: "" },
      ],
    });
    assert.deepEqual(targets, { titleId: 2, bodyId: 3 });
  });
});
