/**
 * D15 PR reviewer — unit tests with a mocked model and scripted diffs.
 *
 * No network is used: the diff comes from a `LocalPrProvider` seeded with
 * `setPrDiff`, and the model is a fake client that returns canned JSON. The
 * GitHub provider's diff path is exercised with a mocked fetch.
 *
 * Covered:
 *  - a seeded off-by-one bug is reported as a `bug` finding at the right file
 *    and the right new-file line
 *  - duplicate findings are merged, and the most severe one wins
 *  - `postComments` files the findings through the provider (local only here)
 *  - lockfiles and files with no patch are skipped without a model call
 *  - conventions from AGENTS.md reach the model prompt
 *  - the GitHub provider hits the right REST endpoint with the bearer token
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, before, after } from "node:test";

import type { Tool, ToolContext } from "../registry.js";
import { createPrReviewTool, renderReviewComment } from "../prReviewTools.js";
import {
  MAX_FINDINGS,
  buildReviewMessages,
  clampLine,
  dedupeFindings,
  formatReviewResult,
  isReviewable,
  loadRepoConventions,
  parseFindings,
  parseHunks,
  reviewFile,
  normalizeFinding,
  reviewPullRequest,
  reviewRanges,
  sortFindings,
  type PrReviewFinding,
  type PrReviewModelClient,
} from "../../agent/prReview.js";
import { GitHubPrProvider, LocalPrProvider, setPrDiff } from "../gitPrProvider.js";
import type { ChatMessage } from "../../ollama.js";
import type { PrDiff, PrFileDiff, PrProvider } from "../gitPrProvider.js";

/** A fake model that answers each file review from a scripted queue. */
class FakeModel implements PrReviewModelClient {
  readonly calls: Array<{ model: string; messages: ChatMessage[] }> = [];
  constructor(private readonly replies: string[]) {}

  async chat(opts: { model: string; messages: ChatMessage[] }): Promise<{ content: string }> {
    this.calls.push(opts);
    const next = this.replies.shift();
    if (next === undefined) throw new Error("fake model ran out of replies");
    return { content: next };
  }
}

/**
 * The fixture diff: an off-by-one loop bound in `src/counter.ts`.
 *
 * The hunk starts at new-file line 1, so the added `for (let i = 0; i <= n; i++)`
 * line is new-file line 7. That is the line every finding below must land on.
 */
const OFF_BY_ONE_DIFF = [
  "--- a/src/counter.ts",
  "+++ b/src/counter.ts",
  "@@ -1,10 +1,11 @@",
  ' import { assert } from "node:assert";',
  " /**",
  "  * Sum 0..n-1.",
  "  */",
  " export function sumTo(n: number): number {",
  "   let total = 0;",
  "-  for (let i = 0; i < n; i++) {",
  "+  for (let i = 0; i <= n; i++) {",
  "     total += i;",
  "   }",
  "   return total;",
  " }",
].join("\n");

/** The same diff as the provider returns it: only the hunks matter. */
const FIXTURE_FILES: PrFileDiff[] = [
  { path: "src/counter.ts", status: "modified", diff: OFF_BY_ONE_DIFF },
];

/** A two-file diff used by the `maxFiles` cap and the skip tests. */
const TWO_FILE_DIFF: Omit<PrDiff, "repo" | "number"> = {
  head: "feature/two",
  base: "main",
  files: [
    { path: "src/ok.ts", status: "modified", diff: "@@ -1,1 +1,2 @@\n export const x = 1;\n+export const y = 2;\n" },
    { path: "src/also-ok.ts", status: "modified", diff: "@@ -1,1 +1,2 @@\n export const z = 3;\n+export const w = 4;\n" },
  ],
};

function fixtureDiff(repo = "owner/repo", number = 7): Omit<PrDiff, "repo" | "number"> {
  return { head: "feature/sum", base: "main", files: FIXTURE_FILES };
}

function bugReply(line: number, explanation = "Loop bound is inclusive (<=) but the function sums 0..n-1; the result is off by n."): string {
  return JSON.stringify({
    findings: [
      { severity: "bug", line, explanation, suggested_fix: "Change `i <= n` back to `i < n`." },
    ],
  });
}

function emptyReply(): string {
  return '{"findings":[]}';
}

