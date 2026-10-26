/**
 * Unified SAST capability (ALL_SERVICES §7): opengrep pattern engine (pinned external,
 * driven through the audit scanner adapter) + a first-party taint pass that wraps the
 * existing TS/JS interprocedural source-flow engine + diff scoping (ccsr graft).
 * Everything lands as RawFinding[] through the normalize funnel. LLM triage is
 * advisory-only and off by default (agentgg graft).
 */
import type { RawFinding } from "../normalize/types.js";
import { traceSourceFlows } from "../source-flow.js";

const SINK_RULE: Record<string, string> = { sql_like: "taint-to-sql", html_like: "taint-to-html", command_like: "taint-to-command" };

/** Interprocedural taint pass: source-flow engine results → RawFinding[]. */
export function taintScan(root: string): { findings: RawFinding[]; coverage: { files: number; sanitized: number; bounded: boolean } } {
  const scan = traceSourceFlows(root);
  const findings: RawFinding[] = scan.flows.map((f) => ({
    engine: "sast",
    ruleId: SINK_RULE[f.sink.kind] ?? "taint-flow",
    severity: f.sink.kind === "command_like" || f.sink.kind === "sql_like" ? "high" : "medium",
    target: `${f.sink.file}:${f.sink.line}`,
    title: `Untrusted input reaches a ${f.sink.kind.replace("_like", "")} sink`,
    detail: `Flow ${f.source.what} → ${f.sink.what} across ${f.hops.length + 1} step(s); no sanitizer on the path.`,
    remediation: "Validate/encode the input at the boundary or sanitize before the sink.",
    properties: { dataflow: [f.source, ...f.hops, f.sink].map((h) => `${h.file}:${h.line} ${h.what}`), coverage: scan.coverage },
  }));
  return { findings, coverage: { files: scan.filesScanned, sanitized: scan.sanitized, bounded: scan.coverage.bounded } };
}

/** git-diff file scoping (ccsr graft): files changed between two refs. */
export function changedFiles(root: string, refRange: string): string[] {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const out = execFileSync("git", ["diff", "--name-only", refRange], { cwd: root, encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Advisory-only LLM triage (agentgg graft): annotates, never drops a hit. */
export async function llmTriage(
  hits: RawFinding[],
  classify: (hit: RawFinding) => Promise<{ verdict: "likely" | "unlikely" | "needs-review"; rationale: string }>,
): Promise<RawFinding[]> {
  return Promise.all(hits.map(async (h) => ({ ...h, properties: { ...h.properties, triage: await classify(h) } })));
}
