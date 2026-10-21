/**
 * Unit tests for the wide-research dispatcher + synthesis core.
 *
 * Everything here runs offline: the research children are a mock dispatcher
 * and the merge step is a mock synthesizer, so no model and no network are
 * involved. The tests pin the behaviour the tool promises:
 *   - a bounded, deterministic query plan;
 *   - a bounded parallel fan-out that keeps every child failure visible;
 *   - citation extraction and deduplication;
 *   - a merged summary that carries the deduplicated source list.
 */
import assert from "node:assert";
import { describe, it } from "node:test";

import type { ToolContext } from "../registry.js";
import {
  WIDE_RESEARCH_MAX_BREADTH,
  buildChildPrompt,
  buildSynthesisPrompt,
  createWideResearchTool,
  dedupeCitations,
  deterministicSynthesis,
  extractCitations,
  extractJsonObject,
  groupFindingsBySource,
  normalizeCitation,
  normalizeSources,
  parseTaskResult,
  planResearchTasks,
  resolveChildAllowlist,
  runWideResearch,
  type WideResearchDispatcher,
  type WideResearchSynthesizer,
  type WideResearchTask,
} from "../wideResearch.js";

function mockDispatcher(answers: Record<string, { summary: string; citations?: string[] }>): WideResearchDispatcher {
  return async (task: WideResearchTask) => {
    const answer = answers[task.angleId] ?? { summary: `nothing known about ${task.angleId}` };
    return { summary: answer.summary, citations: answer.citations ?? [] };
  };
}

const noopSynthesizer: WideResearchSynthesizer = async (input) =>
  `merged(${input.findings.length} findings, ${input.sources.length} sources)`;

describe("wide research — plan", () => {
  it("plans one task per angle when no source is given", () => {
    const tasks = planResearchTasks("why is the sky blue", [], 3);
    assert.strictEqual(tasks.length, 3);
    assert.strictEqual(tasks[0]?.angleId, "general");
    assert.strictEqual(tasks[1]?.angleId, "recent");
    assert.strictEqual(tasks[2]?.angleId, "evidence");
    for (const task of tasks) {
      assert.ok(task.question.includes("why is the sky blue"), "every sub-question carries the parent question");
      assert.ok(task.id.length > 0 && task.id !== "", "every sub-task has an id");
    }
  });

  it("gives every seed source its own sub-task", () => {
    const tasks = planResearchTasks("q", ["https://a.example/1", "https://b.example/2"], 4);
    assert.strictEqual(tasks.length, 4);
    assert.strictEqual(tasks[0]?.source, "https://a.example/1");
    assert.strictEqual(tasks[1]?.source, "https://b.example/2");
    assert.strictEqual(tasks[2]?.source, undefined, "the remaining budget is spent on angles");
  });

  it("never plans more than the breadth and never more than the hard ceiling", () => {
    assert.strictEqual(planResearchTasks("q", [], 0).length, 1, "breadth is clamped to at least one task");
    assert.strictEqual(planResearchTasks("q", [], 999).length, WIDE_RESEARCH_MAX_BREADTH);
    assert.strictEqual(planResearchTasks("q", new Array(50).fill("https://x.example"), 5).length, 5);
  });

  it("cycles angles when the breadth exceeds the angle catalog", () => {
    const tasks = planResearchTasks("q", [], 9);
    const ids = tasks.map((t) => t.angleId);
    assert.strictEqual(new Set(ids).size, 9, "every sub-task has a distinct angle id");
  });

  it("normalizes and dedupes the source list", () => {
    assert.deepStrictEqual(normalizeSources([" a ", "a", "", 42, "https://b.example"]), ["a", "https://b.example"]);
    assert.deepStrictEqual(normalizeSources("not-an-array"), []);
  });
});

describe("wide research — citations", () => {
  it("extracts urls from prose", () => {
    const found = extractCitations("see https://a.example/x and www.b.example/y. Also https://c.example/z?u=1,");
    assert.deepStrictEqual(found, ["https://a.example/x", "www.b.example/y", "https://c.example/z?u=1"]);
  });

  it("normalizes tracking noise away", () => {
    assert.strictEqual(
      normalizeCitation("https://WWW.Example.com/path/?utm_source=x&b=2&a=1#frag"),
      "https://example.com/path?a=1&b=2",
    );
    assert.strictEqual(normalizeCitation("https://example.com/"), "https://example.com");
  });

  it("dedupes citations that differ only by tracking parameters or host prefix", () => {
    const deduped = dedupeCitations([
      "https://example.com/post",
      "http://www.example.com/post",
      "https://example.com/post?utm_campaign=abc",
      "https://example.com/other",
    ]);
    assert.deepStrictEqual(deduped, ["https://example.com/post", "https://example.com/other"]);
  });

  it("keeps the first-seen form of a deduped citation", () => {
    assert.deepStrictEqual(dedupeCitations(["https://Example.com/Path", "https://example.com/Path"]), ["https://Example.com/Path"]);
  });

  it("does not merge citations whose paths differ", () => {
    assert.deepStrictEqual(dedupeCitations(["https://example.com/A", "https://example.com/a"]), [
      "https://example.com/A",
      "https://example.com/a",
    ]);
  });

  it("reads a structured child answer and falls back to plain text", () => {
    const structured = parseTaskResult('```json\n{"summary":"S","citations":["https://a.example"]}\n```');
    assert.strictEqual(structured.summary, "S");
    assert.deepStrictEqual(structured.citations, ["https://a.example"]);

    const plain = parseTaskResult("plain answer citing https://b.example/page");
    assert.strictEqual(plain.summary, "plain answer citing https://b.example/page");
    assert.deepStrictEqual(plain.citations, ["https://b.example/page"]);
  });

  it("extracts a balanced json object from noisy output", () => {
    const parsed = extractJsonObject('noise {"a":1} trailing');
    assert.deepStrictEqual(parsed, { a: 1 });
    assert.strictEqual(extractJsonObject("no json here"), null);
  });
});

