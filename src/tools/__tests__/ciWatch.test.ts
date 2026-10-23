/**
 * D2 CI watch loop — unit tests with mocked providers.
 *
 * No network is used: every test drives `pollCiChecks` / the `ci_watch` tool with
 * an in-memory fake `PrProvider` (or a scripted `LocalPrProvider`). The GitHub
 * provider's check-runs call is exercised with a mocked fetch so the REST path is
 * covered without touching the network.
 *
 * Covered:
 *  - fail -> fail -> pass drives exactly 2 fix iterations (the third poll is green)
 *  - 4 consecutive identical failures stop at 3 attempts and escalate
 *  - a provider that hangs is reported as a timeout instead of stalling the loop
 *  - the log tail is trimmed to its last lines and capped in characters
 *  - the agent loop injects its stop-and-report notice only on an escalation
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, after } from "node:test";

import type { ToolContext } from "../registry.js";
import { ToolRegistry } from "../registry.js";
import type { OllamaClient, ChatResult, OllamaToolCall } from "../../ollama.js";
import { createCiWatchTool } from "../ciWatchTools.js";
import { runAgent } from "../../agent/loop.js";
import {
  CI_ESCALATION_MARKER,
  CiWatchBudget,
  DEFAULT_LOG_TAIL_LINES,
  MAX_CI_FIX_ATTEMPTS,
  failureSignature,
  isCiEscalation,
  pollCiChecks,
  resolvePrProvider,
  trimLogTail,
} from "../../agent/ciWatch.js";
import { ciWatchEscalationNotice, watchCiOnce } from "../../agent/ciWatchLoop.js";
import { GitHubPrProvider, LocalPrProvider } from "../gitPrProvider.js";
import type { CheckRunInfo, PrComment, PrDiff, PrInfo, PrProvider } from "../gitPrProvider.js";

/** The empty diff the ci_watch tests never need (pr_review is D15's tool). */
const EMPTY_DIFF: PrDiff = { repo: "o/r", number: 0, head: "", base: "", files: [] };

/** An in-memory provider whose check-runs and job logs come from a mutable list. */
class FakeProvider implements PrProvider {
  readonly id = "fake";
  calls = 0;
  constructor(
    private readonly runs: () => CheckRunInfo[],
    private readonly logs: (id: string) => string,
  ) {}

  async createPr(): Promise<PrInfo> {
    throw new Error("not used");
  }
  async viewPr(): Promise<PrInfo> {
    throw new Error("not used");
  }
  async listReviewComments() {
    return [];
  }
  async addComment(): Promise<PrComment> {
    throw new Error("not used");
  }
  async setPrBody(): Promise<PrInfo> {
    throw new Error("not used");
  }
  async listCheckRuns() {
    this.calls++;
    return this.runs();
  }
  async getCheckRunLog(_repo: string, id: string) {
    return this.logs(id);
  }
  async prDiff() {
    return EMPTY_DIFF;
  }
}

function failingRun(id: string, name: string): CheckRunInfo {
  return { id, name, status: "completed", conclusion: "failure", head: "" };
}

const pass = (id: string, name: string): CheckRunInfo => ({ id, name, status: "completed", conclusion: "success", head: "" });

/** A check-run whose only relevant field for a signature is its name. */
const namedRun = (name: string): CheckRunInfo => ({ id: "x", name, status: "completed", conclusion: "failure", head: "" });

/** The signature the watch derives for a failing job with this log tail. */
function signatureFor(name: string, log: string): string {
  return failureSignature(namedRun(name), trimLogTail(log, 8));
}

/** A provider that reports `failures` failing runs, each with its own log tail. */
function failingProvider(logs: Record<string, string>): FakeProvider {
  return new FakeProvider(
    () => Object.keys(logs).map((id) => failingRun(id, `job-${id}`)),
    (id) => logs[id] ?? "",
  );
}

/** A provider that reports exactly one failing job with a stable log tail. */
function singleFailureProvider(log: string): FakeProvider {
  return new FakeProvider(() => [failingRun("1", "build (node 22)")], () => log);
}

/** A provider whose check-runs never settle, so the poll always times out. */
function hangingProvider(): PrProvider {
  return {
    id: "hanging",
    async createPr() {
      throw new Error("not used");
    },
    async viewPr() {
      throw new Error("not used");
    },
    async listReviewComments() {
      return [];
    },
    async addComment() {
      throw new Error("not used");
    },
    async setPrBody(): Promise<PrInfo> {
      throw new Error("not used");
    },
    async listCheckRuns() {
      await new Promise(() => {});
      return [];
    },
    async getCheckRunLog() {
      return "";
    },
    async prDiff() {
      return EMPTY_DIFF;
    },
  };
}

