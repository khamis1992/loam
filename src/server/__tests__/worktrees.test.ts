import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { describe, it, before } from "node:test";
import { readGitBranch, createWorktree, safeWorktreeName } from "../worktrees.js";

let gitAvailable = false;
try {
  execFileSync("git", ["--version"], { windowsHide: true, timeout: 5000 });
  gitAvailable = true;
} catch {
  gitAvailable = false;
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-wt-"));
  const run = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { windowsHide: true, encoding: "utf8" });
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "test@example.invalid"]);
  run(["config", "user.name", "Loam Test"]);
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  run(["add", "README.md"]);
  run(["commit", "-q", "-m", "init"]);
  return dir;
}

describe("project worktrees (option 17)", { skip: !gitAvailable }, () => {
  let repo = "";
  before(() => {
    repo = makeRepo();
  });

  it("reads the real branch of a git folder", async () => {
    const info = await readGitBranch(repo);
    assert.equal(info.isGit, true);
    assert.equal(info.branch, "main");
  });

  it("reports non-git folders without throwing", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "loam-wt-plain-"));
    // `git -C <dir> rev-parse` walks up to the nearest enclosing repository, so a
    // temp dir that happens to live under one (on this machine the OS temp root is
    // inside a repository) would be reported as git and make this assertion
    // machine-dependent. Ceiling the upward search at the temp root keeps the test
    // hermetic and about the folder itself, matching the codeSession test convention.
    const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(plain);
    try {
      const info = await readGitBranch(plain);
      assert.equal(info.isGit, false);
      assert.equal(info.branch, null);
    } finally {
      if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
    }
  });

  it("creates a worktree under the project dir and binds a new branch", async () => {
    const result = await createWorktree(repo, "task 42!");
    assert.ok(!("error" in result), `worktree creation failed: ${JSON.stringify(result)}`);
    if ("error" in result) return;
    assert.ok(result.path.startsWith(path.join(repo, ".loam-worktrees")));
    assert.match(result.branch, /^loam\/task-42$/);
    assert.ok(fs.existsSync(path.join(result.path, "README.md")));
    const branchInWt = await readGitBranch(result.path);
    assert.equal(branchInWt.branch, result.branch);
  });

  it("sanitizes worktree names", () => {
    assert.equal(safeWorktreeName("../../evil;rm"), "evil-rm");
    assert.match(safeWorktreeName(""), /^run-/);
  });
});
