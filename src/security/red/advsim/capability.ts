/**
 * ATT&CK adversary-simulation capability (§6.9). Caldera runs only against an
 * owned lab base URL; executed abilities flow into the campaign and report.
 */
import { isLocalhostTarget, nextEvidenceId } from "../../orchestrator.js";
import type { PentestFinding } from "../../../tools/pentest.js";
import type { Evidence } from "../../orchestrator.js";
import type { RedCapability, RedCapabilityContext, RedHypothesis, RedValidation } from "../orchestrator/redOrchestrator.js";
import { listAdversaries, runOperation, type AdversaryProfile } from "./caldera.js";

export interface AdversaryCapabilityOptions {
  /** Caldera base URL (default: the standard lab port). */
  base?: string;
  /** Maximum adversary profiles per target (default 2). */
  maxProfiles?: number;
}

export function adversaryCapability(opts: AdversaryCapabilityOptions = {}): RedCapability {
  const base = opts.base ?? "http://127.0.0.1:8888";
  return {
    id: "red.advsim",
    applicable: (target) => isLocalhostTarget(target),
    hunt: async (_target, _recon, ctx): Promise<RedHypothesis[]> => {
      const profiles = await listAdversaries(base, ctx).catch(() => [] as AdversaryProfile[]);
      return profiles.slice(0, opts.maxProfiles ?? 2).map((profile) => ({
        id: `HYP-ATTCK-${profile.id}`,
        capability: "red.advsim",
        target: _target,
        claim: `Adversary emulation: ${profile.name}`,
        rationale: "Caldera ATT&CK operation on the owned lab",
        params: { profileId: profile.id, profileName: profile.name, base },
      }));
    },
    validate: async (hyp: RedHypothesis, ctx: RedCapabilityContext): Promise<RedValidation> => {
      const profile: AdversaryProfile = {
        id: hyp.params?.profileId ?? "",
        name: hyp.params?.profileName ?? "lab adversary",
        abilities: [],
      };
      if (!profile.id) {
        return { hypothesisId: hyp.id, status: "inconclusive", claim: hyp.claim, detail: "No adversary profile id", evidence: [] };
      }
      const operationBase = hyp.params?.base ?? base;
      try {
        const coverage = await runOperation(operationBase, profile, [new URL(hyp.target).hostname], ctx);
        if (!coverage.executed.length) {
          return { hypothesisId: hyp.id, status: "refuted", claim: hyp.claim, detail: "Caldera operation finished without executed abilities", evidence: [] };
        }
        const evidence: Evidence[] = coverage.executed.map((ability) => ({
          id: nextEvidenceId(),
          kind: "poc",
          at: new Date().toISOString(),
          poc: `caldera operation ${coverage.operationId}`,
          observed: `${ability.attackId}: ${ability.name} (result ${ability.result})`,
        }));
        const finding: Omit<PentestFinding, "id"> = {
          check: "red_attck_simulation",
          verdict: "finding",
          severity: "info",
          title: `ATT&CK emulation executed ${coverage.executed.length} ability(ies)`,
          target: hyp.target,
          detail: coverage.executed.map((a) => `${a.attackId} ${a.name}`).join("; "),
          remediation: "Close detection gaps for every emulated ATT&CK technique and retest coverage.",
        };
        return { hypothesisId: hyp.id, status: "confirmed", claim: hyp.claim, detail: finding.detail, evidence, finding, attckCoverage: coverage };
      } catch (err) {
        return { hypothesisId: hyp.id, status: "inconclusive", claim: hyp.claim, detail: `Caldera operation failed: ${(err as Error).message}`, evidence: [] };
      }
    },
  };
}
