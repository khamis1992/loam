/**
 * Shared types for the source security audit (verdict records, scanner hits,
 * agent I/O, coverage ledger, read-assurance identity types).
 */

export type Score = "informational" | "low" | "medium" | "high" | "critical";
export const SCORES: readonly Score[] = ["informational", "low", "medium", "high", "critical"];
export const scoreRank = (s: Score): number => SCORES.indexOf(s);

export type TraceStep = { kind: "entrypoint" | "propagation" | "sink"; file: string; line: number; scope: string; description: string };
export type FindingEvidence = { file: string; line: number; description: string };
export type ConditionKind =
  | "authentication_level" | "authorization_role" | "user_interaction" | "system_configuration"
  | "network_routing" | "environmental_dependency" | "data_state" | "timing_dependency" | "third_party_dependency";
export const CONDITION_KINDS: readonly ConditionKind[] = [
  "authentication_level", "authorization_role", "user_interaction", "system_configuration",
  "network_routing", "environmental_dependency", "data_state", "timing_dependency", "third_party_dependency",
];

export type EvidenceAssurance = "full" | "reduced-win32" | "source-only";
export type EvidenceSource = "dyn" | "llm" | "rule";
export type EvidenceState = "confirmed" | "refuted" | "unknown";
export interface EvidenceItem { source: EvidenceSource; state: EvidenceState; ref: string; note?: string }

export interface ProofArtifact { kind: "poc" | "crash" | "render" | "diff"; artifact_rel: string; sha256: string; observed: string }
export interface Cvss { vector: string; score: number; severity: Score }

export interface Confirmed {
  verdict: "confirmed"; fingerprint: string; title: string; description: string;
  root_cause: string; intended_behavior: string;
  trace: TraceStep[]; evidence: FindingEvidence[];
  conditions: { kind: ConditionKind; description: string }[];
  execution: { attacker_perspective: string; payloads: string[]; instructions: string[]; observed_result: string };
  remediation: { strategy: string; code_changes?: { file_name: string; fixed_code: string }[] };
  severity: { likelihood: { score: Score; reason: string }; impact: { score: Score; reason: string }; overall_severity: Score };
  confidence: { score: "low" | "medium" | "high"; reason: string };
  evidence_vector: EvidenceItem[];
  evidence_assurance: EvidenceAssurance;
  proof?: ProofArtifact;
  production_viable?: boolean | "unknown";
  cvss?: Cvss;
}
export interface NeedsValidation {
  verdict: "needs_validation"; fingerprint: string; title: string; description: string;
  claimed_root_cause: string; trace: TraceStep[]; evidence: FindingEvidence[];
  blockers: string[]; validation_plan: { local?: string; deployment?: string };
  evidence_vector: EvidenceItem[]; evidence_assurance: EvidenceAssurance;
}
export interface Rejected {
  verdict: "rejected"; fingerprint: string; title: string; description: string;
  claimed_root_cause: string; trace: TraceStep[]; evidence: FindingEvidence[]; reason: string;
  evidence_assurance: EvidenceAssurance;
}
export type FindingRecord = Confirmed | NeedsValidation | Rejected;

export type ScannerTool = "gitleaks" | "osv" | "guarddog" | "trivy" | "opengrep" | "nuclei" | "zap" | "jazzer";
export interface ReconHit {
  tool: ScannerTool;
  ruleId: string; message: string; file: string; line: number;
  cls: string;
  severity: Score;
  deterministic: boolean;
  raw: unknown;
}

