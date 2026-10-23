/**
 * Craft-editor prompt and routing tests (task cr-06).
 *
 * The master prompt asset (`prompts/loam-master.md`, section 6.11) is the
 * human-editable source of truth; `src/agent/craftPrompt.ts` mirrors the guidance
 * in a module that can be sent to runs that do not carry the whole master prompt
 * and can be unit-tested in isolation. These tests pin the contract:
 *
 *  - the routing table picks the right editor per file type,
 *  - the Craft guidance is injected for the modes/tools that can edit office files,
 *  - the guidance teaches the read-state -> discover -> batch -> verify -> export loop,
 *  - the fallback to Loam's own editors is stated,
 *  - no upstream project name leaks into prompt or tool text.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

// Must come before any import that evaluates `config.js`: `buildSystemPrompt`
// reads user personalization from the SQLite store under DATA_DIR.
import { cleanupIsolatedDataDir } from "../../test/isolation.js";
import { closeDb } from "../../server/sqliteStore.js";

after(() => {
  closeDb();
  cleanupIsolatedDataDir();
});

import {
  CRAFT_APP_FORMATS,
  CRAFT_APP_NAMES,
  CRAFT_BRIDGE_METHODS,
  CRAFT_COMMAND_CHEAT_SHEET,
  CRAFT_EDITORS_PROMPT,
  CRAFT_POINTER_METHODS,
  CRAFT_TOOL_NAMES,
  craftAppForExtension,
} from "../craftPrompt.js";
import { MASTER_PROMPT_SECTIONS } from "../masterPromptText.js";
import { buildSystemPrompt } from "../prompt.js";
import { getLoamMode } from "../../modes/catalog.js";
import { PLANNER_SYSTEM } from "../planner.js";
import type { Config } from "../../config.js";

const cfg = {
  workspace: "C:/work/craft-task",
  model: "qwen2.5:14b",
  policy: { networkEnabled: false },
} as unknown as Config;

/** Upstream (internal) project names: never user-facing (docs/craft-apps.md). */
const UPSTREAM_NAMES = ["wordcraft", "gridcraft", "deckcraft", "photocraft", "designcraft", "artcraft"];

describe("craft app routing", () => {
  it("maps each attached file type to its own editor", () => {
    const expected: Array<[string, string]> = [
      ["docx", "Loam Docs"],
      ["xlsx", "Loam Sheets"],
      ["pptx", "Loam Slides"],
      ["psd", "Loam Photo"],
      ["idml", "Loam Design"],
    ];
    for (const [ext, app] of expected) {
      assert.equal(craftAppForExtension(ext), app, `.${ext} must route to ${app}`);
    }
  });

  it("is case-insensitive and tolerant of a leading dot", () => {
    assert.equal(craftAppForExtension("PPTX"), "Loam Slides");
    assert.equal(craftAppForExtension(" .XLSX "), "Loam Sheets");
  });

  it("returns null for a type no Craft editor owns", () => {
    assert.equal(craftAppForExtension("txt"), null);
    assert.equal(craftAppForExtension(""), null);
  });

  it("lists exactly the five rebranded editors with their formats", () => {
    assert.deepEqual(CRAFT_APP_NAMES, ["Loam Docs", "Loam Sheets", "Loam Slides", "Loam Photo", "Loam Design"]);
    for (const name of CRAFT_APP_NAMES) {
      assert.ok(CRAFT_APP_FORMATS[name], `${name} has no format list`);
      assert.ok(CRAFT_APP_FORMATS[name].includes("."), `${name} formats must list extensions`);
    }
  });
});

