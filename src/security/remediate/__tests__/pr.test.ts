import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prTitle, prBody, prBodyHash, diffHash, branchName } from "../pr/body.js";
import { loadPack } from "../packs/loader.js";
import { FIXTURES, materialize, readFixtureFiles } from "./fixtures.js";
import { runInventory } from "../inventory/index.js";
import { planEdits } from "../gate/index.js";
import type { FixProposal, RepoPlan, TestComparison } from "../types.js";

const advisories = path.resolve(process.cwd(), "security", "advisories");

function plan(over: Partial<RepoPlan> = {}): RepoPlan {
  return {
    repoId: "nva", path: "/wt", branch: "loam/remediate/node-2026-10-21/abc", baseBranch: "main",
    phase: "fix_gate", vulns: [], proposal: null, baseline: null, after: null, comparison: null,
    runtimeDiff: null, smoke: null, artifactProof: null, fixGate: null, commitApproval: null,
    prApproval: null, commitSha: null, pr: null, blockedReason: null, rollbackTarget: { version: "22.21.0" },
    ...over,
  };
}

test("PR body is the deterministic template: rows, evidence, mitigations, closure, attribution", () => {
  const { pack } = loadPack("node-2026-10-21", advisories);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rem-pr-"));
  try {
    const dir = materialize(FIXTURES.find((f) => f.name === "php-vuln-app")!, tmp); // pack with mitigations
    const phpPack = loadPack("php-2026-10-21", advisories).pack;
    const body = prBody({
      runId: "run-123", pack: phpPack,
      records: [{
        id: "v1", ecosystem: "php", advisoryId: "php-2026-10-21", cves: ["CVE-2026-109618"],
        hit: { repoId: "r", file: "Dockerfile", line: 1, signal: "FROM php:8.3.12-fpm", channel: "dockerfile", currentVersion: "8.3.12", pinStyle: "exact", production: true, testCoverage: "none", confidence: "high", upgradeRiskNotes: [], sapis: ["fpm"] },
        status: "vulnerable", proposedTarget: "8.3.36", upgradeClass: "patch", riskLabel: "low",
        origin: { kind: "runtime_inventory" },
        mitigations: [{ id: "upload-progress-off", summary: "session.upload_progress.enabled=0", isFix: false }],
      }],
      proposal: {
        vulnId: "v1", repoId: "r",
        verification: { target: { value: "8.3.36", line: "8.3", packId: "php-2026-10-21", packSha256: "x" }, status: "verified", evidence: [{ kind: "vendor_release_index", at: "2026-10-25T00:00:00Z", url: "https://www.php.net/releases/index.php?json&version=8.3", httpStatus: 200, value: "8.3.36", detail: "release index lists 8.3.36" }] },
        edits: [{ file: "Dockerfile", line: 1, before: "FROM php:8.3.12-fpm-bookworm", after: "FROM php:8.3.36-fpm-bookworm", rationale: "exact tag bump keep -fpm-bookworm" }],
        upgradeClass: "patch", riskLabel: "low", mitigations: [],
      },
      plan: plan({ fixGate: { verdict: "patched_unverified", reason: "docker unavailable" } }),
      comparison: null,
    });
    // Deterministic template markers — no model prose.
    assert.ok(body.includes("نتريو · مسار الإصلاح المُتحقَّق · run run-123"));
    assert.ok(body.includes("**draft**"));
    assert.ok(body.includes("| `Dockerfile:1` | 8.3.12 | 8.3.36 | exact | production | low |"));
    assert.ok(body.includes("vendor_release_index: 8.3.36"));
    assert.ok(body.includes("**patched_unverified** — docker unavailable"));
    assert.ok(body.includes("### Temporary mitigations (not a fix)"));
    assert.ok(body.includes("session.upload_progress.enabled=0"));
    assert.ok(body.includes("`fixed_pending_deploy`"));
    assert.ok(body.includes("CognitionAI/devin-vuln-fixes (MIT"));
    // Hash stability.
    assert.equal(prBodyHash(body), prBodyHash(body));
    assert.match(prBodyHash(body), /^[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("unverified fix prefixes the PR title with [unverified] (E10)", () => {
  const { pack } = loadPack("node-2026-10-21", advisories);
  assert.equal(prTitle(pack, { verdict: "patched_unverified", reason: "x" }), "[unverified] Remediate: Node.js October 21, 2026 security release");
  assert.equal(prTitle(pack, { verdict: "verified_fixed", reason: "" }), "Remediate: Node.js October 21, 2026 security release");
});

test("branch name shape + diff hash stability", () => {
  assert.equal(branchName("node-2026-10-21", "abcd1234-5678"), "loam/remediate/node-2026-10-21/abcd1234");
  assert.equal(diffHash("+a\n"), diffHash("+a\n"));
  assert.notEqual(diffHash("+a\n"), diffHash("+b\n"));
});
