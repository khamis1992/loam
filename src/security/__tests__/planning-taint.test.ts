import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  analyzeTaint,
  buildPlan,
  makeGraph,
  planTaintHints,
  taintPlanSuggestions,
  type PlanEvidence,
  type TaintGraphSpec,
} from "../planning.js";

// Unit coverage for the source-to-sink taint model wired into the planner.
// Each case builds a small structured call/data graph and asserts the tainted
// paths, the sanitizer/guard cuts, the ranking, and the plan wiring.

function spec(overrides: Partial<TaintGraphSpec> = {}): TaintGraphSpec {
  return {
    sources: [{ id: "s1", name: "req.query.id", kind: "user_input", location: "routes/users.js:12" }],
    sinks: [
      { id: "k1", name: "db.query", kind: "query", location: "db.js:8" },
      { id: "k2", name: "fs.readFile", kind: "fs", location: "files.js:3" },
      { id: "k3", name: "exec", kind: "exec", location: "shell.js:5" },
    ],
    nodes: [{ id: "f1", name: "lookupUser", location: "users.js:20" }],
    edges: [
      { from: "s1", to: "f1", label: "lookupUser(id)" },
      { from: "f1", to: "k1", label: "db.query(sql)" },
      { from: "s1", to: "k2", sanitized: true },
      { from: "f1", to: "k3", guarded: true },
    ],
    ...overrides,
  };
}

describe("source-to-sink taint planning", () => {
  it("flags a known user_input -> query sink path and cuts sanitized/guarded branches", () => {
    const graph = makeGraph(spec());
    const result = analyzeTaint(graph);

    assert.equal(result.sources, 1);
    assert.equal(result.sinks, 3);
    assert.equal(result.sinksReached, 1, "only the unsanitized, unguarded sink is reached");
    assert.equal(result.sanitizedEdges, 1);
    assert.equal(result.guardedEdges, 1);

    const flow = result.flows[0]!;
    assert.equal(flow.source.id, "s1");
    assert.equal(flow.sink.id, "k1");
    assert.equal(flow.hops, 2);
    assert.deepEqual(flow.path.map(hop => hop.id), ["s1", "f1", "k1"]);
    assert.equal(flow.path[1]!.edge, "lookupUser(id)");
    assert.equal(flow.path[2]!.edge, "db.query(sql)");

    const hints = planTaintHints(graph);
    assert.equal(hints.length, 1);
    const hint = hints[0]!;
    assert.equal(hint.rank, 1);
    assert.equal(hint.engine, "injection");
    assert.equal(hint.sinkKind, "query");
    assert.equal(hint.sourceKind, "user_input");
    assert.equal(hint.severity, "high");
    assert.equal(hint.confidence, "inferred");
    assert.equal(hint.execution, "none");
    assert.ok(hint.path.includes("req.query.id@routes/users.js:12"));
    assert.ok(hint.path.includes("db.query@db.js:8"));
    assert.ok(hint.rationale.includes("user input"));
    assert.ok(hint.operatorInput.length > 10);
  });

  it("ranks an exec sink above a query sink and wires hints into buildPlan", () => {
    const graph = makeGraph(spec({
      edges: [
        { from: "s1", to: "f1" },
        { from: "f1", to: "k1" },
        { from: "s1", to: "k3" },
      ],
    }));
    const hints = planTaintHints(graph);
    assert.equal(hints.length, 2);
    assert.equal(hints[0]!.engine, "command");
    assert.equal(hints[0]!.sinkKind, "exec");
    assert.equal(hints[0]!.severity, "critical");
    assert.equal(hints[1]!.engine, "injection");
    assert.ok(hints[0]!.score > hints[1]!.score);

    const suggestions = taintPlanSuggestions(hints);
    assert.equal(suggestions.length, 2);
    assert.equal(suggestions[0]!.engine, "command");
    assert.equal(suggestions[0]!.surface, "source");

    const plan = buildPlan({ taintHints: hints } as PlanEvidence);
    assert.equal(plan.hints.length, 2);
    assert.equal(plan.execution, "none");
    assert.ok(plan.suggestions.some(s => s.engine === "command"));
    assert.ok(plan.limitations.some(l => l.includes("Taint hints")));
  });

  it("reports no sink when every path is sanitized or guarded", () => {
    const graph = makeGraph(spec({
      edges: [
        { from: "s1", to: "f1", sanitized: true },
        { from: "f1", to: "k1", guarded: true },
        { from: "s1", to: "k2", sanitized: true },
      ],
    }));
    const result = analyzeTaint(graph);
    assert.equal(result.sinksReached, 0);
    assert.equal(planTaintHints(graph).length, 0);
  });

  it("keeps the shortest, highest-trust path when several sources reach one sink", () => {
    const graph = makeGraph(spec({
      sources: [
        { id: "s1", name: "req.query.id", kind: "user_input", location: "routes/users.js:12" },
        { id: "s2", name: "req.header.x", kind: "header", location: "routes/users.js:13" },
      ],
      nodes: [
        { id: "f1", name: "lookupUser", location: "users.js:20" },
        { id: "f2", name: "lookupByHeader", location: "users.js:30" },
      ],
      edges: [
        { from: "s1", to: "f1" },
        { from: "f1", to: "f2" },
        { from: "f2", to: "k1" },
        { from: "s2", to: "k1" },
      ],
    }));
    const result = analyzeTaint(graph);
    assert.equal(result.sinksReached, 1);
    const flow = result.flows[0]!;
    assert.equal(flow.source.id, "s2", "the direct header path is shorter than the two-hop user_input path");
    assert.equal(flow.hops, 1);
    const hints = planTaintHints(graph);
    assert.equal(hints[0]!.confidence, "derived");
  });
});
