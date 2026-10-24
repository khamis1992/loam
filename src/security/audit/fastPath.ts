/**
 * Phase 0 fast path: deterministic scanner hits become records without an LLM.
 * Evidence quotes locations only, never a secret value.
 */
import type { Confirmed, NeedsValidation, ReconHit } from "./types.js";

const NON_LIVE = /(example|sample|dummy|placeholder|fake|test|mock|changeme)/i;
const NON_SOURCE = /(^|\/)(tests?|__tests__|fixtures?|docs?|examples?|samples?|testdata)(\/|$)|\.(md|txt|lock)$/i;

export function fingerprintOf(h: Pick<ReconHit, "tool" | "ruleId" | "file" | "line">): string {
  const raw = `${h.tool}:${h.ruleId}:${h.file}:${h.line}`.replace(/[^A-Za-z0-9._:/@+-]/g, "_");
  return /^[A-Za-z0-9]/.test(raw) ? raw : `x${raw}`;
}

/** Live-shaped = the rule and path give no hint it is a placeholder, and it sits in tracked source. */
export function liveShaped(h: ReconHit): boolean {
  return !NON_LIVE.test(h.ruleId) && !NON_SOURCE.test(h.file);
}

function loc(h: ReconHit) {
  return { file: h.file, line: h.line, description: `${h.tool} rule ${h.ruleId} reported here` };
}

function confirmed(h: ReconHit, title: string, description: string, strategy: string): Confirmed {
  return {
    verdict: "confirmed", fingerprint: fingerprintOf(h), title, description,
    root_cause: description, intended_behavior: "Source and dependencies contain no known-bad or secret material.",
    trace: [{ kind: "sink", file: h.file, line: h.line, scope: h.cls, description: `${h.tool}: ${h.ruleId}` }],
    evidence: [loc(h)], conditions: [],
    execution: { attacker_perspective: "Anyone with read access to the repository or its published artifacts.", payloads: [], instructions: [], observed_result: `Deterministic scanner match (${h.tool}).` },
    remediation: { strategy },
    severity: {
      likelihood: { score: "medium", reason: "Deterministic scanner match." },
      impact: { score: h.severity, reason: `Scanner severity for ${h.ruleId}.` },
      overall_severity: h.severity,
    },
    confidence: { score: "high", reason: "Deterministic rule." },
    evidence_vector: [{ source: "rule", state: "confirmed", ref: `${h.tool}:${h.ruleId}` }],
    evidence_assurance: "source-only",
  };
}

function needsValidation(h: ReconHit, title: string, description: string, blocker: string): NeedsValidation {
  return {
    verdict: "needs_validation", fingerprint: fingerprintOf(h), title, description,
    claimed_root_cause: description, trace: [{ kind: "sink", file: h.file, line: h.line, scope: h.cls, description: `${h.tool}: ${h.ruleId}` }],
    evidence: [loc(h)], blockers: [blocker],
    validation_plan: { local: `Inspect ${h.file}:${h.line} and decide whether the match is real.` },
    evidence_vector: [{ source: "rule", state: "unknown", ref: `${h.tool}:${h.ruleId}` }],
    evidence_assurance: "source-only",
  };
}

/** Opengrep and other non-deterministic hits are returned as hunter hints, not records. */
export function fastPath(hits: ReconHit[]): { records: (Confirmed | NeedsValidation)[]; hints: ReconHit[] } {
  const records: (Confirmed | NeedsValidation)[] = [];
  const hints: ReconHit[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    if (!h.deterministic) { hints.push(h); continue; }
    const fp = fingerprintOf(h);
    if (seen.has(fp)) continue;
    seen.add(fp);
    if (h.tool === "gitleaks") {
      const title = "Possible hard-coded secret";
      const desc = `Secret scanner rule ${h.ruleId} matched at ${h.file}:${h.line}. The value is not recorded.`;
      records.push(liveShaped(h)
        ? confirmed(h, title, desc, "Revoke the credential, remove it from history and load it from a secret store.")
        : needsValidation(h, title, desc, "The match looks like a placeholder or sits outside tracked source."));
    } else if (h.tool === "osv") {
      records.push(confirmed(h, "Dependency with a known vulnerability", `${h.message}`.slice(0, 500), "Upgrade to a fixed version."));
    } else if (h.tool === "guarddog") {
      records.push(confirmed(h, "Package flagged as malicious", `${h.message}`.slice(0, 500), "Remove the package and audit what it touched."));
    } else {
      hints.push(h);
    }
  }
  return { records, hints };
}
