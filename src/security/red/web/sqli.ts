/**
 * SQLi capability (RED_TEAM_BUILD_SPEC §6.3) — sqlmap via the red-sqlmap
 * bridge (GPL-2.0 stays external; no code copied). The default `test` command
 * is non-destructive (detection + DBMS fingerprint only); `dump` exists on the
 * bridge but only ever runs behind the gate's destructive approval.
 */
import type { PentestFinding } from "../../../tools/pentest.js";
import type { Evidence } from "../../orchestrator.js";
import { nextEvidenceId } from "../../orchestrator.js";
import { loadEngines } from "../engines.js";
import type { RedCapability, RedCapabilityContext, RedHypothesis, RedValidation } from "../orchestrator/redOrchestrator.js";

export interface SqlmapProof {
  injectable: boolean;
  parameters: string[];
  dbms?: string;
  excerpt: string;
}

/** Parse sqlmap console output into a structural proof. */
export function parseSqlmap(text: string): SqlmapProof {
  const excerpt = text.slice(0, 4000);
  // sqlmap's confirmation line is "Parameter '<name>' is vulnerable" / "is vulnerable".
  // Bare "injectable" also appears in negative summaries ("does not seem to be injectable"),
  // so it alone is never proof.
  const injectable = /is vulnerable/i.test(text);
  const parameters = [...new Set([...text.matchAll(/Parameter: (.+?)$/gm)].map((m) => m[1]!.trim()))].slice(0, 10);
  const dbmsMatch = /back-end DBMS: (.+)$/m.exec(text);
  return { injectable, parameters, dbms: dbmsMatch?.[1]?.trim(), excerpt };
}

export function sqliCapability(opts: { level?: number; risk?: number; scriptPath?: string | null } = {}): RedCapability {
  const level = opts.level ?? 1;
  const risk = opts.risk ?? 1;
  return {
    id: "red.sqli",
    applicable: (target) => /^https?:/i.test(target),
    hunt: async (target): Promise<RedHypothesis[]> => [
      { id: `HYP-SQLI-${hashOf(target)}`, capability: "red.sqli", target, claim: "SQL injection in target parameters", rationale: "sqlmap detection pass" },
    ],
    validate: async (hyp: RedHypothesis, ctx: RedCapabilityContext): Promise<RedValidation> => {
      // Explicit null disables the registry lookup (hermetic tests / no engines).
      const script = opts.scriptPath !== undefined ? opts.scriptPath ?? null : loadEngines()?.paths.sqlmapScript ?? null;
      if (!script) {
        return { hypothesisId: hyp.id, status: "inconclusive", claim: hyp.claim, detail: "sqlmap not installed (run npm run red:engines)", evidence: [] };
      }
      const envelope = await ctx.bridge("red-sqlmap", "test", {
        script,
        url: hyp.target,
        level,
        risk,
        workdir: "red-sqlmap-out",
      });
      const text = `${envelope.text ?? ""}${envelope.error?.message ?? ""}`;
      if (!envelope.ok) {
        return { hypothesisId: hyp.id, status: "inconclusive", claim: hyp.claim, detail: `sqlmap unavailable: ${envelope.error?.message ?? "no output"}`, evidence: [] };
      }
      const proof = parseSqlmap(text);
      if (!proof.injectable) {
        return { hypothesisId: hyp.id, status: "refuted", claim: hyp.claim, detail: "sqlmap found no injectable parameter", evidence: [] };
      }
      const evidence: Evidence[] = [
        {
          id: nextEvidenceId(),
          kind: "poc",
          at: new Date().toISOString(),
          poc: `sqlmap -u ${hyp.target} --batch --level ${level} --risk ${risk}`,
          observed: `Injectable parameter(s): ${proof.parameters.join(", ") || "unknown"}${proof.dbms ? ` (back-end DBMS: ${proof.dbms})` : ""}`,
        },
      ];
      const finding: Omit<PentestFinding, "id"> = {
        check: "red_sqli",
        verdict: "finding",
        severity: "high",
        title: `SQL injection in ${proof.parameters.join(", ") || "parameter"}`,
        target: hyp.target,
        detail: evidence[0]!.observed!,
        remediation: "Use parameterized queries / prepared statements; validate and cast all user input server-side.",
      };
      return { hypothesisId: hyp.id, status: "confirmed", claim: hyp.claim, detail: evidence[0]!.observed!, evidence, finding };
    },
  };
}

const hashOf = (s: string): string => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).slice(0, 6);
};
