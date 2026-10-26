import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { draftGuardProposal, createFuzzTools } from "../../tools/fuzzTools.js";

const tmp = (n: string): string => fs.mkdtempSync(path.join(os.tmpdir(), n));

test("guard proposal is a labeled draft, never an applied patch", () => {
  const p = draftGuardProposal("jazzer:crash-abc", "src/parse.ts", 4, "  const out = JSON.parse(input);");
  assert.ok(p.candidateDiff.startsWith("--- a/src/parse.ts"));
  assert.ok(p.candidateDiff.includes("loam:fuzz-guard (proposal)"));
  assert.equal(p.regressionPass, false, "unvalidated until a regression re-run");
  assert.ok(p.note.toLowerCase().includes("operator"));
});

test("fuzz tools degrade honestly without a sandbox and refuse missing files", async () => {
  const d = tmp("loam-fz-");
  try {
    fs.writeFileSync(path.join(d, "a.fuzz.ts"), "export function fuzz(data: Buffer) { JSON.parse(data.toString()); }\n");
    const tools = createFuzzTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    const ctx = { workspace: d } as never;
    const run = await byName.get("fuzz_run")!.run({}, ctx);
    assert.ok(run.ok);
    assert.match(run.content, /jazzer=(ok|skipped|unavailable)/, "engine status is reported, never hidden");
    const missing = await byName.get("aixcc_patch_propose")!.run({ finding_rule: "r", file: "nope.ts", line: 1 }, ctx);
    assert.ok(!missing.ok);
    fs.writeFileSync(path.join(d, "site.ts"), "line1\nline2\n");
    const prop = await byName.get("aixcc_patch_propose")!.run({ finding_rule: "r", file: "site.ts", line: 2, target: "." }, ctx);
    assert.ok(prop.ok && prop.content.includes("PROPOSAL ONLY"));
  } finally { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
