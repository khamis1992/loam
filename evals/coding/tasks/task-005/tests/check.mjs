// Hidden grader: the agent's tests must pass on the real source AND fail on a
// mutated copy, otherwise they assert nothing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const cwd = process.cwd();
const testFile = path.join(cwd, "test", "strings.test.mjs");
if (!fs.existsSync(testFile)) {
  console.error("missing test/strings.test.mjs");
  process.exit(1);
}

const run = (dir) => spawnSync(process.execPath, ["test/strings.test.mjs"], { cwd: dir, encoding: "utf8" });

const good = run(cwd);
if (good.status !== 0) {
  console.error(`agent tests failed on correct source:\n${good.stdout}${good.stderr}`);
  process.exit(1);
}

const mutant = fs.mkdtempSync(path.join(os.tmpdir(), "task005-"));
fs.cpSync(cwd, mutant, { recursive: true });
const target = path.join(mutant, "src", "strings.ts");
const original = fs.readFileSync(target, "utf8");
fs.writeFileSync(target, original.replace("input.length <= max ?", "true ?"), "utf8");

const bad = run(mutant);
fs.rmSync(mutant, { recursive: true, force: true });
if (bad.status === 0) {
  console.error("agent tests still pass on a broken truncate(); they do not check the behaviour");
  process.exit(1);
}

console.log("task-005 ok");
