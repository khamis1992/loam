import assert from "node:assert";
import path from "node:path";
import { describe, it } from "node:test";
import { isManagedTaskWorkspace, TASKS_DIR } from "../taskWorkspace.js";

describe("isManagedTaskWorkspace", () => {
  it("accepts only Loam's own .loam-tasks/<taskId> workspaces", () => {
    const base = path.join(path.sep === "\\" ? "C:\\ws" : "/ws");
    assert.equal(isManagedTaskWorkspace(path.join(base, TASKS_DIR, "task_abc")), true);
  });

  it("rejects a user folder or git worktree bound to a task", () => {
    const base = path.join(path.sep === "\\" ? "C:\\ws" : "/ws");
    assert.equal(isManagedTaskWorkspace(path.join(base, "my-real-project")), false, "a plain user folder is not ours");
    assert.equal(isManagedTaskWorkspace(path.join(base, "worktrees", "task_abc")), false, "a git worktree is not ours");
    assert.equal(isManagedTaskWorkspace(base), false, "the workspace root itself is not a task workspace");
  });
});