describe("craft command cheat-sheet", () => {
  it("covers every editor with reads, edits and a save path", () => {
    for (const name of CRAFT_APP_NAMES) {
      const entry = CRAFT_COMMAND_CHEAT_SHEET[name];
      assert.ok(entry, `${name} has no cheat-sheet entry`);
      assert.ok(entry.read.length > 0, `${name} has no read command`);
      assert.ok(entry.edits.length > 0, `${name} has no edit command`);
      assert.ok(entry.save.length > 0, `${name} has no export path`);
    }
  });

  it("lists only control methods and documented per-app read ids", () => {
    // Generic control methods every app answers, plus the app-specific reads each
    // app's own protocol documents (`.cr-ref/craft/protocols/<internalId>.md`).
    const known = new Set([
      "engine.execute",
      "engine.commands",
      "document.inspect",
      "ui.inspect",
      "ui.screenshot",
      "ui.render",
      "sheet.read",
      "cell.get",
      "layer.list",
      "document.pixel",
    ]);
    for (const [name, entry] of Object.entries(CRAFT_COMMAND_CHEAT_SHEET)) {
      for (const raw of entry.read) {
        const id = raw.split(" ")[0]!;
        assert.ok(known.has(id), `${name}: unknown control method "${id}"`);
      }
      for (const raw of entry.edits) {
        const id = raw.split(" ")[0]!.split("{")[0]!;
        assert.ok(id.length > 0 && !id.startsWith("{"), `${name}: unparseable edit id "${raw}"`);
      }
      assert.match(entry.save, /engine\.execute|engine\.commands|app\.save/, `${name}: save path must name a real call`);
    }
  });
});

