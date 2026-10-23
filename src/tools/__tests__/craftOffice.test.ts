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
import { after, describe, it } from "node:test";

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
    if (method === "craft.waitSave") return this.saved;
    if (method === "document.inspect") return this.document;
    if (method === "sheet.read") return this.sheet;
    if (method === "ui.inspect") return this.ui;
    if (method === "craft.open") return { opened: params["path"] ?? null };
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
      ["open", "state", "commands", "execute", "batch", "export", "undo", "redo"],
    );
    for (const action of ["execute", "batch", "export", "undo", "redo"] as const) {
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
    assert.equal(body.retry, true);
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
  it("exports through craft.waitSave and returns the stored path", async () => {
    freshRoot();
    installAllApps();
    relay = new MockRelay();
    relay.commands = CATALOG;
    const res = await tool().run({ app: "docs", action: "export", file: "out/final.docx" }, ctx());
    assert.equal(res.ok, true, res.content);
    const wait = relay.dispatched.find((d) => d.method === "craft.waitSave")!;
    assert.deepEqual(wait.params, { command: "file.save", params: { path: "out/final.docx" } });
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
    assert.deepEqual(wait.params, { command: "file.exportPdf", params: { path: "out/a.pdf", layout: "handouts" } });
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