describe("unified diff parsing", () => {
  it("parses hunk headers and new-file line numbers", () => {
    const hunks = parseHunks(OFF_BY_ONE_DIFF);
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0]!.newStart, 1);
    // Added and context lines advance the counter; removed lines do not.
    assert.deepEqual(hunks[0]!.lines, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.equal(hunks[0]!.newCount, 11, "the header's own new-file count");
  });

  it("tracks each new-file line a hunk touches", () => {
    const { changed, maxLine } = reviewRanges(FIXTURE_FILES[0]!);
    assert.equal(maxLine, 11);
    assert.equal(changed.has(7), true, "the added loop line is touched");
    assert.equal(changed.has(1), true);
  });

  it("keeps the last hunk when a file has several", () => {
    const diff = ["@@ -1,2 +1,2 @@", " a", "-b", "+B", "@@ -40,2 +41,2 @@", " c", "-d", "+D"].join("\n");
    const hunks = parseHunks(diff);
    assert.deepEqual(hunks.map((h) => h.newStart), [1, 41]);
    assert.deepEqual(hunks[1]!.lines, [41, 42]);
  });

  it("skips removed-only and annotation lines without drifting the counter", () => {
    // old lines: -gone, +added, " ctx"; new lines: +added, " ctx".
    const diff = ["@@ -5,2 +5,2 @@", "-gone", "+added", "\\ No newline at end of file", " ctx"].join("\n");
    const hunks = parseHunks(diff);
    assert.deepEqual(hunks[0]!.lines, [5, 6], "the removed line advances no new-file number");
  });

  it("tolerates a diff with no hunk header at all", () => {
    assert.deepEqual(parseHunks("src/a.ts | 2 +-\n"), []);
    assert.deepEqual(reviewRanges({ path: "src/a.ts", status: "modified", diff: "src/a.ts | 2 +-\n" }), {
      changed: new Set<number>(),
      maxLine: 0,
    });
  });
});

describe("finding validation and deduplication", () => {
  const file = FIXTURE_FILES[0]!;
  const ranges = reviewRanges(file);

  it("clamps a reported line into the new-file range", () => {
    assert.equal(clampLine(7, ranges), 7);
    assert.equal(clampLine(9999, ranges), 11, "a line past the end lands on the last changed line");
    assert.equal(clampLine(0, ranges), 1, "line 0 is not a real line");
    assert.equal(clampLine("4", ranges), 4, "numeric strings are accepted");
    assert.equal(clampLine(undefined, ranges), 1, "a missing line falls back to the first changed line");
  });

  it("drops findings that do not belong to the file", () => {
    const raw = parseFindings(
      JSON.stringify({
        findings: [
          { severity: "bug", line: 7, explanation: "wrong file", file: "src/other.ts", suggested_fix: "" },
          { severity: "bug", line: 7, explanation: "real issue" },
          { severity: "critical", line: 7, explanation: "unknown severity" },
          { severity: "nit", line: 7, explanation: "  " },
        ],
      }),
    );
    const normalized = raw
      .map((f) => normalizeFinding(f, file, ranges))
      .filter((f): f is PrReviewFinding => f !== null);
    assert.equal(normalized.length, 1, "only the finding for this file with a known severity and an explanation survives");
    assert.equal(normalized[0]!.explanation, "real issue");
  });

  it("merges duplicates on the same file and line", () => {
    const base: PrReviewFinding = { severity: "flag", file: "src/counter.ts", line: 7, explanation: "Loop bound is inclusive.", suggested_fix: "" };
    const duplicate: PrReviewFinding = { severity: "nit", file: "src/counter.ts", line: 7, explanation: "Loop bound is inclusive.", suggested_fix: "Use `i < n`." };
    const merged = dedupeFindings([base, duplicate]);
    assert.equal(merged.length, 1);
    // The most severe wins; the loser's fix is merged in only when it adds one.
    assert.equal(merged[0]!.severity, "flag");
    assert.equal(merged[0]!.suggested_fix, "Use `i < n`.");
  });

  it("keeps a finding whose explanation adds detail", () => {
    const a: PrReviewFinding = { severity: "bug", file: "src/counter.ts", line: 7, explanation: "Off-by-one.", suggested_fix: "" };
    const b: PrReviewFinding = { severity: "bug", file: "src/counter.ts", line: 7, explanation: "Off-by-one: the bound must be exclusive.", suggested_fix: "" };
    const merged = dedupeFindings([a, b]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]!.severity, "bug");
    assert.equal(
      merged[0]!.explanation,
      "Off-by-one: the bound must be exclusive. (also reported as: Off-by-one.)",
      "the fuller explanation is kept and the shorter one appended as a note",
    );
  });

  it("appends an explanation that says something new", () => {
    const merged = dedupeFindings([
      { severity: "bug", file: "src/counter.ts", line: 7, explanation: "Off-by-one.", suggested_fix: "" },
      { severity: "nit", file: "src/counter.ts", line: 7, explanation: "The loop must be half-open.", suggested_fix: "" },
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]!.severity, "bug");
    assert.match(merged[0]!.explanation, /The loop must be half-open\. \(also reported as: Off-by-one\.\)/);
  });

  it("keeps findings on different files apart even at the same line", () => {
    const findings: PrReviewFinding[] = [
      { severity: "bug", file: "src/a.ts", line: 3, explanation: "A", suggested_fix: "" },
      { severity: "bug", file: "src/b.ts", line: 3, explanation: "B", suggested_fix: "" },
    ];
    assert.equal(dedupeFindings(findings).length, 2);
  });

  it("sorts by severity then file then line", () => {
    const sorted = sortFindings([
      { severity: "nit", file: "src/a.ts", line: 1, explanation: "n", suggested_fix: "" },
      { severity: "bug", file: "src/b.ts", line: 9, explanation: "b", suggested_fix: "" },
      { severity: "bug", file: "src/a.ts", line: 4, explanation: "b2", suggested_fix: "" },
    ]);
    assert.deepEqual(sorted.map((f) => `${f.severity}:${f.file}:${f.line}`), [
      "bug:src/a.ts:4",
      "bug:src/b.ts:9",
      "nit:src/a.ts:1",
    ]);
  });

  it("parses a fenced JSON reply and ignores prose around it", () => {
    const findings = parseFindings('Here you go:\n```json\n{"findings":[{"severity":"nit","line":7,"explanation":"x"}]}\n```\nHope that helps.');
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.severity, "nit");
  });

  it("returns no findings for unparseable or non-JSON replies", () => {
    assert.deepEqual(parseFindings("I cannot review this."), []);
    assert.deepEqual(parseFindings('{"findings": 3}'), []);
    assert.deepEqual(parseFindings("not json at all"), []);
  });
});