describe("craft guidance in the assembled prompt", () => {
  const craftTools = CRAFT_TOOL_NAMES;

  it("is present for every tool that can drive the editors", () => {
    for (const tool of craftTools) {
      const prompt = buildSystemPrompt(cfg, [], [tool]);
      assert.match(prompt, /Craft editors/i, `craft guidance missing for ${tool}`);
    }
  });

  it("is absent when no office tool is available", () => {
    const prompt = buildSystemPrompt(cfg, [], ["file_read", "web_search"]);
    assert.doesNotMatch(prompt, /Craft editors:/, "craft guidance leaked into a run with no office tool");
  });

  it("teaches the read -> discover -> batch -> verify -> export loop", () => {
    const prompt = buildSystemPrompt(cfg, [], ["office_craft"]);
    assert.match(prompt, /read the live state/i);
    assert.match(prompt, /engine\.commands/i, "must discover command ids first");
    assert.match(prompt, /batch the independent edits/i);
    assert.match(prompt, /re-read the state and confirm/i, "must verify the edit landed");
    assert.match(prompt, /export through the app/i);
    assert.match(prompt, /never write the office file yourself/i);
  });

  it("states the fail-closed fallback to Loam's own editors", () => {
    const prompt = buildSystemPrompt(cfg, [], ["office_craft"]);
    assert.match(prompt, /Fail closed/i);
    assert.match(prompt, /loam_studio/i);
    assert.match(prompt, /loam_document/i);
  });

  it("requires the user's language and forbids upstream names", () => {
    const prompt = buildSystemPrompt(cfg, [], ["office_craft"]);
    assert.match(prompt, /Reply in the user's language/i);
    assert.match(prompt, /Never mention the upstream project names/i);
  });

  it("is reachable from the modes that can edit office files", () => {
    // The Craft apps are an alternative to the built-in studio path, so the modes
    // that own office files must be able to reach the guidance.
    for (const modeId of ["write", "data"]) {
      assert.ok(getLoamMode(modeId).tools.includes("office_craft"), `${modeId} cannot reach the Craft editors`);
    }
  });

  it("keeps the master-prompt 6.11 section in the assembled master prompt", () => {
    const section = MASTER_PROMPT_SECTIONS.find((s) => s.body.includes("### 6.11 Craft editors"));
    assert.ok(section, "section 6.11 is missing from the generated master prompt");
    assert.match(section!.body, /Read the live state before every change/i);
    assert.match(section!.body, /Discover before you command/i);
    assert.match(section!.body, /Batch, then verify the state/i);
    assert.match(section!.body, /Export at the end/i);
    assert.match(section!.body, /Fail closed/i);
    assert.match(section!.body, /Arabic-first, no upstream names/i);
  });

  it("keeps the Craft rule in the planner system prompt", () => {
    assert.match(PLANNER_SYSTEM, /Craft-editor task/i);
    assert.match(PLANNER_SYSTEM, /engine\.commands/i);
    assert.match(PLANNER_SYSTEM, /fall back to the built-in editors/i);
  });
});

describe("branding contract", () => {
  const guidance = [CRAFT_EDITORS_PROMPT, ...Object.values(CRAFT_COMMAND_CHEAT_SHEET).flatMap((e) => [...e.read, ...e.edits, e.save])];

  it("never names an upstream project in the guidance", () => {
    for (const text of guidance) {
      for (const name of UPSTREAM_NAMES) {
        assert.ok(!text.toLowerCase().includes(name), `upstream name "${name}" leaked into: ${text}`);
      }
    }
  });

  it("never names an upstream project in the master prompt section", () => {
    const section = MASTER_PROMPT_SECTIONS.find((s) => s.body.includes("### 6.11 Craft editors"));
    assert.ok(section);
    for (const name of UPSTREAM_NAMES) {
      assert.ok(!section!.body.toLowerCase().includes(name), `upstream name "${name}" leaked into section 6.11`);
    }
  });

  it("never names an upstream project in the assembled prompt", () => {
    const prompt = buildSystemPrompt(cfg, [], ["office_craft"]);
    for (const name of UPSTREAM_NAMES) {
      assert.ok(!prompt.toLowerCase().includes(name), `upstream name "${name}" leaked into the assembled prompt`);
    }
  });

  it("uses exactly the five Loam editor names", () => {
    for (const name of CRAFT_APP_NAMES) {
      assert.match(CRAFT_EDITORS_PROMPT, new RegExp(name), `guidance must name ${name}`);
    }
  });

  it("keeps the core methods the protocols actually list in all five apps", () => {
    for (const method of ["engine.execute", "engine.commands", "document.inspect", "ui.inspect", "ui.screenshot", "ui.key", "ui.click"]) {
      assert.ok(CRAFT_BRIDGE_METHODS.includes(method), `missing core method ${method}`);
    }
    // Loam Sheets' control table lists neither, so they must not be claimed as core.
    for (const method of ["ui.render", "ui.set", "ui.pointer", "ui.drag"]) {
      assert.ok(!CRAFT_BRIDGE_METHODS.includes(method), `${method} is not universal and must not be in the core list`);
    }
  });

  it("gives every editor the pointer methods its own protocol lists", () => {
    for (const name of CRAFT_APP_NAMES) {
      const methods = CRAFT_POINTER_METHODS[name];
      assert.ok(methods && methods.length > 0, `${name} has no pointer methods`);
      for (const m of methods) assert.match(m, /^ui\.(pointer|click|move|drag|wheel)$/, `${name}: bad pointer method ${m}`);
    }
    // Verified against the protocol tables: Photo drives drags through ui.pointer,
    // not ui.drag.
    assert.ok(CRAFT_POINTER_METHODS["Loam Photo"]!.includes("ui.pointer"));
    assert.ok(!CRAFT_POINTER_METHODS["Loam Photo"]!.includes("ui.drag"));
    assert.ok(!CRAFT_POINTER_METHODS["Loam Sheets"]!.includes("ui.pointer"));
  });

  it("does not tell the agent to filter engine.commands on an app that takes no filter", () => {
    // Only Loam Sheets' control channel accepts {search}. Docs, Slides, Photo and
    // Design take no argument, so a {search:'...'} call there is a wrong instruction.
    assert.match(CRAFT_EDITORS_PROMPT, /only Loam Sheets narrows that call/);
    for (const name of ["Loam Photo", "Loam Design"]) {
      const entry = CRAFT_COMMAND_CHEAT_SHEET[name]!;
      assert.ok(!entry.save.includes("search"), `${name} save advice must not pass a search to engine.commands`);
    }
  });
});