/** The exact D2 acceptance script: fail -> fail -> pass drives 2 fix iterations. */
describe("ci_watch fix budget", () => {
  it("fail -> fail -> pass drives exactly 2 fix iterations", async () => {
    let polls = 0;
    const provider = new FakeProvider(
      () => {
        polls++;
        return polls <= 2 ? [failingRun("1", "build")] : [pass("1", "build")];
      },
      () => "TypeError: boom\n    at src/index.ts:1:1",
    );
    const budget = new CiWatchBudget();

    // Poll 1: failing, 0 attempts used -> inside budget, the model may fix it.
    const first = await pollCiChecks(provider, "o/r", "main", { attemptsFor: (s) => budget.used(s) });
    assert.equal(first.status, "failed");
    assert.equal(first.retry, true);
    for (const job of first.failingJobs!) budget.spend(job.signature);
    assert.equal(budget.used(first.failingJobs![0]!.signature), 1);

    // Poll 2: the same signature is still failing, 1 attempt used -> fix turn 2.
    const second = await pollCiChecks(provider, "o/r", "main", { attemptsFor: (s) => budget.used(s) });
    assert.equal(second.status, "failed");
    assert.equal(second.retry, true);
    assert.equal(second.escalation ?? null, null, "must not escalate before the budget is spent");
    for (const job of second.failingJobs!) budget.spend(job.signature);
    assert.equal(budget.used(second.failingJobs![0]!.signature), 2);

    // Poll 3: the model fixed it on its second fix turn -> green, watch stops.
    const third = await pollCiChecks(provider, "o/r", "main", { attemptsFor: (s) => budget.used(s) });
    assert.equal(third.status, "success", "the third poll must be green");
    assert.equal(third.retry, false, "a green poll stops the watch");

    // Exactly two polls were inside the fix budget: the model got two fix turns.
    assert.equal(polls, 3, "two failing polls then one green poll");
    assert.equal(third.failingJobs.length, 0);
  });

  it("4 consecutive identical failures stop at 3 attempts and escalate", async () => {
    const log = "TypeError: boom\n    at src/index.ts:1:1";
    const provider = singleFailureProvider(log);
    const budget = new CiWatchBudget();

    // The budget is checked before the poll, so attempts used are 0,1,2 then 3.
    for (let i = 1; i <= 3; i++) {
      const outcome = await pollCiChecks(provider, "o/r", "main", { attemptsFor: (s) => budget.used(s) });
      assert.equal(outcome.status, "failed");
      assert.equal(outcome.escalation ?? null, null, `poll ${i} must not escalate`);
      assert.equal(outcome.failingJobs![0]!.signature, signatureFor("build (node 22)", log));
      for (const job of outcome.failingJobs!) budget.spend(job.signature);
    }

    // The fourth identical failure has no budget left -> escalate, and stop.
    const fourth = await pollCiChecks(provider, "o/r", "main", { attemptsFor: (s) => budget.used(s) });
    assert.equal(fourth.status, "failed");
    assert.ok(fourth.escalation, "the fourth identical failure must escalate");
    assert.equal(fourth.retry, false, "escalation must stop the watch");
    assert.ok(fourth.escalation!.includes(CI_ESCALATION_MARKER));
    assert.ok(fourth.escalation!.includes("build (node 22)"));
    assert.ok(fourth.escalation!.includes("logTail") === false, "escalation text must not embed the raw log");

    // The model-facing text is machine-checkable and drives the loop notice.
    assert.equal(isCiEscalation(fourth.escalation!), true);
    assert.ok(ciWatchEscalationNotice(fourth.escalation!));
    assert.equal(ciWatchEscalationNotice("CI is failing. Fix these jobs."), null);
  });

  it("escalates only when every failing signature is out of budget", async () => {
    // Two jobs fail; only one has been retried three times.
    const provider = failingProvider({ 1: "error: old failure", 2: "error: brand new failure" });
    const budget = new CiWatchBudget();
    const oldSignature = signatureFor("job-1", "error: old failure");
    budget.spend(oldSignature);
    budget.spend(oldSignature);
    budget.spend(oldSignature);

    const outcome = await pollCiChecks(provider, "o/r", "main", { attemptsFor: (s) => budget.used(s) });
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.escalation ?? null, null, "a fresh signature keeps the budget alive");
    assert.equal(outcome.retry, true);
  });

  it("reports a hanging provider as a timeout instead of stalling the loop", async () => {
    const outcome = await pollCiChecks(hangingProvider(), "o/r", "main", { timeoutMs: 20 });
    assert.equal(outcome.status, "timeout");
    assert.ok(outcome.error, "timeout carries the provider error");
    assert.equal(outcome.retry, true, "a timeout keeps the watch retryable");
  });

  it("drops a job whose log cannot be fetched, without failing the whole watch", async () => {
    const provider = new FakeProvider(
      () => [failingRun("1", "build"), failingRun("2", "lint")],
      () => {
        throw new Error("log unavailable");
      },
    );
    const outcome = await pollCiChecks(provider, "o/r", "main", { timeoutMs: 1000 });
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.failingJobs!.length, 2, "both failures are still reported");
    assert.ok(outcome.failingJobs!.every((job) => job.logTail === ""));
  });
});