describe("wide research — fan-out", () => {
  it("merges the child findings and dedupes the cited sources", async () => {
    const report = await runWideResearch({
      query: "how do compilers work",
      breadth: 3,
      dispatcher: mockDispatcher({
        general: { summary: "Compilers translate source to target code.", citations: ["https://a.example/1"] },
        recent: { summary: "Newer backends use SSA.", citations: ["https://a.example/1", "https://b.example/2"] },
        evidence: { summary: "Benchmarks show 2x speedups.", citations: ["https://c.example/3"] },
      }),
      synthesizer: noopSynthesizer,
    });

    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.completed, 3);
    assert.strictEqual(report.failed, 0);
    assert.deepStrictEqual(report.sources, ["https://a.example/1", "https://b.example/2", "https://c.example/3"]);
    assert.strictEqual(report.findings.length, 3);
    assert.strictEqual(report.summary, "merged(3 findings, 3 sources)");
  });

  it("keeps a failing child visible without losing the other findings", async () => {
    const dispatcher: WideResearchDispatcher = async (task) => {
      if (task.angleId === "recent") throw new Error("child exploded");
      return { summary: "ok", citations: ["https://a.example/1"] };
    };
    const report = await runWideResearch({
      query: "q",
      breadth: 3,
      dispatcher,
      synthesizer: noopSynthesizer,
    });

    assert.strictEqual(report.completed, 2);
    assert.strictEqual(report.failed, 1);
    assert.strictEqual(report.ok, true, "a partial result is still a usable result");
    const failed = report.tasks.find((t) => !t.ok);
    assert.ok(failed, "the failed sub-task is reported");
    assert.match(failed?.error ?? "", /child exploded/);
  });

  it("reports every child as failed when every child fails", async () => {
    const report = await runWideResearch({
      query: "q",
      breadth: 2,
      dispatcher: async () => {
        throw new Error("down");
      },
      synthesizer: noopSynthesizer,
    });
    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.completed, 0);
    assert.strictEqual(report.failed, 2);
    assert.match(report.summary, /No research sub-task/);
  });

  it("never runs more children at once than the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const dispatcher: WideResearchDispatcher = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { summary: "ok" };
    };
    await runWideResearch({ query: "q", breadth: 10, concurrency: 3, dispatcher, synthesizer: noopSynthesizer });
    assert.ok(peak <= 3, `peak concurrency ${peak} must stay within the limit`);
  });

  it("falls back to the deterministic merge when the synthesizer fails", async () => {
    const report = await runWideResearch({
      query: "q",
      breadth: 1,
      dispatcher: mockDispatcher({ general: { summary: "A fact. Another fact.", citations: ["https://a.example/1"] } }),
      synthesizer: async () => {
        throw new Error("model down");
      },
    });
    assert.match(report.summary, /Research summary for: q/);
    assert.match(report.summary, /A fact\./);
    assert.match(report.summary, /https:\/\/a\.example\/1/);
  });

  it("groups findings by their seed source", () => {
    const groups = groupFindingsBySource([
      { taskId: "wrt-1", index: 0, angle: "source review", question: "q", source: "https://a.example", summary: "s", citations: [] },
      { taskId: "wrt-2", index: 1, angle: "source review", question: "q", source: "https://a.example", summary: "t", citations: [] },
      { taskId: "wrt-3", index: 2, angle: "overview", question: "q", summary: "u", citations: [] },
    ]);
    assert.strictEqual(groups.get("https://a.example")?.length, 2);
    assert.strictEqual(groups.get("")?.length, 1);
  });

  it("produces a deterministic summary without a model", () => {
    const summary = deterministicSynthesis(
      "q",
      [{ taskId: "wrt-1", index: 0, angle: "overview", question: "q", summary: "First point. Second point.", citations: [] }],
      ["https://a.example/1"],
    );
    assert.match(summary, /- \[overview\] First point\./);
    assert.match(summary, /Cited sources \(1\)/);
  });
});

