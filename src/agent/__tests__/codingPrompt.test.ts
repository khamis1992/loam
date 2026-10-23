/**
 * Coding-mode prompt tests (task C11).
 *
 * Appendix C is authored in the master prompt asset (`prompts/loam-master.md`)
 * but is deliberately NOT part of MASTER_ORDER: it is a coding-only section and
 * the runtime prompt builder (`buildSystemPrompt`) appends it only when the run
 * has coding tools. These tests pin that contract and snapshot the prompt so any
 * silent edit to the coding section is caught.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

// Must come before any import that evaluates `config.js`: `buildSystemPrompt`
// reads user personalization from the SQLite store under DATA_DIR, so without
// this redirect the prompt tests create the repository's real `data/manus.db`.
import { cleanupIsolatedDataDir } from "../../test/isolation.js";
import { closeDb } from "../../server/sqliteStore.js";

after(() => {
  closeDb();
  cleanupIsolatedDataDir();
});

import {
  CODING_MODE_SECTION_ID,
  MASTER_ORDER,
  buildMasterPrompt,
  codingModeSection,
  isCodingTask,
} from "../masterPrompt.js";
import { MASTER_PROMPT_SECTIONS } from "../masterPromptText.js";
import { buildSystemPrompt, codingPromptEnabled } from "../prompt.js";
import type { Config } from "../../config.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SNAPSHOT = path.join(ROOT, "src", "agent", "__tests__", "__snapshots__", "coding-prompt.snap.json");

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

const CODING_TOOLS = ["file_read", "file_edit", "file_write", "file_multi_edit", "shell_run", "code_session"];
const READ_ONLY_TOOLS = ["file_read", "file_list", "file_search", "code_symbols"];

const cfg = {
  workspace: "C:/work/task",
  model: "qwen2.5:14b",
  policy: { networkEnabled: false },
} as unknown as Config;

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

const CODING_RULES: Array<[string, RegExp]> = [
  ["conventions first", /Conventions first/i],
  ["check for an existing library", /Check before you add/i],
  ["no gratuitous comments", /No gratuitous comments/i],
  ["run tests/lint before finish", /Verify before you finish/i],
  ["file:line references", /Cite `file:line`/i],
  ["short answers", /Keep answers short/i],
  ["never commit unless asked", /Never commit unless asked/i],
];

describe("coding-mode prompt section", () => {
  it("carries every required coding rule", () => {
    const section = codingModeSection();
    assert.ok(section.startsWith(`## `), "coding section must render with its heading");
    for (const [name, pattern] of CODING_RULES) {
      assert.match(section, pattern, `coding section is missing the rule: ${name}`);
    }
  });

  it("is authored in the master asset but not in the default assembly order", () => {
    const section = MASTER_PROMPT_SECTIONS.find((s) => s.id === CODING_MODE_SECTION_ID);
    assert.ok(section, `master asset is missing section ${CODING_MODE_SECTION_ID}`);
    assert.equal(section!.title, "Appendix C — Coding Mode");

    const ordered = MASTER_ORDER.flat();
    assert.ok(!ordered.includes(CODING_MODE_SECTION_ID), "Appendix C must stay coding-conditional");

    const assembled = buildMasterPrompt(ALL_SLOTS, { model: "qwen2.5:14b" });
    assert.ok(!assembled.includes(section!.title), "buildMasterPrompt must not emit Appendix C unconditionally");
  });

  it("keeps the full master prompt: every numbered section still assembles", () => {
    const assembled = buildMasterPrompt(ALL_SLOTS, { model: "qwen2.5:14b" });
    for (const group of MASTER_ORDER) {
      for (const id of group) {
        const section = MASTER_PROMPT_SECTIONS.find((s) => s.id === id);
        assert.ok(section, `missing section ${id}`);
        assert.ok(assembled.includes(`## ${section!.title}`), `section ${id} was dropped from the master prompt`);
      }
    }
  });
});

describe("runtime prompt builder", () => {
  it("sends Appendix C to coding tasks", () => {
    const prompt = buildSystemPrompt(cfg, [], CODING_TOOLS);
    for (const [name, pattern] of CODING_RULES) {
      assert.match(prompt, pattern, `runtime prompt for a coding task is missing: ${name}`);
    }
  });

  it("leaves Appendix C out of non-coding tasks", () => {
    const prompt = buildSystemPrompt(cfg, [], READ_ONLY_TOOLS);
    assert.ok(!/Conventions first/.test(prompt), "read-only tasks must not receive the coding section");
  });

  it("can be disabled for the before/after eval baseline", () => {
    const previous = process.env.LOAM_CODING_PROMPT;
    try {
      assert.equal(codingPromptEnabled(), true);
      process.env.LOAM_CODING_PROMPT = "0";
      assert.equal(codingPromptEnabled(), false);
      assert.ok(!/Conventions first/.test(buildSystemPrompt(cfg, [], CODING_TOOLS)));
      process.env.LOAM_CODING_PROMPT = "1";
      assert.equal(codingPromptEnabled(), true);
      assert.match(buildSystemPrompt(cfg, [], CODING_TOOLS), /Conventions first/);
    } finally {
      if (previous === undefined) delete process.env.LOAM_CODING_PROMPT;
      else process.env.LOAM_CODING_PROMPT = previous;
    }
  });
});

describe("isCodingTask", () => {
  it("detects coding tools", () => {
    assert.equal(isCodingTask(CODING_TOOLS), true);
    assert.equal(isCodingTask(READ_ONLY_TOOLS), false);
    assert.equal(isCodingTask([]), false);
  });
});

describe("coding prompt snapshot", () => {
  it("matches the committed snapshot", () => {
    const section = MASTER_PROMPT_SECTIONS.find((s) => s.id === CODING_MODE_SECTION_ID)!;
    const masterPrompt = buildMasterPrompt(ALL_SLOTS, { model: "qwen2.5:14b" });
    const current = {
      masterSectionIds: MASTER_PROMPT_SECTIONS.map((s) => s.id),
      codingSectionId: CODING_MODE_SECTION_ID,
      codingSectionTitle: section.title,
      codingSectionBody: section.body,
      masterPromptSha256: sha256(masterPrompt),
      codingSectionSha256: sha256(codingModeSection()),
    };
    const committed = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8")) as Record<string, unknown>;
    assert.deepEqual(current, committed, "coding prompt snapshot changed; update src/agent/__tests__/__snapshots__/coding-prompt.snap.json");
  });
});
