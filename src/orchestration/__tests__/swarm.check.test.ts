/** S6 static guarantees: one Core (AC-S6.2), MiroFish untouched (AC-S6.1). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { checkOrchestration, checkMirofishUntouched, MIROFISH_PATHS } from "../../scripts/check-orchestration.js";
import { sh, tmpDir } from "./swarmHelpers.js";

function fakeTree(files: Record<string, string>): string {
  const root = tmpDir("c11-check-");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "x", devDependencies: { typescript: "5" } }));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

test("AC-S6.2 one-Core rule: the swarm reaches the Core only through public.ts/core.ts", () => {
  const ok = fakeTree({
    "src/orchestration/swarm/a.ts": `import { judgeProgress } from "../public.js";\nimport type { Span } from "../tracing/tracer.js";\nimport { Config } from "../../config.js";\n`,
  });
  assert.deepEqual(checkOrchestration(ok), []);
  const bad = fakeTree({
    "src/orchestration/swarm/a.ts": `import {\n  applyLedger,\n} from "../ledger/progressLedger.js";\nconst DDL = "CREATE TABLE IF NOT EXISTS run_checkpoints (x)";\n`,
    "src/orchestration/other.ts": `import { mirofishTools } from "../tools/mirofish.js";\n`,
  });
  const f = checkOrchestration(bad);
  assert.ok(f.some((x) => /one-Core rule: .*a\.ts imports \.\.\/ledger\/progressLedger\.js/.test(x)), f.join("\n"));
  assert.ok(f.some((x) => /declares a Core table/.test(x)));
  assert.ok(f.some((x) => /MiroFish non-interference: .*other\.ts/.test(x)));
});

test("AC-S6.1 MiroFish untouched: git diff against the base ref is empty, and any edit is reported", async () => {
  const repo = tmpDir("c11-mf-");
  await sh(repo, "git init -q -b main");
  fs.mkdirSync(path.join(repo, "src/tools/mirofish"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src/tools/mirofish.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(repo, "src/tools/mirofish/report.ts"), "export const r = 1;\n");
  fs.writeFileSync(path.join(repo, "other.ts"), "x\n");
  await sh(repo, "git add -A && git commit -q -m base && git tag base");
  fs.writeFileSync(path.join(repo, "other.ts"), "changed\n");
  assert.deepEqual(checkMirofishUntouched(repo, "base"), [], "edits outside MiroFish are fine");
  fs.writeFileSync(path.join(repo, "src/tools/mirofish/report.ts"), "export const r = 2;\n");
  fs.writeFileSync(path.join(repo, "src/tools/mirofish/new.ts"), "x\n");
  assert.deepEqual(checkMirofishUntouched(repo, "base"), ["MiroFish changed: src/tools/mirofish/report.ts", "MiroFish changed: src/tools/mirofish/new.ts"]);
  assert.ok(MIROFISH_PATHS.includes("src/tools/mirofish/"));
});
