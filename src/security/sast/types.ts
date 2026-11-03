import type { RawFinding, RawSeverity } from "../normalize/types.js";

export interface SastRule {
  id: string;
  languages: Array<"ts" | "js" | "py" | "go" | "java" | "generic">;
  /** Opengrep/semgrep-compatible pattern string (Loam-authored). */
  pattern: string;
  message: string;
  severity: RawSeverity;
  owasp?: string;
  cwe?: string;
  /** When true, only run on files matching these globs. */
  paths?: string[];
}

export interface TaintSpec {
  language: "ts" | "js" | "py";
  sources: string[];
  sinks: string[];
  sanitizers: string[];
}

export interface SastHit extends RawFinding {
  dataflow?: Array<{ file: string; line: number; what: string }>;
  triage?: { verdict: "likely" | "unlikely" | "needs-review"; rationale: string };
}

export interface SastScanOptions {
  path: string;
  /** e.g. "HEAD~1..HEAD" — when set, only changed files (ccsr graft). */
  diff?: string;
  taint?: boolean;
  llmTriage?: boolean;
  /** Injected for tests: skip spawning opengrep. */
  patternHits?: SastHit[];
  /** Injected for tests: skip taint engine. */
  taintHits?: SastHit[];
  classify?: (hit: SastHit) => Promise<{ verdict: "likely" | "unlikely" | "needs-review"; rationale: string }>;
}

export interface SastScanResult {
  hits: SastHit[];
  filesScanned: number;
  engines: { opengrep: boolean; taint: boolean; pii: boolean; llmTriage: boolean };
  errors: string[];
}
