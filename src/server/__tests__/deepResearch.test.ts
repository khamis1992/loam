/**
 * deep_research tool tests: the plan -> search -> read -> gap-check loop runs
 * against a mocked globalThis.fetch, so web_search (DuckDuckGo HTML) and
 * web_fetch are both exercised without any network access.
 */
import assert from "node:assert";
import { describe, it, after } from "node:test";

import type { Tool, ToolContext } from "../../tools/registry.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDeepResearchTools, runDeepResearch } from "../../tools/deepResearch.js";
import { mergeAlwaysOnTools, ALWAYS_ON_TOOLS } from "../runTools.js";

const realFetch = globalThis.fetch;

type FetchCall = { url: string; body: string };
type FakeResponder = { match: (url: string) => boolean; body: string; status?: number };

let calls: FetchCall[] = [];
let responders: FakeResponder[] = [];

function fakeResponse(body: string, status = 200) {
  const bytes = new TextEncoder().encode(body);
  return {
    ok: status < 400,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
    arrayBuffer: async () => bytes.buffer,
  } as unknown as Response;
}

const SEARCH_HOST = "html.duckduckgo.com";
const TOPIC = "quantum gardening basics";

function seedResultsHtml(urls: string[]): string {
  const links = urls
    .map((url) => {
      const title = url.split("/").pop() || url;
      return `<a class="result__a" href="/html/?uddg=${encodeURIComponent(url)}">${title}</a>`;
    })
    .join("\n");
  return `<html><body>${links}<p>no-results placeholder</p></body></html>`;
}

// Install the fetch stub once for this file; each test resets `calls` and
// `responders`, and `after` restores the real fetch.
globalThis.fetch = (async (input: RequestInfo | URL | string): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  const responder = responders.find((r) => r.match(url));
  const body =
    responder?.body ??
    (new URL(url).hostname === SEARCH_HOST
      ? "<html><body></body></html>"
      : "<html><body><p>unrelated filler text</p></body></html>");
  calls.push({ url, body });
  return fakeResponse(body, responder?.status ?? 200);
}) as typeof fetch;

after(() => {
  globalThis.fetch = realFetch;
});

function fakeCtx(networkEnabled = true): ToolContext {
  return {
    cfg: { policy: { networkEnabled } } as unknown as ToolContext["cfg"],
    workspace: process.cwd(),
    emit: () => {},
  };
}

function resetFixtures() {
  calls = [];
  responders = [
    // Search results: the base topic query returns seed + cases; any query that
    // mentions the limits aspect returns the risks page instead.
    {
      match: (url) => url.includes(SEARCH_HOST) && url.includes("limitation"),
      body: seedResultsHtml(["https://papers.test/risk"]),
    },
    {
      match: (url) => url.includes(SEARCH_HOST),
      body: seedResultsHtml(["https://papers.test/seed", "https://papers.test/cases"]),
    },
    {
      match: (url) => url.startsWith("https://papers.test/seed"),
      body: `<html><body><p>Quantum gardening basics begin with an introduction: what is a seed.</p>
             <p>This guide explains how seeds work in frozen soil and dry weather science reports show how it works inside.</p></body></html>`,
    },
    {
      match: (url) => url.startsWith("https://papers.test/cases"),
      body: `<html><body><p>Season examples show use case rotations that gardeners practice in small quantum beds every year.</p></body></html>`,
    },
    {
      match: (url) => url.startsWith("https://papers.test/risk"),
      body: `<html><body><p>The main limitations of this quantum method include slow germination and heavy water risk in dry months.</p></body></html>`,
    },
  ];
}

const searchCalls = () => calls.filter((c) => c.url.includes(SEARCH_HOST));
const fetchCalls = () => calls.filter((c) => !c.url.includes(SEARCH_HOST));

