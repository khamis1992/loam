import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bashPath } from "../policy/bashPath.js";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-path-literals-"));
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
for (const input of ['normal file', '$(touch bot-injected)', '`touch bot-injected`', 'quote";touch bot-injected;#', '$HOME', "single'quote", "back\\slash", "line\nbreak", '-dangerous-option']) {
  const output = execFileSync(bash, ["--noprofile", "--norc", "-c", `printf '%s' ${bashPath(input)}`], { cwd: tmp, windowsHide: true, encoding: "utf8", timeout: 10_000 });
  assert.equal(output, input.startsWith("-") ? `./${input}` : input);
}
assert.ok(!fs.existsSync(path.join(tmp, "bot-injected")));
console.log("PASS actual bash preserves 9 literal paths without command/variable expansion");