describe("ci_watch log tail", () => {
  it("keeps only the last N non-empty lines", () => {
    const log = ["a", "b", "", "c", "d", "e"].join("\n");
    assert.equal(trimLogTail(log, 3), "c\nd\ne");
    assert.equal(trimLogTail(log), ["a", "b", "c", "d", "e"].join("\n"));
  });

  it("caps the tail in characters with a marker", () => {
    // Long lines so the line cap alone would not be enough to reach the cap.
    const log = Array.from({ length: 200 }, (_, i) => `line-${i} ${ "x".repeat(200) }`).join("\n");
    const trimmed = trimLogTail(log, 200);
    assert.ok(trimmed.endsWith("[...log trimmed]"), `tail should be marked, got: ${ trimmed.slice(-40) }`);
    assert.ok(trimmed.includes("line-199"), "the last line is still present");
    assert.ok(trimmed.length < 8000 + 32);
  });

  it("signatures differ when the log tail differs", () => {
    const run = namedRun("build");
    assert.notEqual(failureSignature(run, "error A"), failureSignature(run, "error B"));
    assert.equal(failureSignature(run, "error A"), failureSignature(run, "error A"));
  });
});

describe("ci_watch tool", () => {
  function ctx(events: unknown[]): ToolContext {
    return { cfg: {} as never, workspace: os.tmpdir(), emit: (e) => events.push(e) };
  }

  it("is named ci_watch and requires repo and ref", async () => {
    const tool = createCiWatchTool({ provider: singleFailureProvider("log") });
    assert.equal(tool.name, "ci_watch");
    assert.deepEqual(tool.parameters.required, ["repo", "ref"]);

    const missing = await tool.run({ repo: "", ref: "" }, ctx([]));
    assert.equal(missing.ok, false);
    assert.match(missing.content, /repo and ref/);
  });

  it("returns failing job names with trimmed log tails", async () => {
    const tool = createCiWatchTool({ provider: singleFailureProvider("line1\nline2\nline3") });
    const result = await tool.run({ repo: "o/r", ref: "main" }, ctx([]));
    assert.equal(result.ok, true);
    assert.match(result.content, /build \(node 22\)/);
    assert.match(result.content, /line1/);
  });

  it("reports green CI as a pass", async () => {
    const tool = createCiWatchTool({
      provider: new FakeProvider(() => [pass("1", "build")], () => ""),
    });
    const result = await tool.run({ repo: "o/r", ref: "main" }, ctx([]));
    assert.equal(result.ok, true);
    assert.match(result.content, /green/);
  });

  it("emits a task-status escalation when the budget is spent", async () => {
    const events: unknown[] = [];
    // Three attempts already spent: the next poll escalates.
    const provider = singleFailureProvider("TypeError: boom");
    const budget = new CiWatchBudget();
    const signature = signatureFor("build (node 22)", "TypeError: boom");
    budget.spend(signature);
    budget.spend(signature);
    budget.spend(signature);

    const tool = createCiWatchTool({ provider, budget });
    const result = await tool.run({ repo: "o/r", ref: "main" }, ctx(events));
    assert.equal(result.ok, true);
    assert.ok(result.content.includes(CI_ESCALATION_MARKER));
    assert.ok(events.some((e) => (e as { type?: string }).type === "task-status"), "escalation surfaces as a task status");
  });

  it("reset forgets the tracked budget", async () => {
    const budget = new CiWatchBudget();
    const signature = signatureFor("build (node 22)", "TypeError: boom");
    budget.spend(signature);
    budget.spend(signature);
    budget.spend(signature);
    budget.reset();
    assert.equal(budget.used(signature), 0);
  });

  it("resolves the local provider from LOAM_PR_PROVIDER without network", () => {
    const provider = resolvePrProvider({ LOAM_PR_PROVIDER: "local", LOAM_PR_DIR: "/tmp/loam-ci-watch-test" });
    assert.equal(provider.id, "local");
    assert.ok(provider instanceof LocalPrProvider);
    assert.equal(resolvePrProvider({}).id, "github");
  });
});

