/** findings.json validator (§8.3). Never repairs; any error blocks the next stage. */
import { FINDINGS_SCHEMA } from "./findingsSchema.js";
import { FINDINGS_LIMITS, parseBounded } from "./jsonLimits.js";
import { checkRepoPath, envFor, readRunFile, weakest } from "./repoPath.js";
import { readCapability } from "./safeRead.js";
import { validateSchema } from "./schema.js";
import { scoreRank } from "./types.js";
import type { Assurance, LedgerUnit, ValidateCtx, ValidateResult } from "./types.js";
import { validateLedger } from "./validateLedger.js";

type Rec = Record<string, unknown> & {
  verdict: string;
  fingerprint: string;
  trace: { kind: string; file: string; line: number }[];
  evidence: { file: string; line: number }[];
  evidence_assurance: string;
};

/** evidence_assurance is parent-set only: agent output carrying it is discarded before validation. */
export function discardAgentAssurance<T>(agentResult: T): T {
  if (Array.isArray(agentResult)) return agentResult.map(discardAgentAssurance) as unknown as T;
  if (agentResult && typeof agentResult === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(agentResult as Record<string, unknown>)) {
      if (k !== "evidence_assurance") out[k] = discardAgentAssurance(v);
    }
    return out as T;
  }
  return agentResult;
}

/** The assurance the parent must stamp on a fingerprint: weakest linked local check, else source-only. */
export function expectedAssurance(units: LedgerUnit[], fingerprint: string): "full" | "reduced-win32" | "source-only" {
  const list: Assurance[] = [];
  const all = units.flatMap((u) => [u, ...u.attempts]);
  for (const u of all) {
    if (!u.result_fingerprints.includes(fingerprint)) continue;
    for (const c of u.local_checks) if (c.method === "local" && c.assurance) list.push(c.assurance);
  }
  return weakest(list);
}

export function validateFindings(bytes: Buffer, ctx: ValidateCtx): ValidateResult {
  const errors: string[] = [];
  const push = (m: string): void => {
    if (errors.length < FINDINGS_LIMITS.maxErrors) errors.push(m);
  };
  let readAssurance: Assurance = readCapability(envFor(ctx.platform)).assurance;
  const parsed = parseBounded(bytes, FINDINGS_LIMITS);
  if (!parsed.ok) return { ok: false, errors: parsed.errors, readAssurance };
  const structural = validateSchema(parsed.value, FINDINGS_SCHEMA, { maxErrors: FINDINGS_LIMITS.maxErrors });
  if (structural.length) return { ok: false, errors: structural.slice(0, FINDINGS_LIMITS.maxErrors), readAssurance };
  const items = parsed.value as Rec[];

  // Link findings to ledger units. Absent ledger: no links. Present but invalid: an error.
  let units: LedgerUnit[] = [];
  const led = readRunFile(ctx.runDir, "coverage-ledger.json", 5 * 1024 * 1024, ctx.platform);
  if (led.ok) {
    const lv = validateLedger(led.bytes, ctx);
    if (!lv.ok) push(`coverage-ledger.json is invalid (${lv.errors[0] ?? "unknown"})`);
    else units = JSON.parse(led.bytes.toString("utf8")) as LedgerUnit[];
    readAssurance = led.assurance;
  } else if (led.step !== "leaf-lstat") {
    push(`coverage-ledger.json unreadable (${led.step}: ${led.detail})`);
  }

  const seen = new Set<string>();
  let prev = "";
  items.forEach((f, i) => {
    const at = `$[${i}]`;
    if (i > 0 && f.fingerprint <= prev) push(`${at}: findings must be sorted by fingerprint`);
    prev = f.fingerprint;
    if (seen.has(f.fingerprint)) push(`${at}: duplicate fingerprint "${f.fingerprint}"`);
    seen.add(f.fingerprint);

    const kinds = f.trace.map((s) => s.kind);
    if (kinds.length === 1) {
      if (kinds[0] === "propagation") push(`${at}.trace: a one-entry trace must be entrypoint or sink`);
    } else if (kinds.length > 1) {
      if (kinds[0] !== "entrypoint") push(`${at}.trace: must start with entrypoint`);
      if (kinds[kinds.length - 1] !== "sink") push(`${at}.trace: must end with sink`);
      for (let k = 1; k < kinds.length - 1; k++) {
        if (kinds[k] !== "propagation") push(`${at}.trace[${k}]: only propagation allowed between entrypoint and sink`);
      }
    }
    const t = f.trace;
    for (const s of [...t, ...f.evidence]) {
      const bad = checkRepoPath(s.file);
      if (bad) push(`${at}: path "${s.file}": ${bad}`);
    }

    if (f.verdict === "confirmed") {
      const sev = f.severity as { impact: { score: never }; overall_severity: never };
      if (scoreRank(sev.overall_severity) > scoreRank(sev.impact.score)) {
        push(`${at}.severity: overall_severity exceeds impact.score`);
      }
    }
    if (f.verdict === "needs_validation") {
      const plan = f.validation_plan as { local?: string; deployment?: string };
      if (!plan.local && !plan.deployment) push(`${at}.validation_plan: needs local or deployment`);
    }

    const want = expectedAssurance(units, f.fingerprint);
    if (f.evidence_assurance !== want) {
      push(`${at}.evidence_assurance: "${f.evidence_assurance}" differs from the weakest linked check "${want}"`);
    }
  });

  return { ok: errors.length === 0, errors, readAssurance };
}