describe("deep_research tool", () => {
  it("is an always-on tool name", () => {
    assert.ok(ALWAYS_ON_TOOLS.includes("deep_research"), "deep_research must be registered always-on");
  });

  it("the always-on merge exposes it to a build-mode run allowlist like index.ts does", () => {
    const registry = new ToolRegistry();
    registry.register({ name: "file_read", description: "", parameters: { type: "object", properties: {} }, async run() { return { ok: true, content: "" }; } } satisfies Tool);
    registry.registerAll(createDeepResearchTools());
    const runAllow = mergeAlwaysOnTools({
      resolvedAllow: ["file_read"],
      registeredTools: registry.names(),
      disabledTools: [],
    });
    const names = registry.forAllowlist(runAllow).names();
    assert.ok(names.includes("deep_research"), "effective run tool list must include deep_research");
    assert.ok(registry.forAllowlist(runAllow).toOllama().some((t) => t.function.name === "deep_research"), "the model function list must include deep_research");
  });

  it("loops plan, search, read and gap-check to a fully cited report", async () => {
    resetFixtures();
    const result = await runDeepResearch(TOPIC, 2, fakeCtx());
    assert.equal(result.ok, true, result.reason);
    // Iteration 1: one search for the topic; iteration 2: one gap query for the
    // uncovered "limits" aspect (seed/cases pages covered overview, how, examples).
    assert.equal(searchCalls().length, 2, `expected topic search + gap search, got ${searchCalls().map((c) => c.url)}`);
    assert.ok(decodeURIComponent(searchCalls()[1]!.url).includes("limitations"), "second search must target the gap aspect");
    assert.equal(result.iterations, 2);
    assert.equal(result.sourceCount, 3);
    assert.equal(result.coveredAspects.length, 4);
    assert.equal(result.uncoveredAspects.length, 0);
    assert.ok(fetchCalls().length >= 2, "must have read at least two pages");

    const report = result.report;
    assert.ok(report.includes(`# Deep Research: ${TOPIC}`));
    assert.ok(report.includes("## Summary"));
    assert.ok(report.includes("## Overview"));
    assert.ok(report.includes("## How It Works"));
    assert.ok(report.includes("## Examples and Practice"));
    assert.ok(report.includes("## Limitations and Risks"));
    assert.ok(!report.includes("## Gaps"), "no gap section when every aspect is covered");
    // Inline citations and the numbered sources list.
    assert.ok(report.includes(" [1]"), `citation [1] missing:\n${report}`);
    assert.ok(report.includes(" [2]"));
    assert.ok(report.includes(" [3]"));
    assert.ok(report.includes("## Sources"));
    assert.ok(report.includes("1. seed — https://papers.test/seed"));
    assert.ok(report.includes("3. risk — https://papers.test/risk"));
  });

  it("depth is honored and shallow depth skips gap rounds", async () => {
    resetFixtures();
    const result = await runDeepResearch(TOPIC, 1, fakeCtx());
    assert.equal(result.ok, true);
    assert.equal(searchCalls().length, 1);
    assert.equal(result.iterations, 1);
    assert.equal(result.uncoveredAspects.length, 1);
    assert.ok(result.report.includes("## Gaps"), "uncovered aspect must be declared honestly");
  });

  it("refuses to run when network is disabled", async () => {
    resetFixtures();
    const tool = createDeepResearchTools().find((t) => t.name === "deep_research")!;
    const res = await tool.run({ topic: "x" }, fakeCtx(false));
    assert.equal(res.ok, false);
    assert.ok(res.content.toLowerCase().includes("network"), res.content);
  });

  it("fails honestly when search returns nothing", async () => {
    resetFixtures();
    responders = [];
    const tool = createDeepResearchTools().find((t) => t.name === "deep_research")!;
    const res = await tool.run({ topic: "totally unknown widget topic" }, fakeCtx(true));
    assert.equal(res.ok, false);
    assert.ok(res.content.includes("No sources"), res.content);
  });

  it("validates the topic argument", async () => {
    resetFixtures();
    calls = [];
    responders = [];
    const tool = createDeepResearchTools().find((t) => t.name === "deep_research")!;
    const empty = await tool.run({ topic: "   " }, fakeCtx(true));
    assert.equal(empty.ok, false);
    const long = await tool.run({ topic: "a".repeat(2001) }, fakeCtx(true));
    assert.equal(long.ok, false);
    assert.equal(searchCalls().length, 0, "no fetches for invalid input");
  });
});
