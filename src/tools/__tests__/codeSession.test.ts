/**
 * Tests for code_session (opencode in an isolated git worktree).
 *
 * Guarantees under test:
 *  - a worktree + branch are created inside the task workspace repo
 *  - the fake opencode bin runs in the worktree and its commit is collectable
 *  - status transitions running -> done and reports exit code / log tail
 *  - collect returns the commit and diff for base..branch
 *  - the concurrency limit rejects extra sessions
 *  - malformed ids and missing required fields are rejected (no path escapes)
 *  - log output that looks like API keys is redacted
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { createCodeSessionTools, redactSecrets, type CodeSessionSpawnOptions } from "../codeSession.js";
import type { Tool, ToolContext } from "../registry.js";

let gitAvailable = false;
try {
  execFileSync("git", ["--version"], { windowsHide: true, timeout: 5000 });
  gitAvailable = true;
} catch {
  gitAvailable = false;
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-cs-repo-"));
  const run = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { windowsHide: true, encoding: "utf8" });
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "test@example.invalid"]);
  run(["config", "user.name", "Loam Test"]);
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  run(["add", "README.md"]);
  run(["commit", "-q", "-m", "init"]);
  return dir;
}

function ctxFor(workspace: string): ToolContext {
  return { cfg: {} as never, workspace, emit: () => {} };
}

const FAKE_OPENCODE = `const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
fs.writeFileSync("session-output.txt", "done\\n");
execFileSync("git", ["add", "-A"], { stdio: "inherit" });
execFileSync("git", ["commit", "-q", "-m", "code session work"], { stdio: "inherit" });
`;

const SLOW_OPENCODE = `setTimeout(() => process.exit(0), 1200);`;

describe("code_session", { skip: !gitAvailable }, () => {
  let repo = "";
  let dataDir = "";
  let fakeBin = "";
  let tools: Tool[];

  before(() => {
    repo = makeRepo();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-cs-data-"));
    fakeBin = path.join(dataDir, "fake-opencode.cjs");
    fs.writeFileSync(fakeBin, FAKE_OPENCODE);
    tools = createCodeSessionTools({
      opencodeBin: "opencode",
      dataDir,
      maxConcurrent: 4,
      spawnImpl: (_file, args, opts: CodeSessionSpawnOptions) =>
        spawn(process.execPath, [fakeBin, ...args], opts),
    });
  });

  after(() => {
    for (const dir of [dataDir, repo]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  const tool = (name: string): Tool => {
    const found = tools.find((t) => t.name === name);
    assert.ok(found, `missing tool ${name}`);
    return found;
  };

  async function waitForStatus(id: string, timeoutMs = 10_000): Promise<any> {
    const status = tool("code_session_status");
    const deadline = Date.now() + timeoutMs;
    let last: any = null;
    while (Date.now() < deadline) {
      const res = await status.run({ id }, ctxFor(repo));
      assert.equal(res.ok, true, res.content);
      last = JSON.parse(res.content);
      if (last.status !== "running") return last;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return last;
  }

  it("creates a worktree + branch and keeps the base branch untouched", async () => {
    const res = await tool("code_session").run(
      { task: "add a file", acceptance: "session-output.txt exists", files_hint: ["session-output.txt"] },
      ctxFor(repo),
    );
    assert.equal(res.ok, true, res.content);
    const parsed = JSON.parse(res.content);
    assert.match(parsed.id, /^[a-z0-9][a-z0-9_-]{0,63}$/);
    assert.match(parsed.branch, /^loam\/cs-/);
    assert.ok(fs.existsSync(parsed.worktree), "worktree exists");
    assert.ok(parsed.worktree.startsWith(path.join(repo, ".loam", "code-sessions")));

    const head = execFileSync("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(head, "main");
    const worktreeHead = execFileSync("git", ["-C", parsed.worktree, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
    }).trim();
    assert.equal(worktreeHead, parsed.branch);

    const final = await waitForStatus(parsed.id);
    assert.equal(final.status, "done", JSON.stringify(final));
  });

  it("runs the child, transitions to done and collects the commit and diff", async () => {
    const start = await tool("code_session").run(
      { task: "add session-output.txt", acceptance: "the file is committed", name: "collect me" },
      ctxFor(repo),
    );
    assert.equal(start.ok, true, start.content);
    const { id } = JSON.parse(start.content);

    const final = await waitForStatus(id);
    assert.equal(final.status, "done", JSON.stringify(final));
    assert.equal(final.exitCode, 0);
    assert.ok(Array.isArray(final.log));

    const collected = await tool("code_session_collect").run({ id }, ctxFor(repo));
    assert.equal(collected.ok, true, collected.content);
    const result = JSON.parse(collected.content);
    assert.match(result.commits, /code session work/);
    assert.match(result.diffStat, /session-output\.txt/);
    assert.match(result.diff, /session-output\.txt/);
    assert.ok(result.diff.length <= 20_000 + 200, "diff is truncated");
  });

  it("rejects beyond the configured concurrency limit", async () => {
    const limited = createCodeSessionTools({
      opencodeBin: "opencode",
      dataDir,
      maxConcurrent: 1,
      spawnImpl: (_file, _args, opts) =>
        spawn(process.execPath, ["-e", SLOW_OPENCODE], opts),
    });
    const start = limited.find((t) => t.name === "code_session")!;
    const first = await start.run({ task: "slow one", acceptance: "finishes" }, ctxFor(repo));
    assert.equal(first.ok, true, first.content);
    const firstId = JSON.parse(first.content).id;

    const second = await start.run({ task: "slow two", acceptance: "never starts" }, ctxFor(repo));
    assert.equal(second.ok, false);
    assert.match(second.content, /max concurrent/i);

    const status = limited.find((t) => t.name === "code_session_status")!;
    let last: any = null;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const res = await status.run({ id: firstId }, ctxFor(repo));
      last = JSON.parse(res.content);
      if (last.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(last.status, "done", JSON.stringify(last));
  });

  it("rejects invalid ids and path traversal attempts", async () => {
    const status = tool("code_session_status");
    const collect = tool("code_session_collect");
    for (const bad of ["../evil", "a/b", "bad id", ".hidden", "x".repeat(80)]) {
      const res = await status.run({ id: bad }, ctxFor(repo));
      assert.equal(res.ok, false, `id ${bad} should be rejected`);
      assert.match(res.content, /invalid code session id/);
    }
    const traversal = await collect.run({ id: "../../etc/passwd" }, ctxFor(repo));
    assert.equal(traversal.ok, false);
    assert.match(traversal.content, /invalid code session id/);
  });

  it("requires task and acceptance and rejects a non-git workspace", async () => {
    const start = tool("code_session");
    assert.equal((await start.run({ acceptance: "x" }, ctxFor(repo))).ok, false);
    assert.equal((await start.run({ task: "x" }, ctxFor(repo))).ok, false);

    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "loam-cs-plain-"));
    const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(plain);
    try {
      const res = await start.run({ task: "x", acceptance: "y" }, ctxFor(plain));
      assert.equal(res.ok, false);
      assert.match(res.content, /git repository/i);
    } finally {
      if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it("sanitizes a hostile name so the worktree stays inside the repo", async () => {
    const res = await tool("code_session").run(
      { task: "x", acceptance: "y", name: "../../evil;rm -rf" },
      ctxFor(repo),
    );
    assert.equal(res.ok, true, res.content);
    const parsed = JSON.parse(res.content);
    assert.doesNotMatch(parsed.id, /[\\/;]/);
    assert.ok(parsed.worktree.startsWith(path.join(repo, ".loam", "code-sessions")));
    const final = await waitForStatus(parsed.id);
    assert.equal(final.status, "done", JSON.stringify(final));
  });

  it("redacts API-key-shaped material from log output", () => {
    const raw = [
      "using key sk-abcdefghijklmnop1234",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnop.qrstuvwxyz",
      `token ${"A".repeat(64)}`,
      "plain line stays",
    ].join("\n");
    const redacted = redactSecrets(raw);
    assert.doesNotMatch(redacted, /sk-abcdefghijklmnop/);
    assert.doesNotMatch(redacted, /eyJhbGciOiJIUzI1NiJ9/);
    assert.doesNotMatch(redacted, new RegExp("A".repeat(40)));
    assert.match(redacted, /plain line stays/);
  });
});
