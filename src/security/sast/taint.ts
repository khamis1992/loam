import type { SastHit } from "./types.js";
import { TAINT_SPECS } from "./rules/loam-pack.js";

export interface TaintHop { file: string; line: number; what: string }
export interface TaintFlow {
  source: TaintHop;
  sink: TaintHop & { kind: string };
  hops: TaintHop[];
}

/**
 * Rebuilt interprocedural taint pass (codeql technique — not the CodeQL CLI).
 * In production, wraps Loam's existing `traceSourceFlows` (OBSERVED
 * src/security/source-flow.ts). Scratch uses an injectable analyzer.
 */
export function taintPass(
  root: string,
  analyze: (root: string) => TaintFlow[] = () => [],
): SastHit[] {
  void TAINT_SPECS; // specs guide the production analyzer configuration
  const flows = analyze(root);
  const SINK_RULE: Record<string, string> = {
    sql_like: "taint-to-sql",
    html_like: "taint-to-html",
    command_like: "taint-to-command",
    path_like: "taint-to-path",
  };
  return flows.map((f) => ({
    engine: "sast" as const,
    ruleId: SINK_RULE[f.sink.kind] ?? "taint-flow",
    severity: (f.sink.kind === "command_like" || f.sink.kind === "sql_like" ? "high" : "medium") as SastHit["severity"],
    target: `${f.sink.file}:${f.sink.line}`,
    title: `Untrusted input reaches a ${f.sink.kind.replace("_like", "")} sink`,
    detail: `Flow ${f.source.what} → ${f.sink.what} across ${f.hops.length + 1} step(s); no sanitizer on the path.`,
    remediation: "Validate/encode at the boundary or sanitize before the sink.",
    dataflow: [f.source, ...f.hops, f.sink],
    properties: { source: "taint-pass" },
  }));
}

/** PII / sensitive-data flow (bearer technique rebuilt — no Elastic binary). */
export function piiFlowPass(
  files: Array<{ path: string; text: string }>,
): SastHit[] {
  const PII = [
    { id: "pii.ssn", re: /\b\d{3}-\d{2}-\d{4}\b/, title: "Possible US SSN in source" },
    { id: "pii.email-hardcoded", re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i, title: "Hardcoded email address" },
    { id: "pii.pan", re: /\b4\d{3}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/, title: "Possible payment card number" },
  ];
  const hits: SastHit[] = [];
  for (const f of files) {
    const lines = f.text.split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const p of PII) {
        if (!p.re.test(line)) continue;
        // skip obvious test fixtures
        if (/fixture|example\.com|4111\s*1111/i.test(line)) continue;
        hits.push({
          engine: "sast",
          ruleId: p.id,
          severity: "medium",
          target: `${f.path}:${i + 1}`,
          title: p.title,
          detail: line.trim().slice(0, 160),
          remediation: "Remove secrets/PII from source; load from a vault at runtime.",
          properties: { source: "pii-flow" },
        });
        break;
      }
    });
  }
  return hits;
}
