/** Loam Remediate — verified vulnerability fixing with approval gates.
 *  REMEDIATE_INTO_LOAM_INTEGRATION §0.1/§7 (repo appendix E1/E8).
 *  Standing rules enforced by these types: no guessed versions (targets come
 *  from reviewed advisory packs + existence evidence), mitigations are never
 *  fixes (literal false), the user's working tree is never the unit of change
 *  (worktrees/clones under the run store), and gates are persisted hash-bound
 *  records decided only through the UI. */
import type { Mitigation } from "./types-mitigations.js";
export type { Mitigation };

export type RemediationRunState =
  | "inventory"
  | "awaiting_scope_approval"
  | "scope_approved"
  | "working"
  | "awaiting_commit_approval"
  | "awaiting_pr_approval"
  | "complete"
  | "incomplete"
  | "cancelled";

export type IncompleteReason =
  | "scope_denied"
  | "no_vulnerable_rows"
  | "budget_exhausted"
  | "cancelled"
  | "docker_unavailable_and_unverified_refused";

export type VulnStatus = "fixed" | "vulnerable" | "eol" | "unknown" | "vendor_update_required";

export type PinStyle = "exact" | "floating" | "digest" | "package" | "managed" | "iac" | "constraint" | "bundled";
export type Channel =
  | "dockerfile" | "version_file" | "ci_setup" | "ci_image"
  | "distro_package" | "source_build" | "helm" | "terraform"
  | "ansible" | "chef" | "puppet" | "serverless" | "lockfile"
  | "electron" | "omnibus" | "operator" | "ami";
export type UpgradeClass = "patch" | "minor" | "major" | "base_os" | "vendor" | "none";
export type RiskLabel = "low" | "high";
export type TestCoverage = "none" | "thin" | "suite";
export type Confidence = "low" | "medium" | "high";

export type Ecosystem = "nodejs" | "php" | "gitlab-self-managed" | "electron-bundled-nodejs" | "npm" | "PyPI";

export type Origin =
  | { kind: "security_audit"; runId: string; fingerprint: string }
  | { kind: "assessment"; assessmentId: string; name: string; version: string; ids: string[] }
  | { kind: "runtime_inventory" };

export interface InventoryHit {
  repoId: string;
  file: string;
  line: number;
  signal: string;
  channel: Channel;
  currentVersion: string | null;
  pinStyle: PinStyle;
  production: boolean;
  testCoverage: TestCoverage;
  confidence: Confidence;
  upgradeRiskNotes: string[];
  sapis?: string[];
  edition?: "ce" | "ee";
  topology?: "single" | "multi" | "unknown";
}

export interface VulnRecord {
  id: string;
  ecosystem: Ecosystem;
  advisoryId: string;
  cves: string[];
  hit: InventoryHit;
  status: VulnStatus;
  proposedTarget: string | null;
  upgradeClass: UpgradeClass;
  riskLabel: RiskLabel;
  origin: Origin;
  downtimeNote?: string;
  mitigations: Mitigation[];
  nextStep?: string;
}

export type TargetEvidenceKind =
  | "registry_manifest" | "vendor_release_index" | "distro_changelog_entry"
  | "tarball_checksum" | "commit_exists" | "chart_version_mapping" | "chart_index_entry"
  | "package_repo_entry" | "osv_fixed_event" | "registry_package_version"
  | "vendor_advisory_entry";

export interface TargetEvidence {
  kind: TargetEvidenceKind;
  at: string;
  url?: string;
  httpStatus?: number;
  bodySha256?: string;
  digest?: string;
  platforms?: string[];
  value: string;
  detail: string;
}

export type VerificationStatus = "verified" | "unverified" | "not_found";

export interface TargetVerification {
  target: { value: string; line: string; packId: string; packSha256: string };
  status: VerificationStatus;
  reason?: string;
  evidence: TargetEvidence[];
}

export interface ProposedEdit {
  file: string;
  line: number;
  before: string;
  after: string;
  rationale: string;
}

export interface FixProposal {
  vulnId: string;
  repoId: string;
  verification: TargetVerification;
  edits: ProposedEdit[];
  upgradeClass: UpgradeClass;
  riskLabel: RiskLabel;
  mitigations: Mitigation[];
}

export type StepStatus = "ok" | "failed" | "not_run";

export interface TestStepResult {
  name: "install" | "build" | "test" | "iac_validate";
  status: StepStatus;
  exitCode: number | null;
  logRel: string;
  logSha256: string;
  durationMs: number;
  deprecationLines: string[];
  failureLines: string[];
}

export interface TestRun {
  role: "baseline" | "after";
  imageRef: string;
  digest: string;
  steps: TestStepResult[];
  status: StepStatus;
}

export interface TestComparison {
  baseline: TestRun;
  after: TestRun;
  newFailures: string[];
  resolvedFailures: string[];
  newDeprecations: string[];
  resolvedDeprecations: string[];
}

export interface RuntimeDiff {
  before: Record<string, string>;
  after: Record<string, string>;
  changed: string[];
  notes: string[];
}

export interface SmokeResult {
  status: "ok" | "failed" | "not_run";
  reason: string;
  logRel?: string;
  logSha256?: string;
}

export interface ArtifactVersionProof {
  command: string;
  observed: string;
  matchesFixedRelease: boolean;
  evidenceId: string;
}

export type FixVerdict = "verified_fixed" | "patched_unverified" | "regression" | "blocked";

export interface FixGateResult {
  verdict: FixVerdict;
  reason: string;
}

export interface FixGateInput {
  verification: TargetVerification;
  artifactProof: ArtifactVersionProof | null;
  comparison: TestComparison | null;
  smoke: SmokeResult | null;
  policy: { dockerAvailable: boolean; dockerBlocker?: string };
}

