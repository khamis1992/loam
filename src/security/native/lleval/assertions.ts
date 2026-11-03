/**
 * Deterministic assertion handlers for prompt evaluation. Every handler returns
 * {pass, score, reason}, the same contract the model-graded rubric uses, so
 * suites mix deterministic and judged checks freely.
 */
export interface AssertionResult { pass: boolean; score: number; reason: string }

export type SimpleTextType = "equals" | "contains" | "not-contains" | "icase" | "starts-with";
export type Assertion =
  | { type: SimpleTextType; value: string }
  | { type: "regex"; pattern: string }
  | { type: "is-json" }
  | { type: "contains-json" }
  | { type: "latency"; thresholdMs: number }
  | { type: "javascript"; code: string }
  | { type: "llm-rubric"; value: string; threshold?: number };

export interface ModelOutput { output: string; latencyMs: number }

const PASS: AssertionResult = { pass: true, score: 1, reason: "" };
const fail = (reason: string): AssertionResult => ({ pass: false, score: 0, reason });

/** First balanced JSON value inside `text`, tolerating a markdown fence around it. */
export function extractJson(text: string): unknown | undefined {
  const stripped = text.replace(/```[a-z]*\r?\n?/gi, "");
  const start = stripped.search(/[[{]/);
  if (start === -1) return undefined;
  const open = stripped[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < stripped.length; i++) {
    const c = stripped[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) {
      try { return JSON.parse(stripped.slice(start, i + 1)); } catch { return undefined; }
    }
  }
  return undefined;
}

export function runAssertion(a: Assertion, out: ModelOutput): AssertionResult {
  const text = out.output;
  switch (a.type) {
    case "equals":
      return text === a.value ? PASS : fail(`output does not equal the expected string`);
    case "contains":
      return text.includes(a.value) ? PASS : fail(`output does not contain "${a.value.slice(0, 60)}"`);
    case "not-contains":
      return text.includes(a.value) ? fail(`output contains "${a.value.slice(0, 60)}"`) : PASS;
    case "icase":
      return text.toLowerCase().includes(a.value.toLowerCase()) ? PASS : fail(`output does not contain (case-insensitive) "${a.value.slice(0, 60)}"`);
    case "starts-with":
      return text.startsWith(a.value) ? PASS : fail(`output does not start with "${a.value.slice(0, 60)}"`);
    case "regex":
      try {
        return new RegExp(a.pattern, "m").test(text) ? PASS : fail(`output does not match /${a.pattern.slice(0, 60)}/`);
      } catch {
        return fail(`invalid regex /${a.pattern.slice(0, 60)}/`);
      }
    case "is-json": {
      const trimmed = text.trim();
      if (!/^[[{]/.test(trimmed)) return fail("output is not bare JSON (prose or fence around it)");
      return extractJson(trimmed) !== undefined ? PASS : fail("output does not parse as JSON");
    }
    case "contains-json":
      return extractJson(text) !== undefined ? PASS : fail("no JSON value found in the output");
    case "latency":
      return out.latencyMs <= a.thresholdMs ? PASS : fail(`latency ${out.latencyMs}ms above ${a.thresholdMs}ms`);
    case "llm-rubric":
      return fail("llm-rubric needs the grader; evaluateSuite dispatches it to gradeWithRubric");
    case "javascript": {
      // Suites are authored locally like tests; the code sees (output, latencyMs).
      try {
        const fn = new Function("output", "latencyMs", `"use strict";\n${a.code}`) as (o: string, l: number) => unknown;
        const r = fn(text, out.latencyMs);
        if (r === true) return PASS;
        if (r === false) return fail("script assertion returned false");
        if (r && typeof r === "object" && "pass" in r) {
          const j = r as { pass: boolean; score?: number; reason?: string };
          return { pass: !!j.pass, score: typeof j.score === "number" ? j.score : j.pass ? 1 : 0, reason: j.reason ?? "" };
        }
        return fail(`script assertion returned ${String(r).slice(0, 60)}`);
      } catch (e) {
        return fail(`script assertion threw: ${String(e).slice(0, 120)}`);
      }
    }
    default:
      return fail(`unknown assertion type`);
  }
}

/** Mean score across results, 1 when everything passes even with zero-score reasons. */
export function combineResults(rs: AssertionResult[]): AssertionResult {
  if (rs.length === 0) return PASS;
  const pass = rs.every((r) => r.pass);
  const score = pass ? 1 : rs.reduce((s, r) => s + r.score, 0) / rs.length;
  const failed = rs.filter((r) => !r.pass);
  return { pass, score, reason: failed.map((f) => f.reason).join("; ").slice(0, 300) };
}
