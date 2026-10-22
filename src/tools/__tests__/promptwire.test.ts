/**
 * Promptwire wiring tests.
 *
 * Covers the master-prompt asset drift, the assembler's slot filling and
 * Appendix B ordering, the per-model Appendix A block, and the mode tool lists
 * that advertise the promptwire tools.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  MASTER_ORDER,
  buildMasterPrompt,
  fillMasterSlots,
  modelFamily,
  deriveMasterSlots,
} from "../../agent/masterPrompt.js";
import { masterPromptEnabled } from "../../agent/prompt.js";
import { MASTER_PROMPT_SECTIONS } from "../../agent/masterPromptText.js";
import { generateMasterPromptTs } from "../../scripts/gen-master-prompt.js";
import { LOAM_MODES, getLoamMode } from "../../modes/catalog.js";
import type { Config } from "../../config.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PROMPT_MD = path.join(ROOT, "prompts", "loam-master.md");
const PROMPT_TS = path.join(ROOT, "src", "agent", "masterPromptText.ts");

const ALL_SLOTS = {
  user_name: "Ada",
  user_tz: "Asia/Qatar",
  now_local: "Mon, 1 Jan 2026, 10:00",
  os: "Windows",
  workspace_root: "C:/work/task",
  shell: "powershell",
  project_name: "task",
  project_path: "C:/work/task",
  git_branch: "main",
  connector_list: "github, gmail",
  model_chain: "glm-5.3-flash:cloud → qwen2.5:14b",
  current_model: "glm-5.3-flash:cloud",
  max_parallel_agents: "4",
  spill_threshold: "80000",
  deliverables_dir: "C:/work/task/deliverables",
  local_timeout_s: "600",
} as const;

const UNFILLED = /\{\{(?!vault:)[^{}]+\}\}/;

describe("master prompt asset", () => {
  it("keeps the generated TS in sync with prompts/loam-master.md", () => {
    const markdown = fs.readFileSync(PROMPT_MD, "utf8");
    const committed = fs.readFileSync(PROMPT_TS, "utf8");
    assert.equal(generateMasterPromptTs(markdown), committed, "run `npm run gen:master-prompt` to refresh masterPromptText.ts");
  });

  it("splits the numbered sections and keeps the appendices separate", () => {
    const ids = MASTER_PROMPT_SECTIONS.map((s) => s.id);
    assert.deepEqual(ids.slice(0, 24), Array.from({ length: 24 }, (_, i) => String(i + 1)));
    assert.equal(ids[24], "appendix-a");
    assert.equal(ids[25], "appendix-b");
    for (const section of MASTER_PROMPT_SECTIONS) {
      assert.ok(section.title.length > 0, `section ${section.id} has a title`);
      assert.ok(section.body.length > 0, `section ${section.id} has a body`);
    }
  });
});

describe("buildMasterPrompt", () => {
  it("fills every slot and leaves no raw placeholder except vault examples", () => {
    const prompt = buildMasterPrompt(ALL_SLOTS, { model: "qwen2.5:14b" });
    assert.ok(!UNFILLED.test(prompt), `unfilled slot remains: ${prompt.match(UNFILLED)?.[0] ?? ""}`);
    for (const [slot, value] of Object.entries(ALL_SLOTS)) {
      assert.ok(prompt.includes(value), `slot ${slot} was not filled with ${value}`);
    }
    assert.ok(prompt.includes("{{vault:NAME}}"), "literal vault examples must be preserved");
  });

  it("fills unknown slots with 'unknown'", () => {
    const prompt = fillMasterSlots("a {{user_name}} b {{mystery}} c", { user_name: "Ada" });
    assert.equal(prompt, "a Ada b unknown c");
  });

  it("assembles the numbered sections in Appendix B order", () => {
    const prompt = buildMasterPrompt(ALL_SLOTS, { model: "glm-5.3-flash:cloud" });
    let previous = -1;
    for (const group of MASTER_ORDER) {
      for (const id of group) {
        const section = MASTER_PROMPT_SECTIONS.find((s) => s.id === id);
        assert.ok(section, `missing section ${id}`);
        const index = prompt.indexOf(`## ${section!.title}`);
        assert.ok(index > previous, `section ${id} (${section!.title}) is out of order`);
        previous = index;
      }
    }
  });

  it("appends the per-model Appendix A block only for a known family", () => {
    const fast = buildMasterPrompt(ALL_SLOTS, { model: "glm-5.3-flash:cloud" });
    assert.match(fast, /Fast or cheaper models/);
    assert.ok(!/Frontier reasoning models/.test(fast));

    const frontier = buildMasterPrompt(ALL_SLOTS, { model: "claude-sonnet-4:cloud" });
    assert.match(frontier, /Frontier reasoning models/);

    const local = buildMasterPrompt(ALL_SLOTS, { model: "qwen2.5:14b" });
    assert.match(local, /Local models \(Ollama\)/);
    assert.ok(local.includes("600"), "local timeout slot is filled inside the Appendix A block");

    const unknown = buildMasterPrompt(ALL_SLOTS, { model: "mystery:cloud" });
    assert.ok(!/Appendix A/.test(unknown), "unknown model family must omit the Appendix A block");
  });

  it("appends dynamic context after the appendix", () => {
    const prompt = buildMasterPrompt(ALL_SLOTS, { model: "qwen2.5:14b", dynamicContext: "Dynamic context block" });
    assert.ok(prompt.indexOf("Dynamic context block") > prompt.indexOf("Local models (Ollama)"));
  });
});

describe("modelFamily", () => {
  it("classifies frontier, fast and local models", () => {
    assert.equal(modelFamily("gpt-5:cloud"), "frontier");
    assert.equal(modelFamily("claude-sonnet-4:cloud"), "frontier");
    assert.equal(modelFamily("glm-5.3-flash:cloud"), "fast");
    assert.equal(modelFamily("gemini-2.0-flash:cloud"), "fast");
    assert.equal(modelFamily("qwen2.5:14b"), "local-ollama");
    assert.equal(modelFamily("llama3.2:latest"), "local-ollama");
  });

  it("returns undefined for unknown families", () => {
    assert.equal(modelFamily("mystery:cloud"), undefined);
    assert.equal(modelFamily(""), undefined);
    assert.equal(modelFamily(undefined), undefined);
  });
});

describe("deriveMasterSlots", () => {
  const cfg = {
    workspace: "/tmp/pw-task",
    model: "glm-5.3-flash:cloud",
    fallbackModel: "qwen2.5:14b",
  } as unknown as Config;

  it("fills all slot names without throwing", () => {
    const slots = deriveMasterSlots(cfg, ["file_read"]);
    for (const name of Object.keys(ALL_SLOTS)) {
      assert.equal(typeof slots[name as keyof typeof slots], "string");
      assert.ok((slots[name as keyof typeof slots] as string).length > 0, `slot ${name} is empty`);
    }
    assert.equal(slots.workspace_root, "/tmp/pw-task");
    assert.equal(slots.project_name, "pw-task");
    assert.equal(slots.current_model, "glm-5.3-flash:cloud");
  });
});

describe("master prompt switch", () => {
  it("is enabled by default and disabled by LOAM_MASTER_PROMPT=0", () => {
    const previous = process.env.LOAM_MASTER_PROMPT;
    try {
      delete process.env.LOAM_MASTER_PROMPT;
      assert.equal(masterPromptEnabled(), true);
      process.env.LOAM_MASTER_PROMPT = "0";
      assert.equal(masterPromptEnabled(), false);
      process.env.LOAM_MASTER_PROMPT = "1";
      assert.equal(masterPromptEnabled(), true);
    } finally {
      if (previous === undefined) delete process.env.LOAM_MASTER_PROMPT;
      else process.env.LOAM_MASTER_PROMPT = previous;
    }
  });
});

describe("promptwire mode tool lists", () => {
  const CONTROL = ["think", "finish", "plan", "phase_set", "message"];

  it("gives every mode the control and communication tools", () => {
    for (const mode of LOAM_MODES) {
      for (const name of CONTROL) {
        assert.ok(mode.tools.includes(name), `${mode.id} mode is missing ${name}`);
      }
    }
  });

  it("adds file_multi_edit to the modes that can edit files", () => {
    for (const mode of LOAM_MODES) {
      if (mode.tools.includes("file_edit")) {
        assert.ok(mode.tools.includes("file_multi_edit"), `${mode.id} has file_edit but not file_multi_edit`);
      } else {
        assert.ok(!mode.tools.includes("file_multi_edit"), `${mode.id} must not expose file_multi_edit`);
      }
    }
  });

  it("gives build the vault and code-session tools", () => {
    const build = getLoamMode("build");
    for (const name of ["vault_ref", "code_session", "code_session_status", "code_session_collect"]) {
      assert.ok(build.tools.includes(name), `build mode is missing ${name}`);
    }
  });

  it("gives ask, research and build the docs_lookup tool", () => {
    for (const id of ["ask", "research", "build"]) {
      assert.ok(getLoamMode(id).tools.includes("docs_lookup"), `${id} mode is missing docs_lookup`);
    }
    assert.ok(!getLoamMode("security").tools.includes("docs_lookup"), "security must not expose docs_lookup");
  });

  it("gives every file-writing mode artifact_publish", () => {
    for (const mode of LOAM_MODES) {
      if (mode.tools.includes("file_write")) {
        assert.ok(mode.tools.includes("artifact_publish"), `${mode.id} writes files but is missing artifact_publish`);
      } else {
        assert.ok(!mode.tools.includes("artifact_publish"), `${mode.id} must not expose artifact_publish`);
      }
    }
  });

  it("keeps every mode's tool set distinct", () => {
    const sets = LOAM_MODES.map((mode) => mode.tools.slice().sort().join(","));
    assert.equal(new Set(sets).size, LOAM_MODES.length);
  });
});
