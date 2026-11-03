import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { exportStudio } from "../../../studio/export.js";
import type { StudioArtifact } from "../../../studio/store.js";
import { readSheetDoc, writeSheetDoc, type SheetDoc } from "../../../server/workspace/sheetIO.js";
import { loadOfficeArtifact } from "../artifactIO.js";
import { applyOfficeLink, previewOfficeLink, registerOfficeLink } from "../links.js";

let tmp = "";
let closeDb: () => void;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-office-links-"));
  process.env.MANUS_LOCAL_DATA_DIR = path.join(tmp, "data");
  closeDb = (await import("../../../server/sqliteStore.js")).closeDb;
});

after(() => {
  closeDb();
  delete process.env.MANUS_LOCAL_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("live Office links", () => {
  it("previews and applies sheet changes to a native slide", async () => {
    const sourceWorkspace = path.join(tmp, "source");
    const targetWorkspace = path.join(tmp, "target");
    fs.mkdirSync(sourceWorkspace, { recursive: true });
    fs.mkdirSync(targetWorkspace, { recursive: true });
    const doc: SheetDoc = { taskId: "source", path: "data.xlsx", name: "data.xlsx", sheets: [{ name: "Sheet1", cells: [["Metric", "Value"], ["Revenue", "100"]], styles: {}, columnWidths: [], rowHeights: [], merges: [], hiddenRows: [], hiddenColumns: [] }], notes: [] };
    await writeSheetDoc(path.join(sourceWorkspace, "data.xlsx"), doc);
    const deck: StudioArtifact = { kind: "presentation", title: "Report", revision: 0, content: { slides: [{ id: "s1", title: "Revenue", body: "old", notes: "", background: "#FFFFFF", accent: "#386bca" }] } };
    fs.writeFileSync(path.join(targetWorkspace, "report.pptx"), (await exportStudio(deck, targetWorkspace)).buffer);
    const source = await loadOfficeArtifact(sourceWorkspace, { taskId: "source", path: "data.xlsx", kind: "spreadsheet", tenantId: "local" });
    const target = await loadOfficeArtifact(targetWorkspace, { taskId: "target", path: "report.pptx", kind: "presentation", tenantId: "local" });
    const link = registerOfficeLink({
      scope: { tenantId: "local" },
      source: { artifact: source.ref, kind: "cell", anchor: "Sheet1!B2" },
      target: { artifact: target.ref, kind: "slide", anchor: "1" },
      targetField: "slide-body",
    });
    const preview = await previewOfficeLink(link.id, { sourceWorkspace, targetWorkspace });
    assert.equal(preview.sourceValue, "100");
    assert.equal(preview.changeSet.preview.length, 1);
    await applyOfficeLink(link.id, { sourceWorkspace, targetWorkspace });
    let reopened = await loadOfficeArtifact(targetWorkspace, { taskId: "target", path: "report.pptx", kind: "presentation", tenantId: "local" });
    assert.equal(reopened.artifact.kind, "presentation");
    if (reopened.artifact.kind === "presentation") assert.equal(reopened.artifact.content.slides[0]?.body, "100");

    const changed = await readSheetDoc(path.join(sourceWorkspace, "data.xlsx"), { taskId: "source", path: "data.xlsx", name: "data.xlsx" });
    changed.sheets[0]!.cells[1]![1] = "200";
    await writeSheetDoc(path.join(sourceWorkspace, "data.xlsx"), changed);
    const next = await previewOfficeLink(link.id, { sourceWorkspace, targetWorkspace });
    assert.equal(next.sourceValue, "200");
    await applyOfficeLink(link.id, { sourceWorkspace, targetWorkspace });
    reopened = await loadOfficeArtifact(targetWorkspace, { taskId: "target", path: "report.pptx", kind: "presentation", tenantId: "local" });
    if (reopened.artifact.kind === "presentation") assert.equal(reopened.artifact.content.slides[0]?.body, "200");
  });
});
