/**
 * Reporting with reproducible PoC (RED_TEAM_BUILD_SPEC §6.13) — builds on the
 * existing findings/SARIF machinery. Every finding's evidence chain is bundled
 * as a standalone PoC artifact so any claim can be re-run by hand. Retest
 * reuses compareFindings; the red→blue self-hardening hook (spec O-5) is
 * opt-in and off by default.
 */
import fs from "node:fs";
import path from "node:path";
import { compareFindings, sarif, type SecurityFinding } from "../findings.js";
import type { UnverifiedClaim } from "../orchestrator.js";
import type { AttckCoverage } from "./advsim/caldera.js";
import type { RedCampaignResult } from "./orchestrator/redOrchestrator.js";

export interface RedReport {
  campaignId: string;
  authzId: string | null;
  findings: SecurityFinding[];
  unverified: UnverifiedClaim[];
  poc: { findingId: string; artifactPath: string }[];
  attckCoverage?: AttckCoverage;
  sarifPath: string;
  markdownPath: string;
}

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"] as const;

/** Build the on-disk report bundle: SARIF + Markdown + per-finding PoC artifacts. */
export function buildRedReport(result: RedCampaignResult, outDir: string, opts: { attckCoverage?: AttckCoverage; openHardeningTasks?: boolean } = {}): RedReport {
  fs.mkdirSync(outDir, { recursive: true });
  const pocDir = path.join(outDir, "poc");
  fs.mkdirSync(pocDir, { recursive: true });

  const sorted = [...result.findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const poc: RedReport["poc"] = [];
  for (const f of sorted) {
    const evidence = result.evidence.filter((e) => f.requestIds.includes(e.id));
    const artifact = {
      findingId: f.id,
      check: f.check,
      target: f.target,
      severity: f.severity,
      claim: f.title,
      detail: f.detail,
      remediation: f.remediation ?? null,
      // Exact reproduction bundle: every EV item with its request/response or PoC.
      evidence: evidence.map((e) => ({
        id: e.id,
        kind: e.kind,
        at: e.at,
        ...(e.url ? { url: e.url, method: e.method ?? "GET", status: e.status } : {}),
        ...(e.request ? { request: e.request } : {}),
        ...(e.response ? { response: e.response } : {}),
        ...(e.poc ? { poc: e.poc, observed: e.observed } : {}),
      })),
    };
    const artifactPath = path.join(pocDir, `${f.id}.json`);
    fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), "utf8");
    poc.push({ findingId: f.id, artifactPath });
  }

  const sarifPath = path.join(outDir, "sarif.json");
  fs.writeFileSync(sarifPath, JSON.stringify(sarif(sorted), null, 2), "utf8");

  const lines: string[] = [
    `# Red-team report — ${result.campaignId}`,
    "",
    `- Campaign goal: ${result.ptt.goal}`,
    `- Authorization: ${result.authzId ?? "localhost default posture"}`,
    `- Window: ${result.stats.startedAt} → ${result.stats.finishedAt} (${result.stats.requestsSent} request(s), ${result.stats.targetsProcessed} target(s))`,
    `- Findings: ${sorted.length} proven, ${result.unverified.length} unverified${result.stats.killed ? " (campaign killed by kill-switch)" : ""}${result.stats.aborted === "budget" ? " (aborted: request budget)" : ""}`,
    "",
  ];
  if (sorted.length === 0) lines.push("_No gate-passing findings._", "");
  sorted.forEach((f, i) => {
    lines.push(`## ${i + 1}. [${f.severity.toUpperCase()}] ${f.title}`, "");
    lines.push(`- Check: \`${f.check}\``, `- Target: ${f.target}`, `- Detail: ${f.detail}`);
    if (f.remediation) lines.push(`- Remediation: ${f.remediation}`);
    const artifact = poc.find((p) => p.findingId === f.id);
    if (artifact) lines.push(`- PoC artifact: \`${path.relative(outDir, artifact.artifactPath).replace(/\\/g, "/")}\``);
    lines.push("");
  });
  if (result.unverified.length) {
    lines.push("## Unverified claims (withheld by the evidence gate)", "");
    for (const u of result.unverified) {
      lines.push(`- **${u.title}** (\`${u.check}\` @ ${u.target}) — ${u.reason}: ${u.detail}`);
    }
    lines.push("");
  }
  if (opts.attckCoverage) {
    lines.push("## ATT&CK coverage (adversary simulation)", "");
    for (const e of opts.attckCoverage.executed) lines.push(`- ${e.attackId} — ${e.name} (${e.result})`);
    lines.push("");
  }
  const markdownPath = path.join(outDir, "report.md");
  fs.writeFileSync(markdownPath, lines.join("\n"), "utf8");

  if (opts.openHardeningTasks) {
    // Spec O-5, default off: each proven finding becomes a blue hardening task.
    const tasks = sorted.map((f) => ({
      id: `HARDEN-${f.id.slice(0, 12)}`,
      source: `red:${result.campaignId}`,
      check: f.check,
      target: f.target,
      title: f.title,
      remediation: f.remediation ?? "",
    }));
    fs.writeFileSync(path.join(outDir, "hardening-tasks.json"), JSON.stringify(tasks, null, 2), "utf8");
  }

  return {
    campaignId: result.campaignId,
    authzId: result.authzId,
    findings: sorted,
    unverified: result.unverified,
    poc,
    ...(opts.attckCoverage ? { attckCoverage: opts.attckCoverage } : {}),
    sarifPath,
    markdownPath,
  };
}

/** Retest diff between two campaigns (thin, semantics-preserving wrapper). */
export function retestRed(
  baselineId: string,
  baseline: { findings: SecurityFinding[]; coverage?: string[] },
  current: { findings: SecurityFinding[]; coverage: string[] },
) {
  return compareFindings(baselineId, baseline.findings, current.findings, current.coverage);
}
