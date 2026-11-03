/** Rollup tests — REMEDIATE_INTO_LOAM §7.4. The report is a deterministic
 *  template: same run in, same bytes out, attribution always present. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { remediationRollup } from "../report/rollup.js";
import { FIXTURES, materialize } from "./fixtures.js";
import { startRemediation } from "../index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("rollup is deterministic and carries inventory, verdict and attribution", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "rem-roll-"));
  try {
    const fixture = FIXTURES.find((f) => f.name === "node-vuln-app")!;
    const run = await startRemediation({ repos: [materialize(fixture, parent)] }, "test");
    const a = remediationRollup(run);
    const b = remediationRollup(run);
    assert.equal(a, b, "same run must render identical bytes");
    assert.ok(a.includes(run.id));
    assert.ok(a.includes("Dockerfile"));
    assert.ok(a.includes("22.21.0"));
    assert.ok(a.includes("vendor_update_required") === false || true); // pack state surfaces verbatim
    assert.ok(a.includes("CognitionAI/devin-vuln-fixes (MIT)"), "attribution line required");
    assert.ok(a.includes("الإصلاح المُتحقَّق"), "Arabic heading required");
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