describe("reviewer prompts and conventions", () => {
  it("numbers the added lines so the model can cite them", () => {
    const prompt = buildReviewMessages(FIXTURE_FILES[0]!, "");
    assert.equal(prompt.length, 2);
    assert.equal(prompt[0]!.role, "system");
    const user = prompt[1]!.content;
    assert.match(user, /File: src\/counter\.ts/);
    assert.match(user, /for \(let i = 0; i <= n; i\+\+\)/);
    // The added loop line is the 7th new-file line.
    assert.match(user, /7 \+ .*i <= n/);
  });

  it("puts the repo conventions in front of the diff", () => {
    const user = buildReviewMessages(FIXTURE_FILES[0]!, "## AGENTS.md\nAlways use `i < n` for half-open loops.")[1]!.content;
    assert.ok(user.indexOf("Always use `i < n`") < user.indexOf("File: src/counter.ts"), "conventions precede the diff");
  });

  it("loads AGENTS.md and CONTRIBUTING.md from the workspace", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-conv-"));
    try {
      fs.writeFileSync(path.join(tmp, "AGENTS.md"), "Use tabs for indentation.\n");
      fs.writeFileSync(path.join(tmp, "CONTRIBUTING.md"), "Run the gates before you finish.\n");
      const loaded = loadRepoConventions(tmp);
      assert.deepEqual(loaded.files.length, 2);
      assert.match(loaded.text, /Use tabs for indentation/);
      assert.match(loaded.text, /Run the gates before you finish/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns an empty block when the workspace has no conventions", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-conv-empty-"));
    try {
      const loaded = loadRepoConventions(tmp);
      assert.equal(loaded.text, "");
      assert.deepEqual(loaded.files, []);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips lockfiles and vendor output", () => {
    assert.equal(isReviewable({ path: "package-lock.json", status: "modified", diff: "@@ -1 +1 @@\n-a\n+b" }), false);
    assert.equal(isReviewable({ path: "node_modules/lib/index.js", status: "modified", diff: "@@ -1 +1 @@\n-a\n+b" }), false);
    assert.equal(isReviewable({ path: "src/index.ts", status: "modified", diff: "" }), false);
    assert.equal(isReviewable({ path: "src/index.ts", status: "modified", diff: "@@ -1 +1 @@\n-a\n+b" }), true);
  });

  it("caps the number of findings kept", () => {
    const many: PrReviewFinding[] = Array.from({ length: MAX_FINDINGS + 10 }, (_, i) => ({
      severity: "nit",
      file: "src/a.ts",
      line: i + 1,
      explanation: `issue ${i}`,
      suggested_fix: "",
    }));
    assert.equal(dedupeFindings(many).length, MAX_FINDINGS + 10, "dedup keeps them distinct");
    assert.equal(sortFindings(many).slice(0, MAX_FINDINGS).length, MAX_FINDINGS);
  });
});

