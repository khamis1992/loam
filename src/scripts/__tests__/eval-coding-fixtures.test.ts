/**
 * Coding eval fixture tests (task C11).
 *
 * The `coding-prompt` suite is the 10 SWE-style fixture set used to compare the pass
 * rate before and after the coding prompt. These tests keep the fixtures honest:
 * every case must be a real task whose hidden verifier fails on the untouched
 * baseline, so a green run actually means the agent fixed something.
 *
 * They run the fixture's own verifier against the buggy baseline in a temporary
 * directory. No model API is called.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { loadSuite } from "../../eval/suites.js";
import { runVerifiers } from "../../eval/verify.js";
import type { Config } from "../../config.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const cfg = {
  workspace: os.tmpdir(),
  policy: { networkEnabled: false },
} as unknown as Config;

async function baselineCheckpoints(suiteId: string, caseId: string) {
  const suite = loadSuite(path.join(ROOT, "evals", `${suiteId}.json`));
  const testCase = suite.cases.find((c) => c.id === caseId);
  assert.ok(testCase, `case ${caseId} is missing`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `coding-eval-${caseId}-`));
  try {
    for (const step of testCase.setup ?? []) {
      const full = path.join(dir, step.path);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, step.text, "utf8");
    }
    return await runVerifiers(testCase.verify, { workspace: dir, finalText: "", trace: [], cfg });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("coding eval suite", () => {
  it("has exactly 10 SWE-style fixture cases", () => {
    const suite = loadSuite(path.join(ROOT, "evals", "coding-prompt.json"));
    assert.equal(suite.cases.length, 10);
    for (const testCase of suite.cases) {
      assert.ok(testCase.prompt.trim().length > 0, `${testCase.id} has no prompt`);
      assert.ok((testCase.setup ?? []).length > 0, `${testCase.id} has no setup`);
      assert.ok((testCase.verify ?? []).length > 0, `${testCase.id} has no verifier`);
    }
  });

  it("has unique ids and distinct prompts", () => {
    const suite = loadSuite(path.join(ROOT, "evals", "coding-prompt.json"));
    const ids = suite.cases.map((c) => c.id);
    const prompts = suite.cases.map((c) => c.prompt);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(new Set(prompts).size, prompts.length);
  });

  it("fails its hidden verifier on the untouched baseline", async () => {
    const suite = loadSuite(path.join(ROOT, "evals", "coding-prompt.json"));
    for (const testCase of suite.cases) {
      const checkpoints = await baselineCheckpoints("coding-prompt", testCase.id);
      assert.ok(
        checkpoints.some((c) => !c.ok),
        `${testCase.id}: baseline already passes, so the fixture does not test the fix`,
      );
    }
  });
});
