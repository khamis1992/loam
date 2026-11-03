/**
 * Reverse-engineering core types (ALL_SERVICES §14). Evidence-first: every claim
 * carries an evidence record whose id is sha256(content) — the REA convention,
 * aligned with the security store's EV#### ids.
 */
import { createHash } from "node:crypto";
import type { RawFinding } from "../security/normalize/types.js";

export interface ReEvidence {
  id: string; // ev_ + sha256 of the artifact slice
  kind: "magic" | "strings" | "entropy" | "section" | "header" | "diff" | "rebuild" | "engine";
  artifact: string;
  note: string;
}

export type ReFinding = RawFinding & { engine: "re"; evidence: ReEvidence[] };

export interface RebuildVerify {
  original: string;
  rebuilt: string;
  matchPct: number;
  verdict: "match" | "partial" | "mismatch";
  evidence: ReEvidence;
}

export const evidenceOf = (kind: ReEvidence["kind"], artifact: string, note: string): ReEvidence => ({
  id: `ev_${createHash("sha256").update(`${kind}\n${artifact}\n${note}`).digest("hex").slice(0, 32)}`,
  kind, artifact: artifact.slice(0, 200), note: note.slice(0, 300),
});

// ---- Cap B (MISSING §5) allowlist/budget types ----

export type ReToolName =
  | "analyze_javascript_application"
  | "analyze_web_bundle"
  | "inspect_asar_archive"
  | "list_asar_entries"
  | "extract_asar_entry"
  | "inspect_web_network_capture"
  | "summarize_evidence_bundle"
  | "export_evidence_bundle"
  | "import_evidence_bundle"
  | "verify_evidence_digest"
  | "get_tool_schema"
  | "get_provider_status"
  | "doctor"
  | "list_llms"
  | "get_run_budget";

export interface ReAllowlistEntry {
  name: ReToolName;
  effect: "read" | "write_workspace" | "exec_script" | "external";
  engineFree: boolean;
}

export interface ReBudget {
  maxToolCalls: number;
  maxBytesOut: number;
  maxWallMs: number;
}

export const DEFAULT_RE_BUDGET: ReBudget = {
  maxToolCalls: 40,
  maxBytesOut: 15_000,
  maxWallMs: 10 * 60_000,
};
