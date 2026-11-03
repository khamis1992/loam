/** PR planner + deterministic body template — REMEDIATE_INTO_LOAM §7.4/§6.1 pr/*
 *  (Phase E). The body is a pure template — no model prose ever. Draft by default
 *  (OD-5); an unverified fix prefixes the title with [unverified] (E10). */
import { canonicalSha256, type FixProposal, type RepoPlan, type TestComparison, type VulnRecord } from "../types.js";
import type { AdvisoryPack } from "../packs/schema.js";

export function prTitle(pack: AdvisoryPack, fixGate: RepoPlan["fixGate"]): string {
  const prefix = fixGate?.verdict === "patched_unverified" ? "[unverified] " : "";
  return `${prefix}Remediate: ${pack.title}`;
}

export function prBody(input: {
  runId: string;
  pack: AdvisoryPack;
  records: VulnRecord[];
  proposal: FixProposal | null;
  plan: RepoPlan;
  comparison: TestComparison | null;
}): string {
  const { runId, pack, records, proposal, plan, comparison } = input;
  const rows = records
    .filter((r) => proposal?.edits.some((e) => e.file === r.hit.file) || r.proposedTarget)
    .map((r) => `| \`${r.hit.file}:${r.hit.line}\` | ${r.hit.currentVersion ?? "?"} | ${r.proposedTarget ?? "—"} | ${r.hit.pinStyle} | ${r.hit.production ? "production" : "CI"} | ${r.riskLabel} |`)
    .join("\n");

  const v = proposal?.verification;
  const artifact = plan.artifactProof;
  const smoke = plan.smoke;
  const gate = plan.fixGate;

  return `# Remediate: ${pack.title}

> نتريو · مسار الإصلاح المُتحقَّق · run ${runId}
> This PR was opened as a **draft**. Nothing has been deployed.

## Summary
| Path | Before | After | Pin | Production | Risk |
|---|---|---|---|---|---|
${rows}

## Verification
- Target evidence: ${v?.status ?? "n/a"}${v?.reason ? ` (${v.reason})` : ""}
${v?.evidence.map((e) => `  - ${e.kind}: ${e.value} — ${e.detail}`).join("\n") ?? ""}
- After-artifact: ${artifact ? `\`${artifact.command}\` → \`${artifact.observed}\` (matches: ${artifact.matchesFixedRelease})` : "not run (no Docker)"}
- Baseline tests: ${comparison?.baseline.status ?? "not_run"}
- After tests: ${comparison?.after.status ?? "not_run"}
- New failures: ${comparison?.newFailures.length ?? 0} · New deprecations: ${comparison?.newDeprecations.length ?? 0}
- Runtime diff: ${plan.runtimeDiff ? plan.runtimeDiff.changed.join(", ") || "no changes" : "not run"}
- Smoke: ${smoke?.status ?? "not_run"}
- Fix gate: **${gate?.verdict ?? "n/a"}**${gate?.reason ? ` — ${gate.reason}` : ""}

## Rollout
1. Merge this draft after review.
2. Deploy to staging/canary first.
3. Confirm the running version/digest matches **${proposal?.verification.target.value ?? "?"}**.
4. Then production.

## Rollback
Previous artifact: \`${plan.rollbackTarget?.digest ?? plan.rollbackTarget?.version ?? "recorded at baseline"}\` (still vulnerable — roll back only briefly).
${records.some((r) => r.mitigations.length > 0) ? `
### Temporary mitigations (not a fix)
${records.flatMap((r) => r.mitigations.map((m) => `- ${m.summary}`)).join("\n")}
` : ""}
## Closure
Source state after re-scan: \`fixed_pending_deploy\`. Mark **closed** in Loam only after you paste deploy evidence that matches ${proposal?.verification.target.value ?? "?"}.

## Attribution
Procedure derived from CognitionAI/devin-vuln-fixes (MIT, © 2026 Cognition AI, Inc.), commit 39a04007a1cb19aafd3c487d615c524479963ebf. Advisory facts from ${pack.sourceUrls[0]}.
`;
}

export function prBodyHash(body: string): string {
  return canonicalSha256({ body });
}

export function diffHash(diff: string): string {
  return canonicalSha256({ diff });
}

export function branchName(advisoryId: string, runId: string): string {
  return `loam/remediate/${advisoryId}/${runId.slice(0, 8)}`;
}
