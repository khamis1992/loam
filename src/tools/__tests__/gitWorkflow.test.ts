/**
 * D1 Git/PR workflow tools — end-to-end + provider unit tests.
 *
 * No network is used: the e2e flow runs against a local bare git remote with the
 * LocalPrProvider, and the GitHub provider is exercised with a mocked fetch.
 *
 * Covered:
 *  - git_branch creates/switches, refuses protected branches, and pushes only
 *    with the explicit approvePush flag through the approval gate (no force-push)
 *  - git_commit stages paths and refuses commits on protected branches
 *  - git_status_diff reports status and diff
 *  - pr_create / pr_view / pr_comments against the local provider
 *  - pr_comment_checklist marks comments done/outdated and persists per PR
 *  - GitHubPrProvider hits the right REST endpoints with the bearer token
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, before, after } from "node:test";

import type { Tool, ToolContext } from "../registry.js";
import { createGitWorkflowTools } from "../gitWorkflowTools.js";
import { GitHubPrProvider, LocalPrProvider } from "../gitPrProvider.js";
import * as approvalsMod from "../../server/approvals.js";

interface GitWorkflowApi {
  createGitWorkflowTools: (options?: { provider?: unknown }) => Tool[];
}
interface ProviderApi {
  GitHubPrProvider: new (options?: { token?: () => Promise<string>; fetchImpl?: typeof fetch }) => {
    id: string;
    createPr(input: { repo: string; title: string; head: string; base: string; body?: string }): Promise<unknown>;
    viewPr(repo: string, number: number): Promise<unknown>;
    listReviewComments(repo: string, number: number): Promise<unknown[]>;
    addComment(repo: string, number: number, body: string, opts?: { path?: string; line?: number }): Promise<unknown>;
  };
  LocalPrProvider: new (dir: string) => unknown;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function jsonRes(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
    async text() { return JSON.stringify(payload); },
  } as unknown as Response;
}

describe("git/PR workflow tools (local bare remote + LocalProvider)", () => {
  let tmp = "";
  let work = "";
  let bare = "";
  let tools: Tool[];
  let providerDir = "";

  function ctx(): ToolContext {
    return { cfg: {} as never, workspace: work, emit: () => {}, taskId: "task_gitwf" };
  }

  const tool = (name: string): Tool => tools.find((t) => t.name === name)!;

  /** Run a tool that may block on the approval gate and approve it. */
  async function runApproved(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
    const pending = tool(name).run(args, ctx());
    for (let i = 0; i < 100; i++) {
      const approval = approvalsMod.listApprovals(true).find((a) => a.tool === name);
      if (approval) {
        approvalsMod.decideApproval(approval.id, "approve");
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    return pending;
  }

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-gitwf-"));
    bare = path.join(tmp, "remote.git");
    work = path.join(tmp, "work");
    execFileSync("git", ["init", "--bare", bare], { stdio: "ignore" });
    execFileSync("git", ["init", work], { stdio: "ignore" });
    fs.writeFileSync(path.join(work, "README.md"), "# demo\n");
    git(work, ["add", "--", "README.md"]);
    git(work, ["-c", "user.name=T", "-c", "user.email=t@t.local", "commit", "-m", "init"]);
    git(work, ["branch", "-M", "main"]);
    git(work, ["remote", "add", "origin", bare]);
    git(work, ["push", "-u", "origin", "main"]);

    providerDir = path.join(work, ".loam", "prs");
    const api = { createGitWorkflowTools } as unknown as GitWorkflowApi;
    const provider = new LocalPrProvider(providerDir) as unknown;
    tools = api.createGitWorkflowTools({ provider });
  });

  after(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("creates a branch, refuses protected branch creation, and commits", async () => {
    const created = await tool("git_branch").run({ name: "feature/x", create: true }, ctx());
    assert.equal(created.ok, true, created.content);
    assert.equal(git(work, ["rev-parse", "--abbrev-ref", "HEAD"]), "feature/x");

    const protectedCreate = await tool("git_branch").run({ name: "main", create: true }, ctx());
    assert.equal(protectedCreate.ok, false);
    assert.match(protectedCreate.content, /protected branch/);

    fs.writeFileSync(path.join(work, "file.txt"), "hello\n");
    const committed = await tool("git_commit").run({ paths: ["file.txt"], message: "add file" }, ctx());
    assert.equal(committed.ok, true, committed.content);
    assert.match(committed.content, /committed on "feature\/x"/);

    const diff = await tool("git_status_diff").run({}, ctx());
    assert.equal(diff.ok, true, diff.content);
    assert.match(diff.content, /clean tree/);
  });

  it("pushes only with the explicit approval flag; never force-pushes", async () => {
    const refused = await tool("git_branch").run({ name: "feature/x", create: false, push: true }, ctx());
    assert.equal(refused.ok, false);
    assert.match(refused.content, /approvePush/);

    const pushed = await runApproved("git_branch", { name: "feature/x", create: false, push: true, approvePush: true });
    assert.equal(pushed.ok, true, pushed.content);
    const remoteRef = execFileSync("git", ["--git-dir", bare, "rev-parse", "--verify", "feature/x"], { encoding: "utf8" }).trim();
    const localRef = git(work, ["rev-parse", "feature/x"]);
    assert.equal(remoteRef, localRef, "branch reached the local bare remote");
  });

  it("refuses to commit on a protected branch", async () => {
    git(work, ["checkout", "main"]);
    fs.writeFileSync(path.join(work, "file2.txt"), "nope\n");
    const refused = await tool("git_commit").run({ paths: ["file2.txt"], message: "should not land" }, ctx());
    assert.equal(refused.ok, false);
    assert.match(refused.content, /protected branch/);
    git(work, ["checkout", "feature/x"]);
  });

  it("creates a PR, lists comments, and persists the per-PR checklist", async () => {
    const pr = await tool("pr_create").run({ repo: "owner/repo", title: "Add feature", body: "details" }, ctx());
    assert.equal(pr.ok, true, pr.content);
    assert.match(pr.content, /#1/);
    assert.match(pr.content, /feature\/x -> main/);

    const viewed = await tool("pr_view").run({ repo: "owner/repo", number: 1 }, ctx());
    assert.equal(viewed.ok, true, viewed.content);
    assert.match(viewed.content, /Add feature/);

    const empty = await tool("pr_comments").run({ repo: "owner/repo", number: 1 }, ctx());
    assert.equal(empty.ok, true, empty.content);
    assert.match(empty.content, /no review comments/);

    const first = await tool("pr_comments").run({ repo: "owner/repo", number: 1, body: "first comment" }, ctx());
    assert.equal(first.ok, true, first.content);
    const second = await tool("pr_comments").run({ repo: "owner/repo", number: 1, body: "second comment", path: "file.txt", line: 1 }, ctx());
    assert.equal(second.ok, true, second.content);
    assert.match(second.content, /first comment/);
    assert.match(second.content, /second comment/);

    const listed = await tool("pr_comments").run({ repo: "owner/repo", number: 1 }, ctx());
    const ids = [...listed.content.matchAll(/^- (c_[A-Za-z0-9_]+) /gm)].map((m) => m[1]!);
    assert.equal(ids.length, 2, "two review comments listed");

    const done = await tool("pr_comment_checklist").run({ repo: "owner/repo", number: 1, commentId: ids[0]!, status: "done" }, ctx());
    assert.equal(done.ok, true, done.content);
    const outdated = await tool("pr_comment_checklist").run({ repo: "owner/repo", number: 1, commentId: ids[1]!, status: "outdated" }, ctx());
    assert.equal(outdated.ok, true, outdated.content);

    const invalid = await tool("pr_comment_checklist").run({ repo: "owner/repo", number: 1, commentId: ids[0]!, status: "bogus" }, ctx());
    assert.equal(invalid.ok, false);

    const checklistFile = path.join(work, ".loam", "prs", "checklists", "owner_repo-1.json");
    assert.ok(fs.existsSync(checklistFile), "checklist persisted to session state");
    const persisted = JSON.parse(fs.readFileSync(checklistFile, "utf8")) as Record<string, string>;
    assert.equal(persisted[ids[0]!], "done");
    assert.equal(persisted[ids[1]!], "outdated");
  });
});