describe("ci_watch end-to-end agent loop", () => {
  /** Minimal config for the loop; the model is faked, so nothing else is used. */
  function makeConfig(): never {
    return {
      model: "test-model",
      fallbackModel: "test-fallback",
      ollamaUrl: "http://localhost:11434",
      server: { host: "127.0.0.1", port: 3939 },
      agent: { maxSteps: 10, temperature: 0.2, requestTimeoutMs: 600000 },
      workspace: os.tmpdir(),
      policy: {
        networkEnabled: true,
        allowOutsideWorkspaceRead: true,
        denyCommandPatterns: [],
        allowCommandPatterns: [],
        maxCommandSeconds: 180,
        sandboxMode: "workspace-write",
      },
      browser: { channel: "msedge", headless: false, viewport: { width: 1280, height: 800 } },
      computerUse: { enabled: false, screenshotDir: "/tmp/screenshots" },
      memory: { enabled: false, model: "", file: "", autoStore: false, recallTop: 0, minScore: 0, maxEntries: 0, dedupeThreshold: 0 },
      screen: { enabled: false, fps: 1, quality: 60, maxWidth: 1280 },
      vision: { enabled: false, maxImagesPerStep: 0 },
      selfImprove: { enabled: false, reviewEvery: 1, model: "", maxSteps: 1, writeApproval: false },
      evaluation: { enabled: false, intervalMinutes: 360, suite: "core", critique: false, keepRuns: 0, transcripts: false },
      selfPlay: { maxCases: 0 },
      orchestrator: {
        enabled: false, plannerModel: "", verifierModel: "", maxPlanSteps: 1,
        maxStepsPerWorker: 1, maxRevisionsPerStep: 1, maxReplans: 1, verifyFinal: false,
      },
      mcpServers: {},
      compression: { enabled: false, thresholdPercent: 0.5, protectLead: 3, protectTail: 20, targetRatio: 0.2, model: "", contextWindow: {} },
      sessionLog: { enabled: false },
      subagent: { maxDepth: 2, maxConcurrentChildren: 4 },
    } as never;
  }

  /** Fake model: emits the given tool calls on the first turn, then finishes. */
  function fakeOllama(calls: OllamaToolCall[]): OllamaClient {
    let count = 0;
    return {
      async chat(): Promise<ChatResult> {
        count++;
        if (count === 1) {
          return {
            content: "", toolCalls: calls, model: "test-model",
            usage: { promptTokens: 1, completionTokens: 1, durationMs: 0 },
          };
        }
        return {
          content: "I have stopped polling ci_watch and reported the failure.",
          toolCalls: [], model: "test-model",
          usage: { promptTokens: 1, completionTokens: 1, durationMs: 0 },
        };
      },
    } as unknown as OllamaClient;
  }

  it("injects the stop-and-report notice after an escalated ci_watch result", async () => {
    const budget = new CiWatchBudget();
    const signature = signatureFor("build (node 22)", "TypeError: boom");
    budget.spend(signature);
    budget.spend(signature);
    budget.spend(signature);

    const registry = new ToolRegistry();
    registry.register(createCiWatchTool({ provider: singleFailureProvider("TypeError: boom"), budget }));

    const result = await runAgent({
      cfg: makeConfig(),
      ollama: fakeOllama([{ function: { name: "ci_watch", arguments: { repo: "o/r", ref: "main" } } }]),
      tools: registry.forAllowlist(["ci_watch"]),
      emit: () => {},
      prompt: "Watch CI for o/r@main.",
      suppressFinal: true,
      systemOverride: "test system",
    });

    const toolResult = result.messages.find((m) => m.role === "tool");
    assert.ok(toolResult, "ci_watch produced a tool result");
    assert.ok(toolResult.content.includes(CI_ESCALATION_MARKER), "the tool result escalates");

    // The loop must have injected the notice so the model stops polling.
    const notice = result.messages.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes(CI_ESCALATION_MARKER),
    );
    assert.ok(notice, "the loop injected the ci_watch escalation notice");
  });

  it("injects no notice when the poll is still inside its budget", async () => {
    const budget = new CiWatchBudget();
    const registry = new ToolRegistry();
    registry.register(createCiWatchTool({ provider: singleFailureProvider("TypeError: boom"), budget }));

    const result = await runAgent({
      cfg: makeConfig(),
      ollama: fakeOllama([{ function: { name: "ci_watch", arguments: { repo: "o/r", ref: "main" } } }]),
      tools: registry.forAllowlist(["ci_watch"]),
      emit: () => {},
      prompt: "Watch CI for o/r@main.",
      suppressFinal: true,
      systemOverride: "test system",
    });

    const toolResult = result.messages.find((m) => m.role === "tool");
    assert.ok(toolResult);
    assert.ok(!toolResult.content.includes(CI_ESCALATION_MARKER), "a first failure does not escalate");
    const notice = result.messages.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes(CI_ESCALATION_MARKER),
    );
    assert.equal(notice, undefined, "no notice is injected before the budget is spent");
  });
});

