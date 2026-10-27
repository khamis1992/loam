/**
 * Tests for the office-intelligence agent tool (src/tools/officeIntelligenceTools.ts):
 *  - a deterministic capability (sheet-analysis) runs end-to-end against a real
 *    tiny .xlsx written with the workspace sheet IO, with NO model configured
 *    and no network, and leaves the file byte-identical (nothing auto-applied),
 *  - contract failures are honest (unknown capability, wrong extension),
 *  - the waitMs deadline returns a background note instead of hanging,
 *  - a model-dependent capability failing on a missing model points at the
 *    deterministic capabilities that still work,
 *  - registration smoke: both factories expose their expected tool names,
 *    the write/data mode allowlists carry the new tools, and the risk-tier
 *    routing classifies them as intended.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

// The office-intelligence service persists runs through the shared sqlite
// store; point it at a throwaway data dir before the first tool call (the
// store resolves its path lazily, exactly like the sibling agent tests).
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "loam-office-intel-"));
process.env.MANUS_LOCAL_DATA_DIR = path.join(tmpBase, "data");

import type { Config } from "../../config.js";
import type { StudioArtifact } from "../../studio/store.js";
import { exportStudio } from "../../studio/export.js";
import { writeSheetDoc, type EditorSheet } from "../../server/workspace/sheetIO.js";
import type { ToolContext } from "../registry.js";
import { createOfficeIntelligenceTools, OFFICE_INTELLIGENCE_TOOL_NAMES } from "../officeIntelligenceTools.js";
import { createServiceGapTools, SERVICE_GAP_TOOL_NAMES } from "../serviceGapTools.js";
import { LOAM_MODES } from "../../modes/catalog.js";
import { classifyToolCall } from "../../policy/riskTier.js";

/** No model configured and an unreachable provider URL: deterministic
 *  capabilities must still succeed, model-dependent ones must fail fast
 *  without any network traffic. */
const noModelCfg = { model: "", ollamaUrl: "http://127.0.0.1:1" } as unknown as Config;

const makeCtx = (workspace: string): ToolContext => ({ cfg: noModelCfg, workspace, emit: () => {} });

const sheet = (cells: string[][]): EditorSheet => ({
  name: "Sheet1",
  cells,
  styles: {},
  columnWidths: [],
  rowHeights: [],
  merges: [],
  hiddenRows: [],
  hiddenColumns: [],
});

async function makeXlsx(workspace: string): Promise<{ rel: string; abs: string }> {
  const rel = "data/budget.xlsx";
  const abs = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  await writeSheetDoc(abs, {
    taskId: "task_office_intel",
    path: rel,
    name: "budget.xlsx",
    sheets: [sheet([["Month", "Sales"], ["Jan", "10"], ["Feb", "20"], ["Mar", "30"]])],
    notes: [],
  });
  return { rel, abs };
}

async function makeDocx(workspace: string): Promise<string> {
  const artifact: StudioArtifact = {
    kind: "document",
    title: "Report",
    revision: 0,
    content: { blocks: [{ type: "paragraph", text: "قرار: تعيين المورد الأول." }, { type: "paragraph", text: "نص ثابت" }] },
  };
  const output = await exportStudio(artifact, workspace);
  const rel = "data/report.docx";
  fs.mkdirSync(path.dirname(path.join(workspace, rel)), { recursive: true });
  fs.writeFileSync(path.join(workspace, rel), output.buffer);
  return rel;
}