describe("GitHubPrProvider (mocked fetch)", () => {
  const calls: Array<{ url: string; method: string; auth: string; body: string }> = [];

  function installFetch(): void {
    const mock = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url,
        method: String(init?.method ?? "GET"),
        auth: String(headers.authorization ?? ""),
        body: typeof init?.body === "string" ? init.body : "",
      });
      if (url === "https://api.github.com/repos/o/r/pulls" && String(init?.method ?? "GET") === "POST") {
        return jsonRes(201, { number: 5, title: "T", state: "open", html_url: "https://github.com/o/r/pull/5", head: { ref: "feature" }, base: { ref: "main" } });
      }
      if (url === "https://api.github.com/repos/o/r/pulls/5") return jsonRes(200, { number: 5, title: "T", state: "open", html_url: "https://github.com/o/r/pull/5", head: { ref: "feature" }, base: { ref: "main" } });
      if (url === "https://api.github.com/repos/o/r/pulls/5/comments" && String(init?.method ?? "GET") === "POST") {
        return jsonRes(201, { id: 9, user: { login: "rev" }, body: "nice", path: "a.ts", line: 3, created_at: "2026-01-01T00:00:00Z" });
      }
      if (url === "https://api.github.com/repos/o/r/pulls/5/comments") {
        return jsonRes(200, [{ id: 9, user: { login: "rev" }, body: "nice", path: "a.ts", line: 3, created_at: "2026-01-01T00:00:00Z" }]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    const api = { GitHubPrProvider } as unknown as ProviderApi;
    provider = new api.GitHubPrProvider({ token: async () => "gh-token", fetchImpl: mock });
  }

  let provider: InstanceType<ProviderApi["GitHubPrProvider"]>;

  it("creates, views, lists and adds review comments with the bearer token", async () => {
    installFetch();

    const created = await provider.createPr({ repo: "o/r", title: "T", head: "feature", base: "main", body: "b" });
    assert.equal((created as { number: number }).number, 5);
    const createCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/pulls"))!;
    assert.equal(createCall.auth, "Bearer gh-token");
    const payload = JSON.parse(createCall.body) as { head: string; base: string };
    assert.equal(payload.head, "feature");
    assert.equal(payload.base, "main");

    const viewed = await provider.viewPr("o/r", 5);
    assert.equal((viewed as { state: string }).state, "open");

    const comments = await provider.listReviewComments("o/r", 5);
    assert.equal(comments.length, 1);
    assert.equal((comments[0] as { id: string }).id, "9");

    const added = await provider.addComment("o/r", 5, "nice", { path: "a.ts", line: 3 });
    assert.equal((added as { path: string }).path, "a.ts");
    const addCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/comments"))!;
    assert.equal(addCall.auth, "Bearer gh-token");
    assert.equal(JSON.parse(addCall.body).line, 3);
  });
});