describe("wide research — child capability scope", () => {
  it("keeps only the requested, registered and run-allowed tools", () => {
    const parent = {
      names: () => ["web_search", "web_fetch", "file_read", "shell_run"],
    } as unknown as Parameters<typeof resolveChildAllowlist>[0];
    const allow = resolveChildAllowlist(parent, ["web_search", "web_fetch", "not_registered"], ["web_fetch", "file_read"]);
    assert.deepStrictEqual(allow, ["web_fetch"], "a child never gains a tool the run itself lacks");
  });

  it("falls back to the requested set when the run scope is unknown", () => {
    const parent = {
      names: () => ["web_search", "web_fetch"],
    } as unknown as Parameters<typeof resolveChildAllowlist>[0];
    assert.deepStrictEqual(resolveChildAllowlist(parent, ["web_search", "web_fetch"], undefined), ["web_search", "web_fetch"]);
  });
});

describe("wide research — prompts", () => {
  it("the child prompt carries the sub-question and the answer contract", () => {
    const task = planResearchTasks("why", [], 1)[0]!;
    const prompt = buildChildPrompt(task);
    assert.match(prompt, /why/);
    assert.match(prompt, /citations/);
  });

  it("the synthesis prompt carries every finding and its urls", () => {
    const prompt = buildSynthesisPrompt("q", [
      { taskId: "wrt-1", index: 0, angle: "overview", question: "q", summary: "S", citations: ["https://a.example/1"] },
    ]);
    assert.match(prompt, /QUESTION: q/);
    assert.match(prompt, /https:\/\/a\.example\/1/);
    assert.match(prompt, /S/);
  });
});

describe("wide research — the tool", () => {
  const stubRegistry = {
    names: () => ["web_search", "web_fetch"],
    forAllowlist: () => stubRegistry,
  } as unknown as Parameters<typeof createWideResearchTool>[0]["parentRegistry"];

  function toolWith(dispatcher: WideResearchDispatcher, synthesizer: WideResearchSynthesizer = noopSynthesizer) {
    return createWideResearchTool({
      ollama: {} as Parameters<typeof createWideResearchTool>[0]["ollama"],
      parentRegistry: stubRegistry,
      dispatcher,
      synthesizer,
    });
  }

  const ctx = {
    cfg: {} as never,
    workspace: "C:/tmp",
    emit: () => {
      /* silent */
    },
  } as unknown as ToolContext;

  it("is named wide_research and exposes the documented parameters", () => {
    const tool = toolWith(mockDispatcher({}));
    assert.strictEqual(tool.name, "wide_research");
    const schema = tool.parameters as { required?: string[]; properties?: Record<string, unknown> };
    assert.deepStrictEqual(schema.required, ["query"]);
    assert.ok(schema.properties?.["sources"], "the tool accepts seed sources");
    assert.ok(schema.properties?.["breadth"], "the tool accepts a breadth");
  });

  it("refuses an empty query", async () => {
    const result = await toolWith(mockDispatcher({})).run({ query: "  " }, ctx);
    assert.strictEqual(result.ok, false);
    assert.match(result.content, /requires a query/);
  });

  it("returns the merged report with deduplicated sources", async () => {
    const tool = toolWith(
      mockDispatcher({
        general: { summary: "Fact one.", citations: ["https://a.example/1"] },
        recent: { summary: "Fact two.", citations: ["https://a.example/1", "https://b.example/2"] },
      }),
    );
    const result = await tool.run({ query: "q", breadth: 2 }, ctx);
    assert.strictEqual(result.ok, true);
    const report = JSON.parse(result.content) as { summary: string; sources: string[]; findings: unknown[]; breadth: number };
    assert.strictEqual(report.breadth, 2);
    assert.strictEqual(report.findings.length, 2);
    assert.deepStrictEqual(report.sources, ["https://a.example/1", "https://b.example/2"]);
    assert.match(report.summary, /merged\(2 findings, 2 sources\)/);
  });

  it("clamps the breadth to the hard ceiling", async () => {
    const result = await toolWith(mockDispatcher({})).run({ query: "q", breadth: 999 }, ctx);
    const report = JSON.parse(result.content) as { breadth: number };
    assert.strictEqual(report.breadth, WIDE_RESEARCH_MAX_BREADTH);
  });

  it("turns each seed source into its own sub-task", async () => {
    const seen: string[] = [];
    const tool = toolWith(async (task) => {
      seen.push(task.source ?? "");
      return { summary: "ok" };
    });
    await tool.run({ query: "q", sources: ["https://a.example/1", "https://b.example/2"], breadth: 2 }, ctx);
    assert.deepStrictEqual(seen, ["https://a.example/1", "https://b.example/2"]);
  });
});
