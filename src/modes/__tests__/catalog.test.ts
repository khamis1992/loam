/**
 * MF2 unit tests: mode tool sets and the office-tool prompt directive.
 *
 * A mode is only useful if the model can actually reach the tools the mode
 * advertises, and if the system prompt names them. Office work (documents,
 * slides, spreadsheets) is the case that regressed most often: the model
 * wrote Python instead of using loam_studio/office_export.
 */
import assert from "node:assert";
import { after, describe, it } from "node:test";

// Must come before any import that evaluates `config.js`: `buildSystemPrompt`
// reads user personalization from the SQLite store under DATA_DIR, so without
// this redirect the prompt assertions create the repository's real
// `data/manus.db`.
import { cleanupIsolatedDataDir } from "../../test/isolation.js";
import { closeDb } from "../../server/sqliteStore.js";

after(() => {
  closeDb();
  cleanupIsolatedDataDir();
});

import { LOAM_MODES, getLoamMode, getLoamModesUi } from "../catalog.js";
import { ToolRegistry } from "../../tools/registry.js";
import { buildSystemPrompt } from "../../agent/prompt.js";
import type { Config } from "../../config.js";

const OFFICE_TOOLS = ["office_import", "office_export", "office_status"];

const cfg = {
  workspace: "/tmp/task",
  policy: { networkEnabled: false },
} as unknown as Config;

function registryWithAllModeTools(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const name of new Set(LOAM_MODES.flatMap((mode) => mode.tools))) {
    registry.register({
      name,
      description: name,
      parameters: {},
      run: async () => ({ ok: true, content: name }),
    });
  }
  return registry;
}

describe("mode tool sets", () => {
  it("gives the write mode the document and office tools", () => {
    const mode = getLoamMode("write");
    for (const name of [...OFFICE_TOOLS, "loam_studio", "loam_document"]) {
      assert.ok(mode.tools.includes(name), `write mode is missing ${name}`);
    }
  });

  it("gives the data mode the dataset and office tools", () => {
    const mode = getLoamMode("data");
    for (const name of [...OFFICE_TOOLS, "loam_studio", "loam_dataset"]) {
      assert.ok(mode.tools.includes(name), `data mode is missing ${name}`);
    }
  });

  it("keeps office tools out of the modes that do not need them", () => {
    for (const id of ["ask", "research", "media", "security", "automate", "build"]) {
      const mode = getLoamMode(id);
      for (const name of OFFICE_TOOLS) {
        assert.ok(!mode.tools.includes(name), `${id} mode must not expose ${name}`);
      }
    }
  });

  it("exposes the office tools in the run allowlist of the office modes", () => {
    const registry = registryWithAllModeTools();
    for (const id of ["write", "data"]) {
      const names = registry.forMode(id).names();
      for (const name of OFFICE_TOOLS) {
        assert.ok(names.includes(name), `${id} run registry is missing ${name}`);
      }
    }
    const research = registry.forMode("research").names();
    for (const name of OFFICE_TOOLS) {
      assert.ok(!research.includes(name), `research run registry must not expose ${name}`);
    }
  });

  it("reports the office tools as available in the mode UI", () => {
    const registry = registryWithAllModeTools();
    const ui = getLoamModesUi(registry.names());
    const write = ui.modes.find((mode) => mode.id === "write");
    assert.ok(write);
    for (const name of OFFICE_TOOLS) {
      assert.ok(write.availableTools.includes(name), `write UI hides ${name}`);
      assert.ok(!write.unavailableTools.includes(name), `write UI lists ${name} as unavailable`);
    }
  });

  it("names the office tools in the mode output hint", () => {
    // The hint is injected into the system prompt for the active mode.
    for (const id of ["write", "data"]) {
      const hint = getLoamMode(id).outputHint;
      assert.match(hint, /office_export/);
      assert.match(hint, /do not generate office files via shell\/python/i);
    }
  });
});

describe("office tool prompt directive", () => {
  it("names the office workflow when the mode ships office tools", () => {
    for (const id of ["write", "data"]) {
      const mode = getLoamMode(id);
      const prompt = buildSystemPrompt(cfg, [], mode.tools);
      assert.match(prompt, /office_export/);
      assert.match(prompt, /loam_studio/);
      assert.match(prompt, /Do not generate office files through shell or Python/i);
    }
  });

  it("stays out of the prompt when the mode has no office tools", () => {
    const mode = getLoamMode("research");
    const prompt = buildSystemPrompt(cfg, [], mode.tools);
    // The master prompt's generic tool catalogue names office_export, so the
    // mode-specific office *directive* and the advertised tool list are what
    // must stay out of a mode that cannot use office tools.
    assert.ok(!/Do not generate office files through shell or Python/i.test(prompt));
    const available = prompt.split("\n").find((line) => line.startsWith("Available tools"));
    assert.ok(available, "expected an Available tools line");
    assert.ok(!available!.includes("office_export"), "research mode advertises office_export");
    assert.ok(!available!.includes("loam_studio"), "research mode advertises loam_studio");
  });
});

describe("devflow mode (دورة تطوير GitHub)", () => {
  const DEVFLOW_CORE = [
    // issue intake + PR workflow (D1/D2/D15/D5 toolset)
    "github_list_repos", "github_list_issues", "github_create_issue",
    "git_branch", "git_commit", "git_status_diff",
    "pr_create", "pr_view", "pr_comments", "pr_comment_checklist",
    "ci_watch", "pr_review", "verify_and_record",
    // نتريو swarm execution + security quadrant
    "swarm_run", "swarm_status",
    "remediation_start", "remediation_status", "remediation_report", "remediation_cancel",
    // file basics and control, as sibling modes use them
    "file_read", "file_write", "file_edit", "finish",
  ];

  it("exists in the catalog with the GitHub + swarm + remediation toolchain", () => {
    assert.ok(LOAM_MODES.some((m) => m.id === "devflow"), "devflow mode is missing from LOAM_MODES");
    const mode = getLoamMode("devflow");
    assert.equal(mode.labelAr, "دورة تطوير");
    for (const name of DEVFLOW_CORE) {
      assert.ok(mode.tools.includes(name), `devflow mode is missing ${name}`);
    }
  });

  it("keeps the office tools out of devflow", () => {
    const mode = getLoamMode("devflow");
    for (const name of OFFICE_TOOLS) {
      assert.ok(!mode.tools.includes(name), `devflow mode must not expose ${name}`);
    }
  });

  it("resolves the devflow tools in the run allowlist", () => {
    const registry = registryWithAllModeTools();
    const names = registry.forMode("devflow").names();
    for (const name of DEVFLOW_CORE) {
      assert.ok(names.includes(name), `devflow run registry is missing ${name}`);
    }
  });

  it("reports the devflow tools as available in the mode UI", () => {
    const registry = registryWithAllModeTools();
    const ui = getLoamModesUi(registry.names());
    const devflow = ui.modes.find((mode) => mode.id === "devflow");
    assert.ok(devflow, "devflow mode is missing from the modes UI");
    for (const name of DEVFLOW_CORE) {
      assert.ok(devflow.availableTools.includes(name), `devflow UI hides ${name}`);
      assert.ok(!devflow.unavailableTools.includes(name), `devflow UI lists ${name} as unavailable`);
    }
  });

  it("names the flow in the mode output hint injected into the system prompt", () => {
    const hint = getLoamMode("devflow").outputHint;
    for (const tool of ["swarm_run", "pr_create", "pr_review", "ci_watch", "remediation_start"]) {
      assert.match(hint, new RegExp(tool));
    }
  });
});