describe("office_intelligence_run tool", () => {
  it("exposes exactly the office intelligence tool", () => {
    const tools = createOfficeIntelligenceTools();
    assert.deepEqual(tools.map((tool) => tool.name), OFFICE_INTELLIGENCE_TOOL_NAMES);
    assert.deepEqual(OFFICE_INTELLIGENCE_TOOL_NAMES, ["office_intelligence_run"]);
  });

  it("runs deterministic sheet-analysis end-to-end with no model and never touches the file", async () => {
    const workspace = fs.mkdtempSync(path.join(tmpBase, "ws-e2e-"));
    const { rel, abs } = await makeXlsx(workspace);
    const before = fs.readFileSync(abs);
    const tool = createOfficeIntelligenceTools()[0]!;
    const result = await tool.run({ capability: "sheet-analysis", path: rel }, makeCtx(workspace));
    assert.ok(result.ok, result.content);
    assert.match(result.content, /airun_[0-9a-f-]+/, "the run id is reported for later polling");
    assert.match(result.content, /أوراق/, "the deterministic spreadsheet summary is included");
    assert.match(result.content, /المصادر: \d+ مرجعًا/, "citation count is included");
    assert.ok(fs.readFileSync(abs).equals(before), "a read-only analysis must leave the artifact byte-identical");
  });

  it("rejects an unknown capability with the supported list", async () => {
    const workspace = fs.mkdtempSync(path.join(tmpBase, "ws-unknown-"));
    const tool = createOfficeIntelligenceTools()[0]!;
    const result = await tool.run({ capability: "magic-wand", path: "data/budget.xlsx" }, makeCtx(workspace));
    assert.ok(!result.ok);
    assert.match(result.content, /قدرة غير معروفة/);
    assert.match(result.content, /sheet-analysis/, "the supported capability ids are listed");
  });

  it("rejects a path whose extension is not DOCX/XLSX/PPTX", async () => {
    const workspace = fs.mkdtempSync(path.join(tmpBase, "ws-ext-"));
    fs.mkdirSync(path.join(workspace, "data"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "data/notes.txt"), "plain");
    const tool = createOfficeIntelligenceTools()[0]!;
    const result = await tool.run({ capability: "doc-summary", path: "data/notes.txt" }, makeCtx(workspace));
    assert.ok(!result.ok);
    assert.match(result.content, /DOCX وXLSX وPPTX فقط/);
  });

  it("returns a background note with the run id when waitMs elapses", async () => {
    const workspace = fs.mkdtempSync(path.join(tmpBase, "ws-timeout-"));
    const { rel } = await makeXlsx(workspace);
    const tool = createOfficeIntelligenceTools()[0]!;
    const result = await tool.run({ capability: "sheet-analysis", path: rel, waitMs: 1 }, makeCtx(workspace));
    assert.ok(result.ok, result.content);
    assert.match(result.content, /airun_[0-9a-f-]+/, "the still-running run id is returned");
    assert.match(result.content, /الخلفية/, "the result says the run continues in the background");
  });

  it("reports model unavailability and points at the deterministic capabilities", async () => {
    const workspace = fs.mkdtempSync(path.join(tmpBase, "ws-nomodel-"));
    const rel = await makeDocx(workspace);
    const tool = createOfficeIntelligenceTools()[0]!;
    const result = await tool.run({ capability: "doc-summary", path: rel }, makeCtx(workspace));
    assert.ok(!result.ok, result.content);
    assert.match(result.content, /النموذج غير متاح/);
    for (const id of ["sheet-analysis", "sheet-anomalies", "sheet-cleaning", "sheet-forecast", "sheet-formula", "legal-matter-timeline"]) {
      assert.ok(result.content.includes(id), `the deterministic fallback list names ${id}`);
    }
  });
});

describe("office intelligence registration and policy wiring", () => {
  it("service gap tools factory returns the expected dormant tool names", () => {
    const tools = createServiceGapTools();
    assert.deepEqual(tools.map((tool) => tool.name), SERVICE_GAP_TOOL_NAMES);
    assert.deepEqual(SERVICE_GAP_TOOL_NAMES, ["task_run", "task_resume", "schedule_update", "image_ocr", "video_analyze", "file_project_check", "device_preview"]);
  });

  it("write and data modes expose the office/media/device tools; ask stays read-only", () => {
    for (const modeId of ["write", "data"]) {
      const mode = LOAM_MODES.find((m) => m.id === modeId);
      assert.ok(mode, `mode ${modeId} exists`);
      for (const name of ["office_workflow_run", "office_intelligence_run", "image_ocr", "device_preview"]) {
        assert.ok(mode.tools.includes(name), `mode ${modeId} exposes ${name}`);
      }
      for (const existing of ["office_import", "office_export", "office_status", "office_craft", "office_edit"]) {
        assert.ok(mode.tools.includes(existing), `mode ${modeId} keeps the existing office entry ${existing}`);
      }
    }
    const ask = LOAM_MODES.find((m) => m.id === "ask");
    assert.ok(ask && !ask.tools.includes("office_intelligence_run"), "the read-only ask mode never exposes an office run tool");
  });

  it("risk tiers: image_ocr is exec, device_preview is read, office runs write inside the workspace", () => {
    const root = fs.mkdtempSync(path.join(tmpBase, "ws-tier-"));
    assert.equal(classifyToolCall("image_ocr", { path: "img.png", lang: "ara" }, root), "exec", "OCR shells out to tesseract in WSL");
    assert.equal(classifyToolCall("device_preview", { port: 3000 }, root), "read", "device_preview is a workflow hint that touches nothing");
    assert.equal(classifyToolCall("office_intelligence_run", { capability: "sheet-analysis", path: "data/budget.xlsx" }, root), "write-workspace");
    assert.equal(classifyToolCall("office_workflow_run", { id: "wf_monthly" }, root), "write-workspace");
  });
});
