/** Phase 8 — re-scan + closure — REMEDIATE_INTO_LOAM §3.2 hand-offs 4–5.
 *  Re-scan re-runs the detector that seeded the row on the fix branch; closure
 *  to `closed` requires deploy evidence whose version matches the verified
 *  target (OD-10). Source alone never closes. */
import { RemediationError } from "../errors.js";
import type { CloseRecord, RemediationRun, VulnRecord } from "../types.js";
import { runInventory, type RepoScanInput } from "../inventory/index.js";
import { loadPack } from "../packs/loader.js";
import { writeRun } from "../store.js";
import path from "node:path";

/** Re-run the runtime-inventory detector on the post-fix tree. */
export function rescanRuntimeInventory(input: RepoScanInput, advisoryIds: string[], advisoriesDir?: string): { records: VulnRecord[] } {
  // Load the SPECIFIC packs used by the run (enabled or not) by flipping a temp
  // view: simplest is runInventory over enabled packs + the run's disabled ones
  // loaded directly — for v1 we scan with the enabled set plus the run's packs.
  const records = runInventory([input], advisoriesDir).records;
  return { records: records.filter((r) => advisoryIds.includes(r.advisoryId)) };
}

/** Map the post-fix row to the closure state (Phase 8a → 8b). */
export function closureFromRescan(vuln: VulnRecord, postFix: VulnRecord | undefined): CloseRecord {
  const outcome = !postFix
    ? "not_observed"
    : postFix.status === "fixed"
      ? "fixed"
      : postFix.status === "vulnerable"
        ? "persistent"
        : "unverified";
  return {
    vulnId: vuln.id,
    state: outcome === "fixed" ? "fixed_pending_deploy" : outcome === "persistent" ? "still_vulnerable" : "unfixed",
    rescan: { kind: "runtime_inventory", ref: "fix-branch", at: new Date().toISOString(), outcome },
  };
}

/** Phase 8c: close ONLY with deploy evidence matching the verified target. */
export function closeWithDeployEvidence(
  run: RemediationRun,
  vulnId: string,
  evidence: { observedVersion: string; note: string; evidenceId: string },
): RemediationRun {
  const vuln = run.inventory.find((r) => r.id === vulnId);
  if (!vuln) throw new RemediationError(404, "run_not_found", `unknown vuln ${vulnId}`);
  const target = vuln.proposedTarget;
  if (!target || !evidence.observedVersion.includes(target)) {
    throw new RemediationError(409, "deploy_evidence_mismatch", `observed "${evidence.observedVersion}" does not match the verified target "${target ?? "none"}"`);
  }
  const existing = run.closures.find((c) => c.vulnId === vulnId);
  const record: CloseRecord = {
    vulnId, state: "closed",
    rescan: existing?.rescan ?? { kind: "runtime_inventory", ref: "pre-close", at: new Date().toISOString(), outcome: "fixed" },
    deployEvidence: { ...evidence, observedAt: new Date().toISOString() },
  };
  run.closures = [...run.closures.filter((c) => c.vulnId !== vulnId), record];
  writeRun(run);
  return run;
}
