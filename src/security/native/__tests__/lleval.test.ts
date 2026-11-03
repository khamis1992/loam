import { strict as assert } from "node:assert";
import { test } from "node:test";
import { combineResults, extractJson, runAssertion } from "../lleval/assertions.js";
import { expandVars, MAX_VAR_COMBINATIONS } from "../lleval/vars.js";
import { renderTemplate } from "../lleval/render.js";
import { gradeWithRubric } from "../lleval/rubric.js";
import { evaluateSuite, strictJsonAsserts, toJsonl } from "../lleval/evaluate.js";
import type { ChatFn } from "../lleval/rubric.js";

const out = (output: string, latencyMs = 10) => ({ output, latencyMs });

test("deterministic assertions", () => {
  assert.equal(runAssertion({ type: "equals", value: "hi" }, out("hi")).pass, true);
  assert.equal(runAssertion({ type: "equals", value: "hi" }, out("hi ")).pass, false);
  assert.equal(runAssertion({ type: "icase", value: "ERR" }, out("error")).pass, true);
  assert.equal(runAssertion({ type: "not-contains", value: "secret" }, out("all clear here")).pass, true);
  assert.equal(runAssertion({ type: "starts-with", value: "{" }, out("{}")).pass, true);
  assert.equal(runAssertion({ type: "regex", pattern: "^\\d+$" }, out("42")).pass, true);
  assert.equal(runAssertion({ type: "regex", pattern: "(" }, out("x")).pass, false);
  assert.equal(runAssertion({ type: "latency", thresholdMs: 5 }, out("x", 6)).pass, false);
  assert.equal(runAssertion({ type: "javascript", code: "return output.includes('ok');" }, out("ok")).pass, true);
  assert.deepEqual(runAssertion({ type: "javascript", code: "return { pass: output === 'a', reason: 'custom' };" }, out("b")).reason, "custom");
});

test("is-json is strict, contains-json tolerates fences and prose", () => {
  assert.equal(runAssertion({ type: "is-json" }, out('{"a":1}')).pass, true);
  assert.equal(runAssertion({ type: "is-json" }, out('```json\n{"a":1}\n```')).pass, false);
  assert.equal(runAssertion({ type: "is-json" }, out("not json")).pass, false);
  assert.equal(runAssertion({ type: "contains-json" }, out('sure: {"a":1}')).pass, true);
});

test("extractJson finds the first balanced value", () => {
  assert.deepEqual(extractJson('noise {"a":{"b":1}} tail'), { a: { b: 1 } });
  assert.deepEqual(extractJson('```json\n[1,2]\n```'), [1, 2]);
  assert.equal(extractJson('{"a":'), undefined);
});

test("expandVars cartesian product with a cap", () => {
  assert.deepEqual(expandVars({}), [{}]);
  assert.deepEqual(expandVars({ a: ["1", "2"], b: ["x"] }), [{ a: "1", b: "x" }, { a: "2", b: "x" }]);
  assert.equal(expandVars({ a: Array.from({ length: 30 }, (_, i) => String(i)), b: Array.from({ length: 30 }, (_, i) => String(i)) }).length, MAX_VAR_COMBINATIONS);
});

test("renderTemplate substitutes and keeps unknown placeholders visible", () => {
  assert.equal(renderTemplate("hi {{name}} and {{ name }}", { name: "z" }), "hi z and z");
  assert.equal(renderTemplate("hi {{missing}}", {}), "hi {{missing}}");
});

test("combineResults aggregates failures", () => {
  const ok = runAssertion({ type: "equals", value: "x" }, out("x"));
  const bad = runAssertion({ type: "equals", value: "y" }, out("x"));
  const c = combineResults([ok, bad]);
  assert.equal(c.pass, false);
  assert.equal(c.score, 0.5);
  assert.ok(c.reason.length > 0);
});

test("llm-rubric grading through an injectable chat model", async () => {
  const good: ChatFn = async () => '{"pass":true,"score":9,"reason":"covers the rubric"}';
  const r = await gradeWithRubric("is concise", "short answer", good);
  assert.equal(r.pass, true);
  assert.equal(r.score, 0.9);
  const prose: ChatFn = async () => "I think it is fine.";
  assert.equal((await gradeWithRubric("r", "o", prose)).pass, false);
  const outOfRange: ChatFn = async () => '{"pass":true,"score":99}';
  assert.equal((await gradeWithRubric("r", "o", outOfRange)).pass, false);
  const strictThreshold: ChatFn = async () => '{"score":6}';
  assert.equal((await gradeWithRubric("r", "o", strictThreshold, 7)).pass, false);
});

test("evaluateSuite renders vars, calls once per case and summarizes", async () => {
  const calls: string[] = [];
  const suite = {
    name: "t",
    prompts: ["Say {{word}}"],
    vars: { word: ["a", "b"] },
    tests: [{ assert: [{ type: "is-json" as const }, ...strictJsonAsserts()] }],
  };
  const call = async (p: string) => {
    calls.push(p);
    return p.endsWith("a") ? { output: '{"ok":true}', latencyMs: 5 } : { output: "I think: not json", latencyMs: 7 };
  };
  const r = await evaluateSuite(suite, call);
  assert.deepEqual(calls, ["Say a", "Say b"]);
  assert.equal(r.total, 2);
  assert.equal(r.passed, 1);
  assert.equal(r.passRate, 0.5);
  assert.equal(r.avgLatencyMs, 6);
  assert.equal(toJsonl(r).split("\n").length, 2);
});

test("evaluateSuite records a failed model call instead of crashing", async () => {
  const r = await evaluateSuite({ name: "t", prompts: ["p"], tests: [{ assert: [{ type: "equals", value: "x" }] }] },
    async () => { throw new Error("backend down"); });
  assert.equal(r.total, 1);
  assert.equal(r.passed, 0);
  assert.ok(r.cases[0]!.output.startsWith("__call_failed__"));
});