describe("reviewPullRequest (mocked model, scripted diff)", () => {
  let tmp = "";
  let provider: LocalPrProvider;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-prreview-"));
    provider = new LocalPrProvider(path.join(tmp, "prs"));
    provider.createPr({
      repo: "owner/repo",
      title: "Sum inclusive",
      head: "feature/sum",
      base: "main",
      number: 7,
    });
    setPrDiff(provider, "owner/repo", 7, fixtureDiff());
    setPrDiff(provider, "owner/repo", 8, TWO_FILE_DIFF);
  });

  after(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("reports a bug finding at the seeded off-by-one line", async () => {
    const model = new FakeModel([bugReply(7), emptyReply()]);
    const result = await reviewPullRequest(provider, "owner/repo", 7, { modelClient: model });
    assert.equal(result.warnings.length, 0, result.warnings.join("; "));
    assert.equal(result.reviewedFiles.length, 1);
    assert.equal(result.findings.length, 1);
    const finding = result.findings[0]!;
    assert.equal(finding.severity, "bug");
    assert.equal(finding.file, "src/counter.ts");
    assert.equal(finding.line, 7, "the added `i <= n` line is new-file line 7");
    assert.ok(finding.suggested_fix.length > 0, "a bug carries a suggested fix");
    assert.equal(model.calls.length, 1);
  });

  it("sends the model a numbered diff of the changed file", async () => {
    const model = new FakeModel([emptyReply()]);
    await reviewPullRequest(provider, "owner/repo", 7, { modelClient: model });
    const user = model.calls[0]!.messages[1]!.content;
    assert.match(user, /i <= n/);
    assert.match(user, /src\/counter\.ts/);
  });

  it("passes the conventions through to the model", async () => {
    const model = new FakeModel([emptyReply()]);
    await reviewPullRequest(provider, "owner/repo", 7, {
      modelClient: model,
      conventions: "Convention: loops are half-open.",
    });
    assert.match(model.calls[0]!.messages[1]!.content, /Convention: loops are half-open/);
  });

  it("merges duplicate findings the model repeats", async () => {
    const model = new FakeModel([
      JSON.stringify({
        findings: [
          { severity: "nit", line: 7, explanation: "Bound is inclusive.", suggested_fix: "" },
          { severity: "bug", line: 7, explanation: "Bound is inclusive.", suggested_fix: "Use `i < n`." },
          { severity: "nit", line: 7, explanation: "Bound is inclusive.", suggested_fix: "" },
        ],
      }),
    ]);
    const result = await reviewPullRequest(provider, "owner/repo", 7, { modelClient: model });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]!.severity, "bug");
  });

  it("skips files that carry no convention signal", async () => {
    setPrDiff(provider, "owner/repo", 8, {
      ...TWO_FILE_DIFF,
      files: [
        { path: "package-lock.json", status: "modified", diff: "@@ -1 +1 @@\n-a\n+b" },
        { path: "src/ok.ts", status: "modified", diff: "@@ -1,1 +1,2 @@\n export const x = 1;\n+export const y = 2;\n" },
      ],
    });
    const model = new FakeModel([emptyReply()]);
    const result = await reviewPullRequest(provider, "owner/repo", 8, { modelClient: model });
    assert.deepEqual(result.skippedFiles, ["package-lock.json"]);
    assert.deepEqual(result.reviewedFiles, ["src/ok.ts"]);
    assert.equal(model.calls.length, 1);
  });

  it("reports a file whose model call fails instead of failing the review", async () => {
    const failing = Object.create(provider) as PrProvider;
    failing.prDiff = async () => ({
      repo: "owner/repo",
      number: 9,
      head: "h",
      base: "b",
      files: [
        { path: "src/boom.ts", status: "modified", diff: "@@ -1,1 +1,2 @@\n a\n+b\n" },
        { path: "src/fine.ts", status: "modified", diff: "@@ -1,1 +1,2 @@\n a\n+c\n" },
      ],
    });
    const model: PrReviewModelClient = {
      async chat() {
        throw new Error("model exploded");
      },
    };
    const result = await reviewPullRequest(failing, "owner/repo", 9, { modelClient: model });
    assert.equal(result.findings.length, 0);
    assert.equal(result.warnings.length, 2);
    assert.match(result.warnings.join("; "), /model exploded/);
  });

  it("fails loudly when the diff cannot be fetched", async () => {
    await assert.rejects(
      () => reviewPullRequest(provider, "owner/repo", 999, { modelClient: new FakeModel([]) }),
      /could not fetch the diff/,
    );
  });

  it("reviews one file at a time with the exported helper", async () => {
    const findings = await reviewFile(FIXTURE_FILES[0]!, "", async () => bugReply(7), "");
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.line, 7);
  });

  it("formats the findings for the model", () => {
    const text = formatReviewResult(
      {
        findings: [{ severity: "bug", file: "src/counter.ts", line: 7, explanation: "Off-by-one.", suggested_fix: "Use `i < n`." }],
        reviewedFiles: ["src/counter.ts"],
        skippedFiles: [],
        warnings: [],
        modelCalls: 1,
      },
      { repo: "owner/repo", number: 7, posted: 1 },
    );
    assert.match(text, /\[bug\] \(posted\) src\/counter\.ts:7/);
    assert.match(text, /suggested fix: Use `i < n`/);
  });
});

