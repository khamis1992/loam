import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { exportStudio } from "../../../studio/export.js";
import type { StudioArtifact } from "../../../studio/store.js";
import { loadOfficeArtifact } from "../artifactIO.js";
import { legalSourceAnchor, listLegalSources, registerLegalSource, searchLegalSources } from "../legal/sources.js";
import { attachMatterArtifact, checkMatterConflicts, createMatter, getMatter, listMatters, matterDashboard, searchMatterArchive, updateMatter } from "../legal/matters.js";

let tmp = "";
let closeDb: () => void;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-legal-knowledge-"));
  process.env.MANUS_LOCAL_DATA_DIR = path.join(tmp, "data");
  closeDb = (await import("../../../server/sqliteStore.js")).closeDb;
});

after(() => {
  closeDb();
  delete process.env.MANUS_LOCAL_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("official legal library", () => {
  it("stores effective official sources and searches within tenant and effective date", () => {
    const saved = registerLegalSource({
      id: "official-1", tenantId: "firm", title: "قانون العمل", citation: "المادة 1", sourceUrl: "https://example.gov.qa/law/1", issuer: "الجهة الرسمية",
      text: "ينص النص الرسمي على التزام صريح.", effectiveFrom: "2020-01-01", retrievedAt: "2026-01-01", official: true,
    });
    assert.equal(saved.revision, 1);
    assert.equal(searchLegalSources({ tenantId: "firm" }, "التزام")[0]?.id, "official-1");
    assert.equal(searchLegalSources({ tenantId: "other" }, "التزام").length, 0);
    assert.equal(legalSourceAnchor(saved).kind, "file");
    assert.throws(() => registerLegalSource({ ...saved, text: "تعديل", revision: 1 }), /revision conflict/);
    const historic = registerLegalSource({
      id: "historic", tenantId: "firm", title: "نص ملغى", citation: "مادة قديمة", sourceUrl: "https://example.gov.qa/law/old", issuer: "الجهة الرسمية",
      text: "نص قديم", effectiveFrom: "2019-01-01", effectiveTo: "2020-01-01", retrievedAt: "2026-01-01", official: true,
    });
    assert.equal(historic.revision, 1);
    assert.equal(listLegalSources({ tenantId: "firm" }, new Date("2026-01-01")).some((source) => source.id === "historic"), false);
    assert.equal(listLegalSources({ tenantId: "firm" }, new Date("2019-06-01")).some((source) => source.id === "historic"), true);
  });
});

describe("matter 360 and firm archive", () => {
  it("tracks matters, conflicts, deadlines and attached-document search", async () => {
    const first = createMatter({
      tenantId: "firm", title: "نزاع تعاقدي", client: "شركة الإنماء", practiceArea: "commercial",
      parties: [{ name: "شركة الخصم", role: "defendant" }],
      deadlines: [{ title: "موعد سابق", dueAt: "2020-01-01" }, { title: "موعد قادم", dueAt: "2099-01-01" }],
      tasks: [{ title: "جمع المستندات", status: "open" }],
    });
    const second = createMatter({ tenantId: "firm", title: "استشارة جديدة", client: "شركة الانماء", practiceArea: "commercial", parties: [] });
    assert.equal(checkMatterConflicts(second.id).some((match) => match.matterId === first.id), true);
    assert.equal(matterDashboard(first.id, new Date("2026-01-01")).overdueDeadlines.length, 1);
    assert.equal(matterDashboard(first.id, new Date("2026-01-01")).upcomingDeadlines.length, 1);
    const updated = updateMatter(first.id, 1, { tasks: [{ title: "جمع المستندات", status: "done" }] });
    assert.equal(updated.revision, 2);
    assert.equal(matterDashboard(first.id).openTasks, 0);
    assert.throws(() => updateMatter(first.id, 1, { summary: "stale" }), /revision conflict/);

    const workspace = path.join(tmp, "matter-workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const artifact: StudioArtifact = { kind: "document", title: "العقد", revision: 0, content: { blocks: [{ type: "paragraph", text: "وقع الطرفان العقد في 12/03/2024." }] } };
    const output = await exportStudio(artifact, workspace);
    fs.writeFileSync(path.join(workspace, "contract.docx"), output.buffer);
    const loaded = await loadOfficeArtifact(workspace, { taskId: "task_matter", path: "contract.docx", kind: "document", tenantId: "firm" });
    const attached = attachMatterArtifact(first.id, loaded.ref, 2);
    assert.equal(attached.artifacts.length, 1);
    const found = await searchMatterArchive({ tenantId: "firm" }, "العقد", () => workspace);
    assert.ok(found.results.some((result) => result.matterId === first.id));
    assert.equal(listMatters({ tenantId: "other" }).length, 0);
    assert.equal(getMatter(first.id).artifacts[0]?.path, "contract.docx");
  });
});
