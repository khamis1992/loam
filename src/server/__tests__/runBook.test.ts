/**
 * Threat model + coverage ledger stores.
 *
 * Both are task-scoped and shared by every agent of the task: `amend` merges by
 * name instead of forking a private model, and the coverage report keeps the
 * cleared negative space next to the open proof gaps so "done" is auditable.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

let model: typeof import("../threatModel.js");
let coverage: typeof import("../coverageStore.js");
let closeDb: () => void;

describe("run book stores", () => {
  before(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-runbook-"));
    process.env.MANUS_LOCAL_DATA_DIR = dir;
    const sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    model = await import("../threatModel.js");
    coverage = await import("../coverageStore.js");
  });

  after(() => {
    closeDb();
  });

  it("amends a threat model by name instead of duplicating it", () => {
    const task = "task-model";
    model.saveThreatModel(task, {
      summary: "Shop API",
      actors: [{ name: "anonymous", description: "no account", capability: "network" }],
      assets: [{ name: "customer PII", where: "/api/customers", criticality: "critical" }],
      boundaries: [{ from: "internet", to: "api" }],
      assumptions: ["the CDN strips untrusted headers"],
    }, "replace");
    const amended = model.saveThreatModel(task, {
      actors: [{ name: "Anonymous", description: "no account either", capability: "network" }],
      assumptions: ["tokens are not rotated"],
      notes: ["CDN header claim disproved"],
    }, "amend");
    assert.equal(amended.actors.length, 1);
    assert.equal(amended.actors[0]!.description, "no account either");
    assert.equal(amended.assumptions.length, 2);
    assert.equal(amended.assets.length, 1);
    assert.match(model.formatThreatModel(amended), /customer PII \(critical\) at \/api\/customers/);
  });

  it("returns an empty model for an unknown task", () => {
    const empty = model.getThreatModel("task-nothing");
    assert.deepEqual(empty.actors, []);
    assert.match(model.formatThreatModel(empty), /empty model/);
  });

  it("records, updates and reports coverage with the negative space", () => {
    const task = "task-coverage";
    const clean = coverage.recordCoverage(task, { target: "/login", check: "sql injection" });
    const gap = coverage.recordCoverage(task, { target: "/admin", check: "idor", status: "partial", notes: ["needs a second account"] });
    const hit = coverage.recordCoverage(task, { target: "/search", check: "reflected xss", findingCount: 1 });
    coverage.updateCoverage(task, clean.id, { status: "covered", findingCount: 0 });

    const report = coverage.coverageReport(task);
    assert.equal(report.total, 3);
    assert.deepEqual(report.cleared.map((e) => e.target), ["/login"]);
    assert.deepEqual(report.gaps.map((e) => e.target), ["/admin"]);
    assert.deepEqual(report.findingsByTarget, [{ target: "/search", findings: 1 }]);

    const text = coverage.formatCoverageReport(report);
    assert.match(text, /Open proof gaps/);
    assert.match(text, /\/admin — idor \[partial\]: needs a second account/);
    assert.match(text, /\/login — sql injection/);

    coverage.deleteCoverage(task, hit.id);
    assert.equal(coverage.listCoverage(task).length, 2);
    assert.equal(gap.status, "partial");
  });

  it("re-recording the same target+check refreshes instead of duplicating", () => {
    const task = "task-dedupe";
    coverage.recordCoverage(task, { target: "/a", check: "tls", status: "error", notes: ["timeout"] });
    const second = coverage.recordCoverage(task, { target: "/a", check: "tls", status: "covered", findingCount: 0 });
    assert.equal(coverage.listCoverage(task).length, 1);
    assert.equal(second.status, "covered");
    assert.equal(coverage.listCoverage(task)[0]!.id, second.id);
  });
});