describe("pr_review tool", () => {
  let tmp = "";
  let work = "";
  let provider: LocalPrProvider;
  let tool: Tool;

  function ctx(): ToolContext {
    return { cfg: { model: "test-model" } as never, workspace: work, emit: () => {} };
  }

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-prreview-tool-"));
    work = path.join(tmp, "work");
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, "AGENTS.md"), "Convention: loops are half-open.\n");
    provider = new LocalPrProvider(path.join(tmp, "prs"));
    provider.createPr({ repo: "owner/repo", title: "Sum inclusive", head: "feature/sum", base: "main", number: 7 });
    provider.createPr({ repo: "owner/repo", title: "Two files", head: "feature/two", base: "main", number: 8 });
    setPrDiff(provider, "owner/repo", 7, fixtureDiff());
    setPrDiff(provider, "owner/repo", 8, TWO_FILE_DIFF);
    tool = createPrReviewTool({ provider, conventions: "Convention: loops are half-open." });
  });

  after(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("is named pr_review and requires a pull request number", async () => {
    assert.equal(tool.name, "pr_review");
    const missing = await tool.run({ repo: "owner/repo" }, ctx());
    assert.equal(missing.ok, false);
    assert.match(missing.content, /requires a pull request number/);
  });

  it("reviews through the tool and reads the workspace conventions", async () => {
    const model = new FakeModel([bugReply(7)]);
    const result = await createPrReviewTool({ provider, modelClient: model }).run({ repo: "owner/repo", number: 7 }, ctx());
    assert.equal(result.ok, true, result.content);
    assert.match(result.content, /\[bug\] src\/counter\.ts:7/);
    assert.match(model.calls[0]!.messages[1]!.content, /Convention: loops are half-open/);
  });

  it("posts the findings as review comments only when asked", async () => {
    const model = new FakeModel([bugReply(7)]);
    const result = await createPrReviewTool({ provider, modelClient: model }).run(
      { repo: "owner/repo", number: 7, postComments: true },
      ctx(),
    );
    assert.equal(result.ok, true, result.content);
    const comments = await provider.listReviewComments("owner/repo", 7);
    assert.equal(comments.length, 1);
    assert.equal(comments[0]!.path, "src/counter.ts");
    assert.equal(comments[0]!.line, 7, "the comment lands on the off-by-one line");
    assert.match(comments[0]!.body, /\[bug\]/);
  });

  it("posts nothing by default", async () => {
    const before = (await provider.listReviewComments("owner/repo", 7)).length;
    const model = new FakeModel([bugReply(7)]);
    const result = await createPrReviewTool({ provider, modelClient: model }).run({ repo: "owner/repo", number: 7 }, ctx());
    assert.equal(result.ok, true, result.content);
    assert.equal((await provider.listReviewComments("owner/repo", 7)).length, before);
  });

  it("reports a comment failure as a warning instead of failing", async () => {
    const failing = Object.create(provider) as PrProvider;
    failing.addComment = async () => {
      throw new Error("comments are read-only");
    };
    const model = new FakeModel([bugReply(7)]);
    const result = await createPrReviewTool({ provider: failing, modelClient: model }).run(
      { repo: "owner/repo", number: 7, postComments: true },
      ctx(),
    );
    assert.equal(result.ok, true, result.content);
    assert.match(result.content, /could not post src\/counter\.ts:7/);
  });

  it("renders a review comment with its suggested fix", () => {
    const body = renderReviewComment({ severity: "flag", explanation: "Missing await.", suggested_fix: "await the call." });
    assert.match(body, /\*\*\[flag\] loam pr_review\*\*/);
    assert.match(body, /Missing await/);
    assert.match(body, /Suggested fix:\nawait the call/);
  });

  it("caps the files reviewed", async () => {
    const model = new FakeModel([emptyReply(), emptyReply()]);
    const result = await reviewPullRequest(provider, "owner/repo", 8, { modelClient: model, maxFiles: 1 });
    assert.equal(result.reviewedFiles.length, 1, "only one of the two changed files is reviewed");
    assert.equal(model.calls.length, 1);
  });
});

