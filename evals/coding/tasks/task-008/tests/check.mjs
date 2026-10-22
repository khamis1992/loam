// The agent's tests must pass on the real source and fail on a mutated copy.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const cwd = process.cwd();
if (!fs.existsSync(path.join(cwd, "test", "math.test.mjs"))) {
  console.error("missing test/math.test.mjs");
  process.exit(1);
}

const run = (dir) => spawnSync(process.execPath, ["test/math.test.mjs"], { cwd: dir, encoding: "utf8" });

const good = run(cwd);
if (good.status !== 0) {
  console.error(`agent tests failed on correct source:\n${good.stdout}${good.stderr}`);
  process.exit(1);
}

const mutant = fs.mkdtempSync(path.join(os.tmpdir(), "task008-"));
fs.cpSync(cwd, mutant, { recursive: true });
const target = path.join(mutant, "src", "math.js");
const original = fs.readFileSync(target, "utf8");
fs.writeFileSync(target, original.replace("return a * b;", "return a + b;"), "utf8");

const bad = run(mutant);
fs.rmSync(mutant, { recursive: true, force: true });
if (bad.status === 0) {
  console.error("agent tests still pass when multiply() is broken; they do not check it");
  process.exit(1);
}

console.log("task-008 ok");
