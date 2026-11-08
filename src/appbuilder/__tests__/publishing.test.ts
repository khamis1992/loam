import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-app-publishing-"));
process.env.MANUS_LOCAL_DATA_DIR = dir;

const { createAppProject } = await import("../projects.js");
const publishing = await import("../publishing.js");
const { zipEntryNames } = await import("../../preview/zip.js");
const sqlite = await import("../../server/sqliteStore.js");

after(() => {
  sqlite.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("local app publishing lifecycle", () => {
  it("creates, confirms, updates and unpublishes a verified ZIP without secrets", () => {
    const project = createAppProject({ title: "Publish Test", baseWorkspace: dir });
    const app = path.join(project.workspaceDir, project.appDir);
    fs.mkdirSync(path.join(app, "src"), { recursive: true });
    fs.writeFileSync(path.join(app, "src", "index.html"), "<h1>published</h1>");
    fs.writeFileSync(path.join(app, ".env"), "DO_NOT_INCLUDE=true");
    fs.mkdirSync(path.join(app, "data"), { recursive: true });
    fs.writeFileSync(path.join(app, "data", "app.sqlite"), "private data");

    const proposed = publishing.createPublishProposal(project.id);
    assert.equal(proposed.status, "proposed");
    const confirmed = publishing.confirmPublishProposal(proposed.id);
    assert.equal(confirmed.status, "confirmed");
    const names = zipEntryNames(fs.readFileSync(confirmed.artifactPath!));
    assert.deepEqual(names, ["src/index.html"]);

    const updated = publishing.updatePublishedApp(confirmed.id);
    assert.equal(updated.status, "confirmed");
    assert.notEqual(updated.id, confirmed.id);
    const unpublished = publishing.unpublishApp(updated.id);
    assert.equal(unpublished.status, "unpublished");
    assert.equal(fs.existsSync(updated.artifactPath!), false);
  });
});
