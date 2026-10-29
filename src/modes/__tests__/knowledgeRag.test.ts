/**
 * Phase-2 W2 «تحدث مع ملفاتك»: the Knowledge Garden tools (kb_* +
 * task_files_ingest) are part of the core ask/build modes.
 *
 * The single injection point is mode resolution (getLoamMode/getLoamModesUi in
 * src/modes/catalog.ts): the names are appended to exactly those two modes,
 * gated by the settings flag `knowledgeRag` (default ON — an older settings
 * file keeps the garden promoted), and no other mode ever receives them.
 */
import assert from "node:assert";
import { after, describe, it } from "node:test";

// Must come first: pins DATA_DIR (and the settings file) to a per-process temp
// directory, so toggling the flag never writes into the repository's data/.
import { cleanupIsolatedDataDir } from "../../test/isolation.js";
import { closeDb } from "../../server/sqliteStore.js";

after(() => {
  closeDb();
  cleanupIsolatedDataDir();
});

import { getLoamMode, getLoamModesUi, LOAM_MODES } from "../catalog.js";
import { KNOWLEDGE_TOOL_NAMES } from "../../server/knowledgeTools.js";
import { getSettings, loadSettings, updateSettings } from "../../server/settings.js";
import { ToolRegistry } from "../../tools/registry.js";

describe("knowledge garden in the core ask/build modes", () => {
  it("ask and build include every garden tool by default (knowledgeRag unset = ON)", () => {
    assert.notEqual(getSettings().knowledgeRag, false, "test precondition: the flag must default to ON");
    for (const id of ["ask", "build"]) {
      const tools = getLoamMode(id).tools;
      for (const name of KNOWLEDGE_TOOL_NAMES) {
        assert.ok(tools.includes(name), `${id} mode is missing ${name}`);
      }
    }
  });

  it("aliases of the core modes inherit the garden tools", () => {
    for (const id of ["discuss", "plan", "full", "general"]) {
      const tools = getLoamMode(id).tools;
      for (const name of KNOWLEDGE_TOOL_NAMES) {
        assert.ok(tools.includes(name), `${id} (-> ask/build) is missing ${name}`);
      }
    }
  });

  it("no other mode ever receives the garden tools from this injection", () => {
    for (const mode of LOAM_MODES) {
      if (mode.id === "ask" || mode.id === "build") continue;
      const tools = getLoamMode(mode.id).tools;
      for (const name of KNOWLEDGE_TOOL_NAMES) {
        assert.ok(!tools.includes(name), `${mode.id} mode must not expose ${name}`);
      }
    }
  });

  it("knowledgeRag=false removes the tools from ask/build everywhere at once", () => {
    updateSettings({ knowledgeRag: false });
    try {
      assert.equal(getSettings().knowledgeRag, false);
      for (const id of ["ask", "build"]) {
        const tools = getLoamMode(id).tools;
        for (const name of KNOWLEDGE_TOOL_NAMES) {
          assert.ok(!tools.includes(name), `${id} mode must drop ${name} when knowledgeRag=false`);
        }
      }
      // The modes UI resolves through the same point, so it reflects the switch.
      const ui = getLoamModesUi([...KNOWLEDGE_TOOL_NAMES]);
      for (const id of ["ask", "build"]) {
        const mode = ui.modes.find((m) => m.id === id)!;
        for (const name of KNOWLEDGE_TOOL_NAMES) {
          assert.ok(!mode.tools.includes(name), `modes UI still lists ${name} for ${id}`);
        }
      }
      // And the persisted settings round-trip keeps the flag.
      assert.equal(loadSettings().knowledgeRag, false);
    } finally {
      updateSettings({ knowledgeRag: true });
    }
    assert.equal(getSettings().knowledgeRag, true);
  });

  it("registry.forMode hands the garden tools to an ask run when the flag is on", () => {
    const registry = new ToolRegistry();
    for (const name of new Set([...getLoamMode("ask").tools, ...getLoamMode("build").tools, "file_read"])) {
      registry.register({
        name,
        description: name,
        parameters: {},
        run: async () => ({ ok: true, content: name }),
      });
    }
    const ask = registry.forMode("ask").names();
    for (const name of KNOWLEDGE_TOOL_NAMES) {
      assert.ok(ask.includes(name), `ask run registry is missing ${name}`);
    }
  });
});
