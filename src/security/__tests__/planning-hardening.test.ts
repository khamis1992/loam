/**
 * Hardening regressions for the self-planning / taint model.
 *
 * Covers the review fixes: ranked taint hints must lead the suggestion list and
 * survive the suggestion cap; multi-hop flow conversion must dedupe on the
 * (source, sink) pair; and the analysis scan bound must not truncate sinks in
 * source-iteration order before ranking.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyzeTaint,
  buildPlan,
  makeGraph,
  planTaintHints,
  taintHintsSourceSpec,
  type PlannerHint,
  type TaintSinkSpec,
  type TaintSourceSpec,
} from "../planning.js";
import type { FlowScan, SourceFlow } from "../source-flow.js";

describe("planning hardening: suggestion budget", () => {
  it("prepends taint hints and keeps them when page/operation evidence fills the cap", () => {
    const pages = Array.from({ length: 20 }, (_, i) => ({ url: `http://x/p${i}` }));
    const operations = Array.from({ length: 30 }, (_, i) => ({ path: `/o${i}`, method: "GET", urls: [`http://x/o${i}`] }));
    const hint: PlannerHint = {
      id: "taint:k:exec",
      rank: 1,
      score: 999,
      engine: "command",
      surface: "source",
      sourceKind: "body",
      sinkKind: "exec",
      source: "req.body.cmd@a.js:1",
      target: "exec@b.js:2",
      path: ["req.body.cmd@a.js:1", "exec@b.js:2"],
      hops: 1,
      severity: "critical",
      confidence: "derived",
      rationale: "tainted body reaches exec",
      operatorInput: "declare the command engine case",
      execution: "none",
    };

    const plan = buildPlan({ discovery: { pages }, openapiPlan: { operations }, taintHints: [hint] });
    assert.equal(plan.suggestions.length, 50, "the suggestion cap still holds");
    assert.equal(plan.suggestions[0]!.engine, "command", "the strongest taint hint leads the list");
    assert.ok(plan.suggestions.some((s) => s.target === "exec@b.js:2"), "the hint is not crowded out by page/op evidence");
    assert.equal(plan.hints.length, 1);
  });
});

describe("planning hardening: flow conversion dedupe", () => {
  const flow: SourceFlow = {
    source: { file: "a.js", line: 1, what: "req.body.x" },
    hops: [{ file: "b.js", line: 2, what: "carry" }],
    sink: { file: "c.js", line: 3, what: "exec(x)", kind: "command_like" },
  };

  it("collapses duplicate multi-hop flows for the same source and sink", () => {
    const scan: FlowScan = {
      filesScanned: 3,
      importsResolved: 0,
      sanitized: 0,
      guardCuts: 0,
      coverage: { bounded: false, parseErrors: 0, unsupported: 0, depthLimit: 0 },
      flows: [flow, { ...flow }],
    };
    const spec = taintHintsSourceSpec(scan);
    assert.equal(spec.sources.length, 1, "one source per (source, sink) pair");
    assert.equal(spec.sinks.length, 1, "one sink per (source, sink) pair");
    assert.equal(spec.edges.length, 2, "one carrier chain, not two parallel chains");
  });
});

describe("planning hardening: ranking sees every reachable sink", () => {
  it("does not truncate later-source sinks before ranking", () => {
    const sources: TaintSourceSpec[] = [
      { id: "s1", name: "src1", kind: "user_input", location: "a.js:1" },
      { id: "s2", name: "src2", kind: "user_input", location: "b.js:1" },
    ];
    // 55 sinks: the first 50 are reached by s1, the last 5 (including the
    // critical exec sink) only by s2.
    const sinks: TaintSinkSpec[] = Array.from({ length: 55 }, (_, i) => ({
      id: `k${i}`,
      name: `sink${i}`,
      kind: i === 50 ? "exec" : "query",
      location: `s${i}.js:1`,
    }));
    const edges = [
      ...Array.from({ length: 50 }, (_, i) => ({ from: "s1", to: `k${i}` })),
      ...Array.from({ length: 5 }, (_, i) => ({ from: "s2", to: `k${50 + i}` })),
    ];
    const graph = makeGraph({ sources, sinks, edges });

    const result = analyzeTaint(graph);
    assert.equal(result.sinksReached, 55, "every reachable sink is analyzed before the top-N selection");

    const hints = planTaintHints(graph);
    assert.equal(hints.length, 50);
    assert.equal(hints[0]!.sinkKind, "exec", "the critical sink reached by the later source is ranked first");
    assert.equal(hints[0]!.severity, "critical");
  });
});
