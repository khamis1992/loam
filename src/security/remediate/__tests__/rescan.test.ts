import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rescanRuntimeInventory, closureFromRescan, closeWithDeployEvidence } from "../rescan/index.js";
import { RemediationError } from "../errors.js";
import type { RemediationRun, VulnRecord } from "../types.js";
import { FIXTURES, materialize, readFixtureFiles } from "./fixtures.js";
import { runInventory } from "../inventory/index.js";
import { writeRun } from "../store.js";

const advisories = path.resolve(process.cwd(), "security", "advisories");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rem-rescan-"));

function run(records: VulnRecord[]): RemediationRun {
  return {
    id: "rescan-run", createdAt: new Date().toISOString(), state: "complete",
    advisoryIds: ["node-2026-10-21"], packHashes: {}, repos: ["nva"],
    inventory: records, unsearchable: [], scopeApproval: null, plans: [], evidence: [], closures: [],
    host: { platform: process.platform, docker: { available: false } }, model: "cloud", budget: { limit: null, spent: 0 },
  };
}

test("rescan on the fix branch classifies the row fixed -> fixed_pending_deploy", () => {
  const vulnDir = materialize(FIXTURES.find((f) => f.name === "node-vuln-app")!, dataDir);
  const before = runInventory([{ repoId: "nva", files: readFixtureFiles(vulnDir), lockfileContent: null }], advisories);
  const vuln = before.records.find((r) => r.hit.file === "Dockerfile")!;

  // Simulate the fix: bump the Dockerfile in place (in the temp fixture only).
  const fixedContent = FIXTURES.find((f) => f.name === "node-vuln-app")!.files["Dockerfile"]!.replace("22.21.0", "22.23.4");
  fs.writeFileSync(path.join(vulnDir, "Dockerfile"), fixedContent);
  const files = readFixtureFiles(vulnDir).map((f) => (f.rel === "Dockerfile" ? { rel: f.rel, content: fixedContent } : f));
  const post = rescanRuntimeInventory({ repoId: "nva", files, lockfileContent: null }, ["node-2026-10-21"], advisories);
  const postRow = post.records.find((r) => r.hit.file === "Dockerfile");

  const closure = closureFromRescan(vuln, postRow);
  assert.equal(closure.state, "fixed_pending_deploy");
  assert.equal(closure.rescan.outcome, "fixed");
  fs.rmSync(vulnDir, { recursive: true, force: true });
});

test("persistent vulnerability on rescan -> still_vulnerable", () => {
  const vulnDir = materialize(FIXTURES.find((f) => f.name === "node-vuln-app")!, dataDir);
  const before = runInventory([{ repoId: "nva", files: readFixtureFiles(vulnDir), lockfileContent: null }], advisories);
  const vuln = before.records.find((r) => r.hit.file === "Dockerfile")!;
  const post = rescanRuntimeInventory({ repoId: "nva", files: readFixtureFiles(vulnDir), lockfileContent: null }, ["node-2026-10-21"], advisories);
  const postRow = post.records.find((r) => r.hit.file === "Dockerfile");
  const closure = closureFromRescan(vuln, postRow);
  assert.equal(closure.state, "still_vulnerable");
  fs.rmSync(vulnDir, { recursive: true, force: true });
});

test("close: matching deploy evidence -> closed; mismatched -> 409 (OD-10)", () => {
  const vulnDir = materialize(FIXTURES.find((f) => f.name === "node-vuln-app")!, dataDir);
  const before = runInventory([{ repoId: "nva", files: readFixtureFiles(vulnDir), lockfileContent: null }], advisories);
  const r = run(before.records);
  writeRun(r, dataDir);

  assert.throws(() => closeWithDeployEvidence(r, before.records[0]!.id, { observedVersion: "v22.21.0", note: "stale", evidenceId: "EV0001" }),
    (e: unknown) => e instanceof RemediationError && e.code === "deploy_evidence_mismatch");

  const closed = closeWithDeployEvidence(r, before.records[0]!.id, { observedVersion: "v22.23.4", note: "staging pod reports v22.23.4", evidenceId: "EV0002" });
  const record = closed.closures.find((c) => c.vulnId === before.records[0]!.id);
  assert.equal(record?.state, "closed");
  assert.ok((record?.deployEvidence?.observedVersion ?? '').includes('22.23.4'));
  fs.rmSync(vulnDir, { recursive: true, force: true });
});
