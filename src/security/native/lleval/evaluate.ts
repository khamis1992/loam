/**
 * Suite evaluation: prompts x test cases (with expanded vars) -> one call per
 * case -> assertions -> results. The model call is injectable so tests and CI
 * need no network, and the same suite runs against any backend.
 */
import { combineResults, runAssertion } from "./assertions.js";
import type { Assertion, AssertionResult } from "./assertions.js";
import { gradeWithRubric } from "./rubric.js";
import type { ChatFn } from "./rubric.js";
import { renderTemplate } from "./render.js";
import { expandVars } from "./vars.js";

export type CallFn = (prompt: string) => Promise<{ output: string; latencyMs: number }>;

export interface TestCase {
  /** Extra bindings merged over the suite vars for this case. */
  vars?: Record<string, string>;
  assert: Assertion[];
  description?: string;
}

export interface EvalSuite {
  name: string;
  /** Prompt templates; each runs against every case with vars expanded. */
  prompts: string[];
  vars?: Record<string, readonly string[]>;
  tests: TestCase[];
}

export interface CaseResult {
  suite: string;
  promptIndex: number;
  description: string;
  prompt: string;
  output: string;
  latencyMs: number;
  assertions: { type: string; pass: boolean; score: number; reason: string }[];
  pass: boolean;
  score: number;
  reason: string;
}

export interface SuiteResult {
  name: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  avgLatencyMs: number;
  cases: CaseResult[];
}

async function runAsserts(
  asserts: Assertion[],
  out: { output: string; latencyMs: number },
  grade?: ChatFn,
): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];
  for (const a of asserts) {
    results.push(a.type === "llm-rubric" && grade
      ? await gradeWithRubric(a.value, out.output, grade, a.threshold)
      : runAssertion(a, out));
  }
  return results;
}

export async function evaluateSuite(suite: EvalSuite, call: CallFn, grade?: ChatFn): Promise<SuiteResult> {
  const combos = expandVars(suite.vars ?? {});
  const cases: CaseResult[] = [];
  for (const prompt of suite.prompts) {
    for (const combo of combos) {
      for (const t of suite.tests) {
        const vars = { ...combo, ...t.vars };
        const rendered = renderTemplate(prompt, vars);
        let out: { output: string; latencyMs: number };
        try {
          out = await call(rendered);
        } catch (e) {
          out = { output: `__call_failed__: ${String(e).slice(0, 200)}`, latencyMs: 0 };
        }
        const assertions = (await runAsserts(t.assert, out, grade))
          .map((r, i) => ({ type: t.assert[i]!.type, ...r }));
        const combined = combineResults(assertions);
        cases.push({
          suite: suite.name, promptIndex: suite.prompts.indexOf(prompt),
          description: t.description ?? "", prompt: rendered, output: out.output.slice(0, 2000),
          latencyMs: out.latencyMs, assertions, ...combined,
        });
      }
    }
  }
  const passed = cases.filter((c) => c.pass).length;
  return {
    name: suite.name, total: cases.length, passed, failed: cases.length - passed,
    passRate: cases.length ? passed / cases.length : 1,
    avgLatencyMs: cases.length ? Math.round(cases.reduce((s, c) => s + c.latencyMs, 0) / cases.length) : 0,
    cases,
  };
}

export function toJsonl(r: SuiteResult): string {
  return r.cases.map((c) => JSON.stringify({
    suite: c.suite, promptIndex: c.promptIndex, description: c.description,
    pass: c.pass, score: c.score, latencyMs: c.latencyMs, reason: c.reason, prompt: c.prompt, output: c.output,
  })).join("\n");
}

/** Standard guard for audit-role models: exactly one JSON object, no fence, no prose. */
export function strictJsonAsserts(): Assertion[] {
  return [{ type: "is-json" }, { type: "not-contains", value: "```" }];
}
