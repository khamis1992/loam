/**
 * D5 verify_and_record tool — end-to-end against a local git repo, the
 * LocalPrProvider and a real Playwright run.
 *
 * No network is used: the provider is the scripted `LocalPrProvider` stored on
 * disk, the diff comes from a real local git repo, and Playwright only reaches
 * the loopback static server.
 *
 * Covered:
 *  - the tool derives a plan from `git diff <base>...HEAD` and runs it
 *  - the Verification checklist lands on the pull request body
 *  - re-running replaces the section (one `## Verification`, not two)
 *  - `noPost` runs the plan without touching the PR body
 *  - a missing PR number or app root is refused before anything runs
 *  - a GitHub-side body write is exercised with a mocked fetch
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, before, after } from "node:test";

import type { Tool, ToolContext } from "../registry.js";
import { createVerifyAndRecordTool, prDiff } from "../verifyAndRecordTools.js";
import { GitHubPrProvider, LocalPrProvider } from "../gitPrProvider.js";
import { VERIFICATION_MARKER } from "../../agent/prVerification.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function jsonRes(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  } as unknown as Response;
}

/** Commit a small static app on `main`, then add a PR branch with a change. */
function seedRepo(work: string): void {
  fs.mkdirSync(path.join(work, "app"), { recursive: true });
  // Seed the base branch explicitly so the tool's default `main` diff base works.
  git(work, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(work, "app", "index.html"), '<!doctype html>\n<html><body><h1 id="greeting">Hello Loam</h1></body></html>\n', "utf8");
  git(work, ["add", "--", "app/index.html"]);
  git(work, ["-c", "user.name=T", "-c", "user.email=t@t.local", "commit", "-m", "init"]);
  git(work, ["checkout", "-b", "feature/d5"]);
  fs.writeFileSync(
    path.join(work, "app", "index.html"),
    '<!doctype html>\n<html><body><h1 id="greeting">Hello Loam</h1><input id="name" placeholder="Your name"><button id="ping">Ping</button></body></html>\n',
    "utf8",
  );
  git(work, ["add", "--", "app/index.html"]);
  git(work, ["-c", "user.name=T", "-c", "user.email=t@t.local", "commit", "-m", "add form"]);
}