describe("ci_watch loop integration", () => {
  it("injects the stop-and-report notice only on an escalation", () => {
    assert.equal(ciWatchEscalationNotice("CI is failing. Fix these jobs."), null);
    const notice = ciWatchEscalationNotice(`${CI_ESCALATION_MARKER} still failing`);
    assert.ok(notice);
    assert.ok(notice!.includes(CI_ESCALATION_MARKER));
  });

  it("watchCiOnce returns null when CI is green", async () => {
    const budget = new CiWatchBudget();
    const provider = new FakeProvider(() => [pass("1", "build")], () => "");
    const result = await watchCiOnce(budget, provider, "o/r", "main", { emit: () => {} });
    assert.equal(result, null);
  });

  it("watchCiOnce escalates to the user once the budget is spent", async () => {
    const events: unknown[] = [];
    const budget = new CiWatchBudget();
    const provider = singleFailureProvider("TypeError: boom");
    const signature = signatureFor("build (node 22)", "TypeError: boom");
    budget.spend(signature);
    budget.spend(signature);
    budget.spend(signature);

    // No taskId: escalates via emitted events without blocking on an approval.
    const report = await watchCiOnce(budget, provider, "o/r", "main", {
      emit: (e) => events.push(e),
    });
    assert.ok(report);
    assert.equal(report!.escalated, true);
    assert.ok(report!.text.includes(CI_ESCALATION_MARKER));
    assert.ok(events.some((e) => (e as { type?: string }).type === "task-status"));
    assert.ok(events.some((e) => (e as { type?: string }).type === "assistant_message"));
  });
});

describe("ci_watch GitHub provider (mocked fetch)", () => {
  it("hits the check-runs endpoint for a ref with the bearer token", async () => {
    const requested: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      requested.push(String(url));
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            total_count: 1,
            check_runs: [{ id: 55, name: "build", status: "completed", conclusion: "failure", head_sha: "abc1234def" }],
          });
        },
      } as unknown as Response;
    }) as typeof fetch;

    const provider = new GitHubPrProvider({
      token: async () => "test-token",
      fetchImpl,
      apiBase: "https://api.test.local",
    });
    const runs = await provider.listCheckRuns("owner/repo", "feature/x");
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.name, "build");
    assert.equal(runs[0]!.conclusion, "failure");
    assert.equal(runs[0]!.head, "abc1234");
    assert.equal(requested[0], "https://api.test.local/repos/owner/repo/commits/feature%2Fx/check-runs");
  });

  it("reads scripted check-runs from the local provider", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-ci-watch-"));
    try {
      const provider = new LocalPrProvider(dir);
      provider.setCheckScript("o/r", "main", {
        runs: [
          { id: "1", name: "build", status: "completed", conclusion: "failure", head: "" },
          { id: "2", name: "lint", status: "completed", conclusion: "success", head: "" },
        ],
        logs: { 1: "TypeError: boom\n    at src/index.ts:1:1" },
      });
      const runs = await provider.listCheckRuns("o/r", "main");
      assert.equal(runs.length, 2);
      assert.match(await provider.getCheckRunLog("o/r", "1"), /TypeError: boom/);
      assert.equal((await provider.listCheckRuns("o/r", "other")).length, 3, "unknown refs fall back to the default script");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

after(() => {
  // Sanity: the constants the budget depends on stay in sync.
  assert.equal(DEFAULT_LOG_TAIL_LINES, 40);
  assert.equal(MAX_CI_FIX_ATTEMPTS, 3);
});
