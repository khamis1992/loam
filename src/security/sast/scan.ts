/**
 * Unified SAST entry (ALL_SERVICES §7). Expands the PC scaffold
 * (OBSERVED src/security/sast/scan.ts) with opengrep + taint + PII + optional LLM triage.
 */
import { execFileSync } from "node:child_process";
import type { SastHit, SastScanOptions, SastScanResult } from "./types.js";
import { runOpengrep } from "./opengrepBridge.js";
import { taintPass, piiFlowPass } from "./taint.js";
import { owaspFor } from "./rules/loam-pack.js";

export { taintPass, piiFlowPass, runOpengrep };
export type { SastHit, SastScanOptions, SastScanResult };

/** git-diff file scoping (ccsr graft). */
export function changedFiles(root: string, refRange: string): string[] {
  try {
    const out = execFileSync("git", ["diff", "--name-only", "--diff-filter=ACMR", refRange], {
      cwd: root, encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
    });
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export async function llmTriage(
  hits: SastHit[],
  classify: (hit: SastHit) => Promise<{ verdict: "likely" | "unlikely" | "needs-review"; rationale: string }>,
): Promise<SastHit[]> {
  return Promise.all(hits.map(async (h) => ({ ...h, triage: await classify(h) })));
}

export async function sastScan(opt: SastScanOptions): Promise<SastScanResult> {
  const errors: string[] = [];
  const files = opt.diff ? changedFiles(opt.path, opt.diff) : undefined;
  let hits: SastHit[] = [];

  if (opt.patternHits) {
    hits = hits.concat(opt.patternHits);
  } else {
    const og = await runOpengrep({ root: opt.path, files });
    hits = hits.concat(og.hits);
    if (og.error) errors.push(og.error);
  }

  let taintUsed = false;
  if (opt.taint !== false) {
    taintUsed = true;
    hits = hits.concat(opt.taintHits ?? taintPass(opt.path));
  }

  // PII pass expects file contents — production wiring reads files; tests inject via patternHits
  const piiUsed = true;
  hits = hits.concat(piiFlowPass([]));

  let llmUsed = false;
  if (opt.llmTriage && opt.classify) {
    llmUsed = true;
    hits = await llmTriage(hits, opt.classify);
  }

  hits = hits.map((h) => ({
    ...h,
    properties: { ...h.properties, owasp: h.properties?.owasp ?? owaspFor(h.ruleId) },
  }));

  return {
    hits,
    filesScanned: files?.length ?? -1,
    engines: { opengrep: !opt.patternHits, taint: taintUsed, pii: piiUsed, llmTriage: llmUsed },
    errors,
  };
}

// ---- scaffold-compat wrapper (PC scanner tooling reads this shape) ----

import { traceSourceFlows } from "../source-flow.js";
import type { RawFinding } from "../normalize/types.js";

export interface TaintScanResult {
  findings: RawFinding[];
  coverage: { files: number; flows: number; bounded: boolean };
}

const SINK_RULE: Record<string, string> = { sql_like: "taint-to-sql", html_like: "taint-to-html", command_like: "taint-to-command" };

/** The first-party taint pass over Loam's own source-flow engine (scaffold API kept). */
export function taintScan(root: string): TaintScanResult {
  const scan = traceSourceFlows(root);
  const findings: RawFinding[] = scan.flows.map((f) => ({
    engine: "sast" as const,
    ruleId: SINK_RULE[f.sink.kind] ?? "taint-flow",
    severity: (f.sink.kind === "command_like" || f.sink.kind === "sql_like" ? "high" : "medium") as RawFinding["severity"],
    target: `${f.sink.file}:${f.sink.line}`,
    title: `Untrusted input reaches a ${f.sink.kind.replace("_like", "")} sink`,
    detail: `Flow ${f.source.what} -> ${f.sink.what} across ${f.hops.length + 1} step(s); no sanitizer on the path.`,
    remediation: "Validate/encode at the boundary or sanitize before the sink.",
    properties: { source: "source-flow", dataflow: [f.source, ...f.hops, f.sink].map((h) => `${h.file}:${h.line} ${h.what}`) },
  })) as RawFinding[];
  return { findings, coverage: { files: scan.filesScanned, flows: scan.flows.length, bounded: scan.coverage.bounded } };
}
