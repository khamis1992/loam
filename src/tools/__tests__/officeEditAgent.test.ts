/**
 * Unit tests for the O2 office edit agent (src/tools/officeEditAgent.ts):
 *  - instruction → op planning is deterministic and minimal (never a
 *    whole-file rewrite op set),
 *  - the applier changes only the targeted elements (everything else is
 *    deep-equal), and
 *  - the injected tool wiring (mock stores/apiller/export) records exactly
 *    one targeted save + one in-place file write.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, before, after } from "node:test";

import type { StudioArtifact } from "../../studio/store.js";
import {
  planOfficeEdits,
  applyOfficeEdits,
  parseCellAddress,
  columnLetters,
  createOfficeEditTools,
  type OfficeEditOp,
} from "../officeEditAgent.js";
import { LOAM_MODES } from "../../modes/catalog.js";

/* ---------- fixtures ---------- */

const documentArtifact = (): StudioArtifact => ({
  kind: "document",
  title: "Report",
  revision: 3,
  content: {
    blocks: [
      { type: "paragraph", text: "Alpha summary of the quarter." },
      { type: "heading", text: "Vision Alpha" },
      { type: "paragraph", text: "Work streams Beta." },
      { type: "table", text: "", columns: ["Name", "Value"], rows: [["Alpha", "1"], ["Delta", "2"]] },
    ],
    regions: [{ kind: "header", part: "word/header1.xml", label: "header1", text: "Draft header" }],
  },
});

const spreadsheetArtifact = (): StudioArtifact => ({
  kind: "spreadsheet",
  title: "Budget",
  revision: 1,
  content: {
    sheets: [
      {
        name: "Sheet1",
        sourceIndex: 0,
        cells: [["Item", "Cost"], ["Alpha", "3"], ["Gamma", "7"]],
      },
    ],
  },
});

const presentationArtifact = (): StudioArtifact => ({
  kind: "presentation",
  title: "Deck",
  revision: 2,
  content: {
    slides: [
      { id: "s1", sourceIndex: 0, title: "Opening Alpha", body: "Intro words", notes: "", background: "#FFFFFF", accent: "#386BCA" },
      { id: "s2", sourceIndex: 1, title: "Current", body: "Alpha closing", notes: "old notes", background: "#FFFFFF", accent: "#386BCA" },
    ],
  },
});

/** Primitive-level JSON diff: returns paths under root ("" = whole) that differ. */
function diffPaths(before: unknown, after: unknown, prefix = ""): string[] {
  if (before === after) return [];
  if (Array.isArray(after) && Array.isArray(before)) {
    const out: string[] = [];
    const length = Math.max(before.length, after.length);
    for (let i = 0; i < length; i++) out.push(...diffPaths(before[i], after[i], `${prefix}.${i}`));
    return out;
  }
  if (after && before && typeof after === "object" && typeof before === "object") {
    const out: string[] = [];
    for (const key of new Set([...Object.keys(after as object), ...Object.keys(before as object)])) {
      out.push(...diffPaths((before as never)[key], (after as never)[key], `${prefix}.${key}`));
    }
    return out;
  }
  return [prefix || "*"];
}

/* ---------- op typing ---------- */

const TARGETED_OPS = new Set(["set-title", "set-cell", "replace-text", "set-slide-title", "set-slide-notes", "set-block-text", "set-region-text"]);

/* ---------- tests ---------- */