export type LocalCheck = {
  agent_id: string; reviewed_paths: string[]; invariant: string;
  method: "source" | "local"; result: string; artifact: string | null;
  assurance: "full" | "reduced-win32" | null;
};
export type HunterResult = {
  units: { coverage_id: string; disposition: "covered" | "candidate" | "blocked"; reviewed_paths: string[];
    checks: LocalCheck[]; candidate_fingerprints: string[]; unresolved: string[] }[];
  candidates: (Omit<Confirmed, "verdict"> & { proposed_verdict: "confirmed" }
    | Omit<NeedsValidation, "verdict"> & { proposed_verdict: "needs_validation" })[];
  hardening: string[];
  uncovered: { surface: string; boundary: string; subsystem: string; attack_class: string; starting_paths: string[]; reason: string }[];
};
export type CriticResult = {
  missing_units: { surface: string; boundary: string; subsystem: string; attack_class: string; starting_paths: string[];
    selected_companion_blocks: string[]; excluded_blocks: { block: string; reason: string }[]; reason: string }[];
  reassign_ids: string[]; resolved_prior_leads: string[]; stop: boolean;
};
export type VerifierResult = { decision: "confirmed" | "needs_validation" | "rejected"; record: FindingRecord };
export type FinalVerifierResult =
  | { decision: "verified"; fingerprint: string }
  | { decision: "replace"; reason: string; record: FindingRecord };
export type ReconResult = {
  kind: "1a" | "1b" | "1c" | "1d" | "focused";
  facts: { claim: string; file: string; line: number }[];
  sandbox_capabilities?: Record<string, boolean>; prohibited_commands?: string[]; notes: string[];
};
export type AgentBudget = { limit: number | null; spent: number; reserved: { critics: number; validation: number } };

export type Assurance = "full" | "reduced-win32";
export interface ReadCapability { platform: NodeJS.Platform; assurance: Assurance; reason: string | null }
export interface FileIdentity { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; nlink: bigint }
export interface PromotionRecord { agent_id: string; scratch_rel: string; artifact_rel: string; bytes: number; sha256: string; assurance: Assurance }

export type PriorStatus =
  | "new" | "prior_confirmed_same_source" | "prior_confirmed_changed_source" | "prior_needs_validation"
  | "prior_deferred" | "prior_blocked" | "prior_out_of_scope" | "prior_covered_same_source"
  | "prior_covered_changed_source" | "prior_rejected_claim_changed" | "none";
export type UnitStatus = "planned" | "not_applicable" | "out_of_scope" | "deferred" | "in_progress" | "blocked" | "covered" | "candidate";
export type Attempt = {
  wave: number; status: "covered" | "candidate" | "blocked"; agent_id: string; reviewed_paths: string[];
  local_checks: LocalCheck[]; result_fingerprints: string[]; unresolved: string[]; reassignment_reason: string;
};
export type LedgerUnit = {
  coverage_id: string;
  canonical_refs: { surface: string; boundary: string; subsystem: string; attack_class: string; lifecycle?: string };
  surface: string; boundary: string; subsystem: string; attack_class: string; lifecycle?: string;
  starting_paths: string[];
  ordinary_attack_class_block: string | null;
  selected_companion_blocks: string[];
  excluded_blocks: { block: string; reason: string }[];
  prior_status: PriorStatus;
  attempts: Attempt[]; wave: number; status: UnitStatus; agent_id: string | null;
  reviewed_paths: string[]; local_checks: LocalCheck[]; result_fingerprints: string[]; unresolved: string[];
  [bookkeeping: `x_${string}`]: unknown;
};

export interface ValidateCtx {
  /** Absolute run directory; artifacts referenced by checks resolve under it. */
  runDir: string;
  /** Injectable platform/constants so both read branches are testable anywhere. */
  platform?: NodeJS.Platform;
}
export interface ValidateResult { ok: boolean; errors: string[]; readAssurance: Assurance }

export interface AuditOptions {
  target?: string;
  profile?: "quick" | "standard" | "deep";
  scope_paths?: string[];
  budget?: number | null;
  output_dir?: string;
  prior_runs?: "auto" | "none";
  runningTarget?: string;
}
export interface RunResult { run_id: string; output_dir: string; run_status: "complete" | "incomplete"; incomplete_reason?: string }
