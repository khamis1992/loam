/** RemediationError — REMEDIATE_INTO_LOAM §6.1. Carries an HTTP-appropriate
 *  status so gate endpoints map it directly (409 stale-hash, 403 not-approved,
 *  400 validation). Never leaks secrets in `code` or `detail`. */
export class RemediationError extends Error {
  constructor(
    public readonly status: number,
    public readonly code:
      | "repo_not_approved"
      | "plan_hash_mismatch"
      | "diff_hash_mismatch"
      | "pr_body_hash_mismatch"
      | "pack_hash_mismatch"
      | "no_verified_target"
      | "needs_upgrade_approval"
      | "owner_not_allowed"
      | "run_not_found"
      | "wrong_state"
      | "line_changed_underneath"
      | "deploy_evidence_mismatch"
      | "invalid_input",
    detail: string,
  ) {
    super(`remediate/${code}: ${detail}`);
    this.name = "RemediationError";
  }
}