describe("O2 office edit agent", () => {
  it("parses A1 addresses and columns", () => {
    assert.deepEqual(parseCellAddress("b3"), { row: 3, column: 2 });
    assert.deepEqual(parseCellAddress("AA10"), { row: 10, column: 27 });
    assert.equal(parseCellAddress("0A2"), null);
    assert.equal(columnLetters(27), "AA");
  });

  it("plans one minimal replace-text op from a replace instruction (document)", () => {
    const artifact = documentArtifact();
    const snapshot = structuredClone(artifact);
    const plan = planOfficeEdits('Replace "Alpha" with "Beta" in the document.', artifact);
    assert.ok(!plan.error);
    assert.equal(plan.ops.length, 1, "one clause → one op, never a whole-file rewrite");
    assert.deepEqual(plan.ops[0], { op: "replace-text", find: "Alpha", replace: "Beta" });
    assert.deepEqual(artifact, snapshot, "planning must not mutate the artifact");
  });

  it("plans set-cell / set-slide-title / set-slide-notes ops", () => {
    const cell = planOfficeEdits('Set cell B2 to "42" in Sheet1.', spreadsheetArtifact());
    assert.deepEqual(cell.ops, [{ op: "set-cell", address: "B2", value: "42", sheet: "Sheet1" }]);
    const title = planOfficeEdits('Set slide 2 title to "Overview".', presentationArtifact());
    assert.deepEqual(title.ops, [{ op: "set-slide-title", slide: 2, value: "Overview" }]);
    const notes = planOfficeEdits("slide 2 notes to new speaker notes", presentationArtifact());
    assert.deepEqual(notes.ops, [{ op: "set-slide-notes", slide: 2, value: "new speaker notes" }]);
    const multi = planOfficeEdits('Set slide 1 title to "A"; set cell B3 to "9".', presentationArtifact());
    assert.equal(multi.ops.length, 2);
  });

  it("fails honestly on an unsupported instruction (no ops, no rewrite)", () => {
    const plan = planOfficeEdits("make the document beautiful with a full redesign", spreadsheetArtifact());
    assert.ok(plan.error);
    assert.equal(plan.ops.length, 0);
  });

  it("applier changes ONLY the targeted elements — document replace-text", () => {
    const artifact = documentArtifact();
    const result = applyOfficeEdits(artifact, [{ op: "replace-text", find: "Alpha", replace: "Zeta" }]);
    assert.equal(result.applied.length, 1);
    const changed = diffPaths(artifact, result.artifact);
    assert.deepEqual(changed, [".content.blocks.0.text", ".content.blocks.1.text", ".content.blocks.3.rows.0.0"], "table cell also matched; nothing else changed");
    const next = result.artifact as Extract<StudioArtifact, { kind: "document" }>;
    assert.equal(next.content.blocks[2]!.text, "Work streams Beta.");
    assert.equal(next.title, "Report");
    assert.equal((next.content.regions ?? [])[0]!.text, "Draft header");
    assert.equal((next.content.regions ?? [])[0]!.part, "word/header1.xml");
  });

  it("applier changes ONLY the targeted cell — spreadsheet", () => {
    const artifact = spreadsheetArtifact();
    const result = applyOfficeEdits(artifact, [{ op: "set-cell", address: "B3", value: "9", sheet: "Sheet1" }]);
    assert.equal(result.applied.length, 1);
    const next = result.artifact as Extract<StudioArtifact, { kind: "spreadsheet" }>;
    assert.deepEqual(diffPaths(artifact, next), [".content.sheets.0.cells.2.1"]);
    assert.deepEqual(next.content.sheets[0]!.cells[0], ["Item", "Cost"]);
    assert.equal(next.content.sheets[0]!.name, "Sheet1");
  });

  it("applier changes ONLY the targeted slide, keeps sourceIndex for round-trip", () => {
    const artifact = presentationArtifact();
    const result = applyOfficeEdits(artifact, [
      { op: "set-slide-title", slide: 2, value: "Overview" },
      { op: "set-slide-notes", slide: 2, value: "speaker notes" },
    ]);
    assert.equal(result.applied.length, 2);
    const changed = diffPaths(artifact, result.artifact).sort();
    assert.deepEqual(changed, [".content.slides.1.notes", ".content.slides.1.title"]);
    const next = result.artifact as Extract<StudioArtifact, { kind: "presentation" }>;
    assert.equal(next.content.slides[0]!.title, "Opening Alpha");
    assert.equal(next.content.slides[0]!.sourceIndex, 0);
    assert.equal(next.content.slides[1]!.sourceIndex, 1);
    assert.equal(next.content.slides[1]!.background, "#FFFFFF");
  });

  it("applier reports skips instead of rewriting around unknown targets", () => {
    const artifact = spreadsheetArtifact();
    const result = applyOfficeEdits(artifact, [{ op: "set-cell", address: "Z99", value: "x", sheet: "Sheet1" }]);
    assert.equal(result.applied.length, 0);
    assert.ok(result.skipped[0]!.reason.includes("outside the existing grid"));
  });

  it("office_edit tool: injects applier + stores, one targeted save, one in-place write", async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-office-edit-"));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const fileRel = "uploads/report.docx";
    const fileAbsolute = path.join(tmp, fileRel);
    fs.mkdirSync(path.dirname(fileAbsolute), { recursive: true });
    fs.writeFileSync(fileAbsolute, Buffer.from("orig"));

    const artifact = { ...documentArtifact(), revision: 5 };
    const readStudioCalls: number[] = [];
    const savedPayloads: StudioArtifact[] = [];
    const exported: Array<{ revision: number; workspace: string }> = [];
    const applierInputs: OfficeEditOp[][] = [];
    const exportedBuffer = Buffer.from("patched");

    const tools = createOfficeEditTools({
      readStudio(workspace) {
        readStudioCalls.push(1);
        return artifact;
      },
      saveStudio(workspace, input, expectedRevision) {
        assert.equal(expectedRevision as number, 5, "save is revision-conscious");
        savedPayloads.push(input as StudioArtifact);
        assert.ok(typeof workspace === "string" && workspace.length > 0);
        return { ...(input as StudioArtifact), revision: (expectedRevision as number) + 1 };
      },
      async exportStudio(artifact) {
        exported.push({ revision: artifact.revision, workspace: "validated" });
        return { buffer: exportedBuffer, filename: "report.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
      },
      applier(input, ops) {
        applierInputs.push(ops);
        return applyOfficeEdits(input, ops);
      },
    });
    assert.deepEqual(tools.map((t2) => t2.name), ["office_edit"]);
    const tool = tools[0]!;
    const result = await tool.run(
      { path: fileRel, instruction: 'Replace "Alpha" with "Zeta" in the document.' },
      { cfg: {} as never, workspace: tmp, emit: () => {} },
    );
    assert.ok(result.ok, result.content);
    const [_r, input, expected] = applierInputs;
    void _r;
    assert.equal(readStudioCalls.length, 1);
    assert.deepEqual(
      applierInputs,
      [[{ op: "replace-text", find: "Alpha", replace: "Zeta" }]],
      "the applier sees exactly the minimal targeted op list",
    );
    void expected;
    assert.equal(applierInputs.flat().every((op) => TARGETED_OPS.has(op.op)), true, "no op kind outside the targeted vocabulary");
    assert.equal(applierInputs.flat().length, 1, "never a full-regenerate batch");
    assert.equal(savedPayloads.length, 1);
    const changed = diffPaths(documentArtifact(), savedPayloads[0]!).filter((p) => p !== ".revision" && p !== ".revision.0");
    const expectedChanged = [".content.blocks.0.text", ".content.blocks.1.text", ".content.blocks.3.rows.0.0"];
    assert.deepEqual(changed, expectedChanged, "the saved studio differs from the original ONLY at the targeted actions");
    assert.equal(exported.length, 1);
    const written = fs.readFileSync(fileAbsolute);
    assert.ok(written.equals(exportedBuffer), "the uploaded file is rewritten in place with the exported bytes");
  });

  it("office_edit tool reports a pure failure without touching the file on empty plan", async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-office-edit2-"));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const fileRel = "uploads/report.docx";
    const fileAbsolute = path.join(tmp, fileRel);
    fs.mkdirSync(path.dirname(fileAbsolute), { recursive: true });
    fs.writeFileSync(fileAbsolute, Buffer.from("orig"));
    const artifact = documentArtifact();
    let saveCalls = 0;
    const tools = createOfficeEditTools({
      readStudio: () => artifact,
      saveStudio() { saveCalls++; throw new Error("must not save"); },
      async exportStudio() { throw new Error("must not export"); },
    });
    const result = await tools[0]!.run(
      { path: fileRel, instruction: "make it magnificent" },
      { cfg: {} as never, workspace: tmp, emit: () => {} },
    );
    assert.ok(!result.ok, result.content);
    assert.equal(saveCalls, 0);
    assert.ok(fs.readFileSync(fileAbsolute).equals(Buffer.from("orig")), "the file remains byte-identical when no op applies");
  });

  it("office_edit is exposed to agent runs: listed by the write and data Loam modes", () => {
    for (const modeId of ["write", "data"]) {
      const mode = LOAM_MODES.find((m) => m.id === modeId);
      assert.ok(mode, `mode ${modeId} exists`);
      assert.ok(mode.tools.includes("office_edit"), `mode ${modeId}'s tool allowlist exposes office_edit`);
    }
    const ask = LOAM_MODES.find((m) => m.id === "ask");
    assert.ok(ask && !ask.tools.includes("office_edit"), "ask (read-only) mode never exposes a file-writing tool");
  });
});
