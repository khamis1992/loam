import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { exportStudio } from "../../../studio/export.js";
import type { StudioArtifact } from "../../../studio/store.js";
import { createOfficeChangeSet } from "../changesets.js";
import { loadOfficeArtifact, saveOfficeChangeSet } from "../artifactIO.js";

describe("Office artifact change-set persistence", () => {
  it("applies and saves a targeted DOCX edit", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-doc-ai-"));
    try {
      const artifact: StudioArtifact = {
        kind: "document", title: "مذكرة", revision: 0,
        content: { blocks: [{ type: "paragraph", text: "النص الأصلي" }, { type: "paragraph", text: "نص ثابت" }] },
      };
      const output = await exportStudio(artifact, workspace);
      fs.writeFileSync(path.join(workspace, "memo.docx"), output.buffer);
      const loaded = await loadOfficeArtifact(workspace, { taskId: "task_doc", path: "memo.docx", kind: "document", tenantId: "local" });
      const changeSet = createOfficeChangeSet(loaded.ref, [{ op: "set-block-text", block: 2, value: "النص المعدل" }]);
      const saved = await saveOfficeChangeSet(workspace, changeSet);
      assert.equal(saved.revision, loaded.ref.revision + 1);
      const reopened = await loadOfficeArtifact(workspace, { taskId: "task_doc", path: "memo.docx", kind: "document", tenantId: "local" });
      assert.equal(reopened.artifact.kind, "document");
      if (reopened.artifact.kind === "document") {
        assert.equal(reopened.artifact.content.blocks[0]?.text, "مذكرة");
        assert.equal(reopened.artifact.content.blocks[1]?.text, "النص المعدل");
        assert.equal(reopened.artifact.content.blocks[2]?.text, "نص ثابت");
      }
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("applies and saves a targeted PPTX edit with revision checks", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-slides-ai-"));
    try {
      const artifact: StudioArtifact = {
        kind: "presentation", title: "القضية", revision: 0,
        content: { slides: [{ id: "s1", title: "الوقائع", body: "التفاصيل", notes: "ملاحظة", background: "#FFFFFF", accent: "#386bca" }] },
      };
      const output = await exportStudio(artifact, workspace);
      fs.writeFileSync(path.join(workspace, "case.pptx"), output.buffer);
      const loaded = await loadOfficeArtifact(workspace, { taskId: "task_slides", path: "case.pptx", kind: "presentation", tenantId: "local" });
      const changeSet = createOfficeChangeSet(loaded.ref, [{ op: "set-slide-title", slide: 1, value: "الوقائع المعدلة" }]);
      const saved = await saveOfficeChangeSet(workspace, changeSet);
      assert.equal(saved.revision, loaded.ref.revision + 1);
      const reopened = await loadOfficeArtifact(workspace, { taskId: "task_slides", path: "case.pptx", kind: "presentation", tenantId: "local" });
      assert.equal(reopened.artifact.kind, "presentation");
      if (reopened.artifact.kind === "presentation") {
        assert.equal(reopened.artifact.content.slides[0]?.title, "الوقائع المعدلة");
        assert.equal(reopened.artifact.content.slides[0]?.body, "التفاصيل");
        assert.equal(reopened.artifact.revision, loaded.ref.revision + 1);
      }
      await assert.rejects(() => saveOfficeChangeSet(workspace, changeSet), /changed|revision/i);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
