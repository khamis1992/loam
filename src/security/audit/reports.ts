/**
 * Deterministic report templates. No model prose: every sentence here comes from a record field
 * or a fixed template. Reduced-assurance evidence is always labelled, never hidden.
 */
import type { Confirmed, EvidenceAssurance, FindingRecord, LedgerUnit, NeedsValidation } from "./types.js";

export interface ScannerLine { tool: string; status: string; hitCount: number; detail?: string }

export interface ReportInput {
  runId: string;
  repo: string;
  profile: string;
  runStatus: "complete" | "incomplete";
  incompleteReason?: string;
  findings: FindingRecord[];
  units: LedgerUnit[];
  scanners: ScannerLine[];
  promotions: { full: number; reduced_win32: number };
  hostPlatform: string;
  readAssurance: "full" | "reduced-win32";
  budget: { spent: number; limit: number | null };
}

export const assuranceLabel = (a: EvidenceAssurance): string =>
  a === "full" ? "full" : a === "reduced-win32" ? "reduced (win32)" : "source only";

const SEV_ORDER = ["critical", "high", "medium", "low", "info"];
const sevRank = (s: string): number => { const i = SEV_ORDER.indexOf(s); return i < 0 ? SEV_ORDER.length : i; };

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const loc = (r: FindingRecord): string => {
  const t = r.trace[r.trace.length - 1] ?? r.trace[0];
  const e = r.evidence[0];
  if (t) return `${t.file}:${t.line}`;
  return e ? `${e.file}:${e.line}` : "-";
};

const confirmed = (f: FindingRecord[]): Confirmed[] => f.filter((x): x is Confirmed => x.verdict === "confirmed");
const pending = (f: FindingRecord[]): NeedsValidation[] => f.filter((x): x is NeedsValidation => x.verdict === "needs_validation");

function sortedConfirmed(f: FindingRecord[]): Confirmed[] {
  return [...confirmed(f)].sort((a, b) => sevRank(a.severity.overall_severity) - sevRank(b.severity.overall_severity) || a.fingerprint.localeCompare(b.fingerprint));
}

export function reducedNotice(i: ReportInput): string {
  const total = i.promotions.full + i.promotions.reduced_win32;
  if (i.promotions.reduced_win32 === 0) return "";
  return `> ${i.promotions.reduced_win32} of ${total} promoted artifacts were read with reduced assurance (win32: lstat+fstat, no O_NOFOLLOW). Affected findings are labelled.\n> ملاحظة: بعض الأدلة نُقلت بفحص مخفّف على ويندوز، والنتائج المتأثرة معلّمة.\n`;
}

export function renderReport(i: ReportInput): string {
  const c = sortedConfirmed(i.findings);
  const n = pending(i.findings);
  const rejected = i.findings.filter((x) => x.verdict === "rejected").length;
  const out: string[] = [];
  out.push(`# Security audit: ${i.repo}`, "");
  out.push("## 1. Summary", "");
  out.push(`- Run: \`${i.runId}\``);
  out.push(`- Profile: ${i.profile}`);
  out.push(`- Status: ${i.runStatus}${i.incompleteReason ? ` (${i.incompleteReason})` : ""}`);
  out.push(`- Confirmed: ${c.length}`);
  out.push(`- Needs validation: ${n.length}`);
  out.push(`- Rejected: ${rejected}`);
  out.push(`- Agent invocations: ${i.budget.spent}${i.budget.limit === null ? "" : ` of ${i.budget.limit}`}`);
  out.push(`- Evidence read assurance: ${i.readAssurance} (host ${i.hostPlatform})`);
  out.push("- Dynamic confirmation: off (static analysis only)");
  const notice = reducedNotice(i);
  if (notice) out.push("", notice);
  if (i.runStatus === "incomplete") out.push("", "> This run is incomplete. Absence of a finding is not evidence of absence.");
  out.push("", "## 2. Confirmed findings", "");
  if (c.length === 0) out.push("None.");
  else {
    out.push("| Severity | Title | Location | Fingerprint | Evidence |", "|---|---|---|---|---|");
    for (const f of c) out.push(`| ${f.severity.overall_severity} | ${cell(f.title)} | ${cell(loc(f))} | \`${f.fingerprint}\` | ${assuranceLabel(f.evidence_assurance)} |`);
  }
  out.push("", "## 3. Needs validation", "");
  if (n.length === 0) out.push("None.");
  else {
    out.push("| Title | Location | Fingerprint | Evidence |", "|---|---|---|---|");
    for (const f of n) out.push(`| ${cell(f.title)} | ${cell(loc(f))} | \`${f.fingerprint}\` | ${assuranceLabel(f.evidence_assurance)} |`);
  }
  out.push("", "## 4. Scanners", "");
  if (i.scanners.length === 0) out.push("None ran.");
  else for (const s of i.scanners) out.push(`- ${s.tool}: ${s.status}, ${s.hitCount} hits${s.detail ? ` (${s.detail})` : ""}`);
  const counts: Record<string, number> = {};
  for (const u of i.units) counts[u.status] = (counts[u.status] ?? 0) + 1;
  out.push("", "## 5. Coverage", "");
  if (i.units.length === 0) out.push("No coverage units.");
  else out.push(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}: ${v}`).join(", "));
  const open = i.units.filter((u) => u.unresolved.length > 0);
  if (open.length) {
    out.push("", "Unresolved:");
    for (const u of open.slice(0, 50)) out.push(`- \`${u.coverage_id}\` (${u.status}): ${u.unresolved.join("; ")}`);
  }
  return `${out.join("\n")}\n`;
}