export interface ScopeApproval {
  planHash: string;
  repos: string[];
  rows: string[];
  allowMajorUpgrade: Record<string, boolean>;
  allowMinorUpgrade: Record<string, boolean>;
  allowBaseOsChange: Record<string, boolean>;
  allowAppCodeChange: Record<string, boolean>;
  decidedAt: string;
  decidedBy: "user";
}

export interface CommitApproval {
  repoId: string;
  diffHash: string;
  prBodyHash: string;
  acceptUnverified: boolean;
  decidedAt: string;
  decidedBy: "user";
}

export interface PrApproval {
  repoId: string;
  remote: string;
  base: string;
  draft: boolean;
  decidedAt: string;
  decidedBy: "user";
}

export type RepoPhase =
  | "queued" | "recheck" | "resolve" | "baseline" | "edit"
  | "after" | "fix_gate" | "awaiting_commit" | "committed"
  | "awaiting_pr" | "pr_opened" | "discarded" | "blocked" | "skipped";

export interface RepoPlan {
  repoId: string;
  path: string;
  branch: string;
  baseBranch: string;
  phase: RepoPhase;
  vulns: string[];
  proposal: FixProposal | null;
  baseline: TestRun | null;
  after: TestRun | null;
  comparison: TestComparison | null;
  runtimeDiff: RuntimeDiff | null;
  smoke: SmokeResult | null;
  artifactProof: ArtifactVersionProof | null;
  fixGate: FixGateResult | null;
  commitApproval: CommitApproval | null;
  prApproval: PrApproval | null;
  commitSha: string | null;
  pr: { number: number; url: string; draft: boolean; provider: string } | null;
  blockedReason: string | null;
  rollbackTarget: { digest?: string; version?: string } | null;
}

export type RemediationEvidenceKind =
  | TargetEvidenceKind
  | "inventory_hit" | "build_log" | "test_log" | "runtime_diff"
  | "smoke_log" | "artifact_version" | "iac_validation" | "deploy_observation";

export interface RemediationEvidence {
  id: string;
  sha256: string;
  kind: RemediationEvidenceKind;
  at: string;
  repoId?: string;
  vulnId?: string;
  assurance: "full" | "reduced-win32" | "source-only" | "network";
  detail: string;
  pathRel?: string;
  url?: string;
  redaction: "ok" | "failed" | "n/a";
}

export type SourceFixState = "unfixed" | "fixed_pending_deploy" | "still_vulnerable" | "closed";

export interface CloseRecord {
  vulnId: string;
  state: SourceFixState;
  rescan: {
    kind: "security_audit" | "assessment_retest" | "runtime_inventory";
    ref: string;
    at: string;
    outcome: "not_observed" | "persistent" | "unverified" | "fixed" | "error";
  };
  deployEvidence?: {
    observedVersion: string;
    observedAt: string;
    note: string;
    evidenceId: string;
  };
}

export interface RemediationRun {
  id: string;
  createdAt: string;
  finishedAt?: string;
  state: RemediationRunState;
  incompleteReason?: IncompleteReason;
  advisoryIds: string[];
  packHashes: Record<string, string>;
  repos: string[];
  inventory: VulnRecord[];
  unsearchable: { repoId: string; reason: string }[];
  scopeApproval: ScopeApproval | null;
  plans: RepoPlan[];
  evidence: RemediationEvidence[];
  closures: CloseRecord[];
  host: { platform: NodeJS.Platform; docker: { available: boolean; blocker?: string } };
  model: string;
  budget: { limit: number | null; spent: number };
}

export interface RemediationStartInput {
  advisory_ids?: string[];
  repos?: string[];
  from_audit_run?: string;
  from_assessment?: string;
  allow_docker?: boolean;
  budget?: number | null;
}

export interface RemediateLimits {
  maxRepos: number;
  maxRows: number;
  maxEditsPerRepo: number;
  maxLogBytesPerStep: number;
  maxNetworkBytesPerResponse: number;
  maxNetworkBytesPerRun: number;
  inventoryAgentTimeoutMs: number;
  buildTimeoutMs: number;
  testTimeoutMs: number;
  smokeTimeoutMs: number;
  resolverTimeoutMs: number;
  maxConcurrentInventoryAgents: number;
}

export const REMEDIATE_LIMITS: RemediateLimits = {
  maxRepos: 50,
  maxRows: 5_000,
  maxEditsPerRepo: 200,
  maxLogBytesPerStep: 5_242_880,
  maxNetworkBytesPerResponse: 2_000_000,
  maxNetworkBytesPerRun: 20_000_000,
  inventoryAgentTimeoutMs: 180_000,
  buildTimeoutMs: 600_000,
  testTimeoutMs: 600_000,
  smokeTimeoutMs: 60_000,
  resolverTimeoutMs: 30_000,
  maxConcurrentInventoryAgents: 4,
};

/** Stable SHA-256 of a JSON-canonicalised value — backs plan/diff/evidence hashes.
 *  Delegates to the REA-proven canonicalJson (appendix E1). */
import { createHash } from "node:crypto";
import { canonicalJson } from "../reaEvidence.js";

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** GATE-1 binds the approval to exactly the inventory the UI rendered. */
export function planHash(inventory: VulnRecord[], targets: Record<string, string | null>): string {
  return canonicalSha256({
    rows: inventory.map((r) => ({
      id: r.id, repoId: r.hit.repoId, file: r.hit.file, line: r.hit.line,
      signal: r.hit.signal, current: r.hit.currentVersion, status: r.status,
      target: targets[r.id] ?? r.proposedTarget, upgradeClass: r.upgradeClass,
    })).sort((a, b) => a.id.localeCompare(b.id)),
  });
}