describe("verify_and_record tool", () => {
  let tmp = "";
  let work = "";
  let providerDir = "";
  let tool: Tool;
  let prNumber = 1;

  function ctx(): ToolContext {
    return { cfg: { browser: { channel: "chromium", headless: true, viewport: { width: 1280, height: 800 } } } as never, workspace: work, emit: () => {}, taskId: "task_d5" };
  }

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-d5-tool-"));
    work = path.join(tmp, "ws");
    providerDir = path.join(tmp, "prs");
    fs.mkdirSync(work, { recursive: true });
    seedRepo(work);
    // A second page with no #greeting, so a text expectation can fail.
    fs.writeFileSync(path.join(work, "app", "broken.html"), '<!doctype html>\n<html><body><p>nothing</p></body></html>\n', "utf8");
    const provider = new LocalPrProvider(providerDir);
    const pr = await provider.createPr({ repo: "local/demo", title: "D5 demo", head: "feature/d5", base: "main", body: "## Notes\n\nOriginal body." });
    prNumber = pr.number;
    tool = createVerifyAndRecordTool({ provider });
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("is named verify_and_record and requires repo, number and root", async () => {
    assert.equal(tool.name, "verify_and_record");
    assert.deepEqual(tool.parameters.required, ["repo", "number", "root"]);

    const missing = await tool.run({ repo: "local/demo", number: 0, root: "app" }, ctx());
    assert.equal(missing.ok, false);
    assert.match(missing.content, /pull request number/);

    const noRoot = await tool.run({ repo: "local/demo", number: prNumber, root: "" }, ctx());
    assert.equal(noRoot.ok, false);
    assert.match(noRoot.content, /local app root/);
  });

  it("derives a plan from the diff, runs it and posts the checklist", async () => {
    const provider = new LocalPrProvider(providerDir);
    const result = await tool.run({ repo: "local/demo", number: prNumber, root: "app", base: "main", channel: "chromium", timeoutMs: 15_000 }, ctx());
    assert.equal(result.ok, true, result.content);
    assert.match(result.content, /## Verification/);
    assert.match(result.content, /Videos: [1-9]/);
    assert.match(result.content, /Screenshots: [1-9]/);

    const stored = await provider.viewPr("local/demo", prNumber);
    const body = stored.body ?? "";
    assert.ok(body.includes(VERIFICATION_MARKER), "the marker is stored on the PR body");
    assert.equal(body.split("## Verification").length - 1, 1);
    assert.ok(body.includes("Original body."), "the original body is preserved");
  });

  it("replaces the section instead of duplicating it", async () => {
    const provider = new LocalPrProvider(providerDir);
    const result = await tool.run({ repo: "local/demo", number: prNumber, root: "app", base: "main", channel: "chromium", timeoutMs: 15_000 }, ctx());
    assert.equal(result.ok, true, result.content);
    const body = (await provider.viewPr("local/demo", prNumber)).body ?? "";
    assert.equal(body.split("## Verification").length - 1, 1, "the update is idempotent");
    assert.equal(body.split(VERIFICATION_MARKER).length - 1, 1);
  });

  it("reports a failing flow without claiming success", async () => {
    const result = await tool.run(
      {
        repo: "local/demo",
        number: prNumber,
        root: "app",
        entry: "broken.html",
        channel: "chromium",
        timeoutMs: 1500,
        flows: [{ name: "Broken greeting", file: "broken.html", steps: [{ action: "expect-text", selector: "#greeting", value: "Hello Loam" }] }],
      },
      ctx(),
    );
    assert.equal(result.ok, false);
    assert.match(result.content, /Verification failed/);
    assert.match(result.content, /broken/);
  });

  it("honours noPost: runs the plan without touching the PR body", async () => {
    const provider = new LocalPrProvider(providerDir);
    const before = (await provider.viewPr("local/demo", prNumber)).body ?? "";
    const result = await tool.run({ repo: "local/demo", number: prNumber, root: "app", base: "main", channel: "chromium", timeoutMs: 15_000, noPost: true }, ctx());
    assert.equal(result.ok, true, result.content);
    const after = (await provider.viewPr("local/demo", prNumber)).body ?? "";
    assert.equal(after, before, "noPost must not write the PR body");
  });

  it("reads the PR diff from a local repository", async () => {
    const diff = await prDiff(work, "main");
    assert.match(diff, /app\/index\.html/);
    assert.match(diff, /button id="ping"/);
    await assert.rejects(() => prDiff(work, "--upload-pack=x"), /invalid diff base/);
  });

  it("writes the body through the GitHub provider's REST endpoint (mocked fetch)", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(url)}`);
      if (String(url).includes("/pulls/7")) return jsonRes(200, { number: 7, title: "D5", state: "open", url: "u", head: "feature/d5", base: "main", body: "## Notes" });
      return jsonRes(404, { message: "not found" });
    }) as unknown as typeof fetch;
    const provider = new GitHubPrProvider({ token: async () => "tok", fetchImpl });
    const gh = createVerifyAndRecordTool({ provider });
    const res = await gh.run({ repo: "o/r", number: 7, root: "app", entry: "broken.html", channel: "chromium", timeoutMs: 1500, flows: [{ name: "Broken greeting", file: "broken.html", steps: [{ action: "expect-text", selector: "#greeting", value: "Hello Loam" }] }] }, ctx());
    assert.equal(res.ok, false);
    assert.ok(calls.some((c) => c === "PATCH https://api.github.com/repos/o/r/pulls/7"), `expected a PATCH, got ${calls.join(", ")}`);
  });
});