export function renderDetail(i: ReportInput): string {
  const out: string[] = ["# Findings detail", ""];
  for (const f of sortedConfirmed(i.findings)) {
    out.push(`## ${f.title}`, "");
    out.push(`- Severity: ${f.severity.overall_severity} (likelihood ${f.severity.likelihood.score}, impact ${f.severity.impact.score})`);
    out.push(`- Confidence: ${f.confidence.score}`);
    out.push(`- Fingerprint: \`${f.fingerprint}\``);
    out.push(`- Location: ${loc(f)}`);
    out.push(`- Evidence assurance: ${assuranceLabel(f.evidence_assurance)}`);
    out.push("", f.description, "", `Root cause: ${f.root_cause}`, "", `Intended behavior: ${f.intended_behavior}`, "", "Trace:");
    for (const t of f.trace) out.push(`- ${t.kind} ${t.file}:${t.line} (${t.scope}): ${t.description}`);
    out.push("", "Remediation:", f.remediation.strategy, "");
  }
  if (out.length === 2) out.push("No confirmed findings.");
  return `${out.join("\n")}\n`;
}

export function renderNeedsValidation(i: ReportInput): string {
  const out: string[] = ["# Needs validation", ""];
  for (const f of pending(i.findings)) {
    out.push(`## ${f.title}`, "");
    out.push(`- Fingerprint: \`${f.fingerprint}\``);
    out.push(`- Location: ${loc(f)}`);
    out.push(`- Evidence assurance: ${assuranceLabel(f.evidence_assurance)}`);
    out.push("", f.description, "", `Claimed root cause: ${f.claimed_root_cause}`, "", "Blockers:");
    for (const b of f.blockers) out.push(`- ${typeof b === "string" ? b : JSON.stringify(b)}`);
    const p = f.validation_plan;
    if (p.local) out.push("", `Local validation: ${typeof p.local === "string" ? p.local : JSON.stringify(p.local)}`);
    if (p.deployment) out.push("", `Deployment validation: ${typeof p.deployment === "string" ? p.deployment : JSON.stringify(p.deployment)}`);
    out.push("");
  }
  if (out.length === 2) out.push("Nothing to validate.");
  return `${out.join("\n")}\n`;
}

const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";

export function toSarif(i: ReportInput): Record<string, unknown> {
  const results = i.findings
    .filter((f) => f.verdict !== "rejected")
    .map((f) => {
      const t = f.trace[f.trace.length - 1] ?? f.trace[0];
      const e = f.evidence[0];
      const file = t?.file ?? e?.file ?? "unknown";
      const line = Math.max(1, t?.line ?? e?.line ?? 1);
      const level = f.verdict === "needs_validation" ? "note"
        : (f as Confirmed).severity.overall_severity === "critical" || (f as Confirmed).severity.overall_severity === "high" ? "error" : "warning";
      return {
        ruleId: f.fingerprint,
        level,
        message: { text: f.title },
        locations: [{ physicalLocation: { artifactLocation: { uri: file }, region: { startLine: line } } }],
        partialFingerprints: { "loam/v1": f.fingerprint },
        properties: { verdict: f.verdict, evidenceAssurance: f.evidence_assurance },
      };
    });
  return {
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [{ tool: { driver: { name: "Loam Security Audit", informationUri: "https://example.invalid/loam", rules: [] } }, results }],
  };
}

export function runMetadata(i: ReportInput, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: i.runId,
    repo: i.repo,
    profile: i.profile,
    run_status: i.runStatus,
    ...(i.incompleteReason ? { incomplete_reason: i.incompleteReason } : {}),
    budget: i.budget,
    host_platform: i.hostPlatform,
    read_assurance: i.readAssurance,
    promotions: i.promotions,
    scanners: i.scanners,
    counts: {
      confirmed: confirmed(i.findings).length,
      needs_validation: pending(i.findings).length,
      rejected: i.findings.filter((x) => x.verdict === "rejected").length,
    },
    ...extra,
  };
}
