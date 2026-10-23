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
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  SharedCodeSessionServer as CodeSessionSharedServer,
  createCodeSessionTools,
  isSharedSocketPath,
  redactSecrets,
  type CodeSessionSpawnOptions,
  type SharedServerSpawnImpl,
} from "../codeSession.js";
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

describe("code_session shared launcher", { skip: !gitAvailable }, () => {
  it("isSharedSocketPath only accepts named pipes on Windows", () => {
    const pipe = "\\\\.\\pipe\\loam-cs-1";
    const file = "/tmp/loam-cs-1.sock";
    assert.equal(isSharedSocketPath(pipe), process.platform === "win32");
    // A filesystem socket is the correct form everywhere except Windows.
    assert.equal(isSharedSocketPath(file), process.platform !== "win32");
  });

  it("spawns one long-lived server that hosts every session", async () => {
    const repo = makeRepo();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-cs-shared-"));
    const entry = path.join(dataDir, "fake-shared-server.cjs");
    // A minimal stand-in for the real shared server: it answers the control
    // protocol so the tool's reuse/tracking path is exercised without a model.
    fs.writeFileSync(
      entry,
      `const net = require("node:net");
const fs = require("node:fs");
const [socketPath] = process.argv.slice(2);
try { fs.rmSync(socketPath, { force: true }); } catch {}
const server = net.createServer((sock) => {
  let buf = "";
  sock.on("data", (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const cmd = line.split(" ")[0];
      const reply = cmd === "create_session" ? { ok: true, session: "s" + Math.random().toString(36).slice(2, 10) }
        : cmd === "message" ? { ok: true, status: "done", session: "s", steps: 3 }
        : cmd === "sessions" ? { ok: true, sessions: [] }
        : { ok: false, error: "unknown command: " + cmd };
      sock.write(JSON.stringify(reply) + "\\n");
    }
  });
});
server.listen(socketPath, () => process.stdout.write("listening\\n"));
`,
    );
    const spawned: Array<{ file: string; args: string[] }> = [];
    // The tool owns the server it spawns and never stops it (in production it
    // lives for the app's lifetime), so this test must kill the child itself or
    // the test runner hangs on an open handle after every assertion has passed.
    const children: ChildProcess[] = [];
    const sharedSpawnImpl: SharedServerSpawnImpl = (file, args, options) => {
      spawned.push({ file, args });
      const child = spawn(process.execPath, [entry, ...args], options);
      children.push(child);
      return child;
    };
    const tools = createCodeSessionTools({
      opencodeBin: "opencode",
      dataDir,
      maxConcurrent: 4,
      launcher: "shared",
      sharedServerEntry: entry,
      sharedServerSpawnImpl: sharedSpawnImpl,
      sharedModelUrl: "http://127.0.0.1:11434",
    });
    const start = tools.find((t) => t.name === "code_session")!;
    const status = tools.find((t) => t.name === "code_session_status")!;
    try {
      const first = await start.run(
        { task: "shared one", acceptance: "done", launcher: "shared" },
        ctxFor(repo),
      );
      assert.equal(first.ok, true, first.content);
      const firstParsed = JSON.parse(first.content);
      assert.equal(firstParsed.launcher, "shared");
      assert.equal(spawned.length, 1, "the shared server is spawned once");
      assert.equal(spawned[0]!.file, entry);
      assert.equal(spawned[0]!.args[spawned[0]!.args.length - 1], "0", "pin flag defaults off");

      const second = await start.run(
        { task: "shared two", acceptance: "done", launcher: "shared" },
        ctxFor(repo),
      );
      assert.equal(second.ok, true, second.content);
      assert.equal(spawned.length, 1, "the second session reuses the same server");

      for (const id of [firstParsed.id, JSON.parse(second.content).id]) {
        let last: any = null;
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const res = await status.run({ id }, ctxFor(repo));
          last = JSON.parse(res.content);
          if (last.status !== "running") break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(last.status, "done", JSON.stringify(last));
        assert.equal(last.launcher, "shared");
        assert.ok(last.sharedId, "shared session id is reported");
      }
    } finally {
      for (const child of children) {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }
      for (const dir of [dataDir, repo]) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }
  });

  it("defaults to per-process when no launcher is requested", async () => {
    const repo = makeRepo();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-cs-default-"));
    const fakeBin = path.join(dataDir, "fake-opencode.cjs");
    fs.writeFileSync(fakeBin, FAKE_OPENCODE);
    const tools = createCodeSessionTools({
      opencodeBin: "opencode",
      dataDir,
      spawnImpl: (_file, args, opts) => spawn(process.execPath, [fakeBin, ...args], opts),
    });
    const start = tools.find((t) => t.name === "code_session")!;
    const status = tools.find((t) => t.name === "code_session_status")!;
    try {
      const res = await start.run({ task: "default shape", acceptance: "done" }, ctxFor(repo));
      assert.equal(res.ok, true, res.content);
      assert.equal(JSON.parse(res.content).launcher, "per-process");
      // Wait for the child to exit before the cleanup below removes `dataDir`.
      // The tool keeps writing the session log until then, so deleting it first
      // makes the child's write fail after this test has already ended.
      const id = JSON.parse(res.content).id as string;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const last = JSON.parse((await status.run({ id }, ctxFor(repo))).content) as { status: string };
        if (last.status !== "running") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      for (const dir of [dataDir, repo]) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }
  });
});