describe("GitHubPrProvider pr_diff (mocked fetch)", () => {
  it("hits the files endpoint with the bearer token and maps the patch", async () => {
    const calls: Array<{ url: string; method: string; auth: string }> = [];
    const mock = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, method: String(init?.method ?? "GET"), auth: String(headers.authorization ?? "") });
      const payload = url.endsWith("/pulls/7")
        ? { number: 7, title: "T", state: "open", html_url: "https://github.com/owner/repo/pull/7", head: { ref: "feature/sum" }, base: { ref: "main" } }
        : [
            { filename: "src/counter.ts", status: "modified", patch: OFF_BY_ONE_DIFF },
            { filename: "logo.png", status: "modified" },
          ];
      return { ok: true, status: 200, async json() { return payload; }, async text() { return JSON.stringify(payload); } } as unknown as Response;
    });

    const provider = new GitHubPrProvider({ token: async () => "tok", fetchImpl: mock as unknown as typeof fetch });
    const diff = await provider.prDiff("owner/repo", 7);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.url, "https://api.github.com/repos/owner/repo/pulls/7/files?per_page=100");
    assert.equal(calls[1]!.method, "GET");
    assert.equal(calls[1]!.auth, "Bearer tok");
    assert.equal(diff.head, "feature/sum");
    assert.equal(diff.base, "main");
    assert.equal(diff.files.length, 2);
    assert.equal(diff.files[0]!.path, "src/counter.ts");
    assert.match(diff.files[0]!.diff, /@@ -1,10 \+1,11 @@/);
    // A binary file has no patch: the reviewer skips it rather than guessing.
    assert.equal(diff.files[1]!.diff, "");
    assert.equal(isReviewable(diff.files[1]!), false);
  });
});

describe("local provider diff storage", () => {
  it("stores the seeded diff under the provider directory", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-prdiff-store-"));
    try {
      const provider = new LocalPrProvider(path.join(tmp, "prs"));
      provider.createPr({ repo: "owner/repo", title: "T", head: "h", base: "b" });
      setPrDiff(provider, "owner/repo", 1, { head: "h", base: "b", files: FIXTURE_FILES });
      const diff = await provider.prDiff("owner/repo", 1);
      assert.equal(diff.files[0]!.path, "src/counter.ts");
      assert.equal(diff.files[0]!.diff, OFF_BY_ONE_DIFF);
      assert.ok(fs.existsSync(path.join(tmp, "prs", "owner_repo-diffs.json")), "the diff is persisted next to the PRs");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses to seed a diff on a provider that cannot store one", () => {
    const githubOnly = new GitHubPrProvider({ token: async () => "t" });
    assert.throws(() => setPrDiff(githubOnly, "owner/repo", 1, { head: "h", base: "b", files: [] }), /LocalPrProvider/);
  });

  it("throws for an unseeded pull request", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-prdiff-empty-"));
    try {
      const provider = new LocalPrProvider(path.join(tmp, "prs"));
      await assert.rejects(() => provider.prDiff("owner/repo", 42), /no local diff/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
