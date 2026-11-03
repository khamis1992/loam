/** Hand-written coverage-ledger validator (§8.3). Never repairs; any error blocks the next stage. */
import { isValidAgentId, tryDeriveCoverageId } from "./coverageId.js";
import { LEDGER_LIMITS, parseBounded } from "./jsonLimits.js";
import { checkRepoPath, readRunRel, weakest } from "./repoPath.js";
import { readCapability } from "./safeRead.js";
import { envFor } from "./repoPath.js";
import { strArr, text, validateSchema } from "./schema.js";
import type { SchemaObject } from "./schema.js";
import type { Assurance, LedgerUnit, PromotionRecord, ValidateCtx, ValidateResult } from "./types.js";

const STATUSES = ["planned", "not_applicable", "out_of_scope", "deferred", "in_progress", "blocked", "covered", "candidate"];
const PRIOR = [
  "new", "prior_confirmed_same_source", "prior_confirmed_changed_source", "prior_needs_validation", "prior_deferred",
  "prior_blocked", "prior_out_of_scope", "prior_covered_same_source", "prior_covered_changed_source",
  "prior_rejected_claim_changed", "none",
];
const obj = (properties: Record<string, SchemaObject>, required: string[]): SchemaObject => ({
  type: "object", properties, required, additionalProperties: false,
});

const localCheck = (): SchemaObject =>
  obj({
    agent_id: text(), reviewed_paths: strArr(1), invariant: text(),
    method: { type: "string", enum: ["source", "local"] }, result: text(),
    artifact: { type: ["string", "null"] }, assurance: { type: ["string", "null"], enum: ["full", "reduced-win32", null] },
  }, ["agent_id", "reviewed_paths", "invariant", "method", "result", "artifact", "assurance"]);

const refs = (): SchemaObject =>
  obj({ surface: text(), boundary: text(), subsystem: text(), attack_class: text(), lifecycle: text() },
    ["surface", "boundary", "subsystem", "attack_class"]);

const attempt = (): SchemaObject =>
  obj({
    wave: { type: "integer", minimum: 0 }, status: { type: "string", enum: ["covered", "candidate", "blocked"] },
    agent_id: text(), reviewed_paths: strArr(0), local_checks: { type: "array", items: localCheck() },
    result_fingerprints: strArr(0), unresolved: strArr(0), reassignment_reason: text(),
  }, ["wave", "status", "agent_id", "reviewed_paths", "local_checks", "result_fingerprints", "unresolved", "reassignment_reason"]);

const UNIT_SCHEMA: SchemaObject = obj({
  coverage_id: text(), canonical_refs: refs(),
  surface: text(), boundary: text(), subsystem: text(), attack_class: text(), lifecycle: text(),
  starting_paths: strArr(0), ordinary_attack_class_block: { type: ["string", "null"] },
  selected_companion_blocks: strArr(0), excluded_blocks: { type: "array", items: obj({ block: text(), reason: text() }, ["block", "reason"]) },
  prior_status: { type: "string", enum: PRIOR }, attempts: { type: "array", items: attempt() },
  wave: { type: "integer", minimum: 0 }, status: { type: "string", enum: STATUSES }, agent_id: { type: ["string", "null"] },
  reviewed_paths: strArr(0), local_checks: { type: "array", items: localCheck() },
  result_fingerprints: strArr(0), unresolved: strArr(0),
}, [
  "coverage_id", "canonical_refs", "surface", "boundary", "subsystem", "attack_class", "starting_paths",
  "ordinary_attack_class_block", "selected_companion_blocks", "excluded_blocks", "prior_status", "attempts",
  "wave", "status", "agent_id", "reviewed_paths", "local_checks", "result_fingerprints", "unresolved",
]);

const stripBookkeeping = (u: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(u).filter(([k]) => !k.startsWith("x_")));

const sameSet = (a: string[], b: string[]): boolean => {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
};

export function validateLedger(bytes: Buffer, ctx: ValidateCtx): ValidateResult {
  const errors: string[] = [];
  const push = (m: string): void => {
    if (errors.length < LEDGER_LIMITS.maxErrors) errors.push(m);
  };
  const readAssurance = readCapability(envFor(ctx.platform)).assurance;
  const parsed = parseBounded(bytes, LEDGER_LIMITS);
  if (!parsed.ok) return { ok: false, errors: parsed.errors, readAssurance };
  if (!Array.isArray(parsed.value)) return { ok: false, errors: ["$: ledger must be a top-level array of units"], readAssurance };
  const units = parsed.value as Record<string, unknown>[];

  const promoCache = new Map<string, PromotionRecord[] | null>();
  const promotions = (agent: string): PromotionRecord[] | null => {
    if (promoCache.has(agent)) return promoCache.get(agent) ?? null;
    let list: PromotionRecord[] | null = null;
    const r = readRunRel(ctx.runDir, `agents/${agent}/promotions.json`, 1024 * 1024, ctx.platform);
    if (r.ok) {
      try {
        const v = JSON.parse(r.bytes.toString("utf8"));
        if (Array.isArray(v)) list = v as PromotionRecord[];
      } catch { /* treated as missing */ }
    }
    promoCache.set(agent, list);
    return list;
  };

  const checkLocal = (at: string, c: LedgerUnit["local_checks"][number]): void => {
    if (!isValidAgentId(c.agent_id)) push(`${at}: invalid check agent_id`);
    for (const p of c.reviewed_paths) {
      const bad = checkRepoPath(p);
      if (bad) push(`${at}: reviewed path "${p}": ${bad}`);
    }
    if (c.method === "source") {
      if (c.artifact !== null) push(`${at}: source check must have artifact null`);
      if (c.assurance !== null) push(`${at}: source check must have assurance null`);
      return;
    }
    if (c.assurance === null) {
      push(`${at}: local check requires assurance`);
      return;
    }
    if (c.artifact === null) {
      push(`${at}: local check requires artifact`);
      return;
    }
    const prefix = `agents/${c.agent_id}/artifacts/`;
    if (!c.artifact.startsWith(prefix)) {
      push(`${at}: artifact must be under ${prefix}`);
      return;
    }
    const read = readRunRel(ctx.runDir, c.artifact, 5 * 1024 * 1024, ctx.platform);
    if (!read.ok) {
      push(`${at}: artifact unreadable (${read.step}: ${read.detail})`);
      return;
    }
    const rec = promotions(c.agent_id)?.find((r) => r.artifact_rel === c.artifact);
    if (!rec) push(`${at}: artifact has no promotion record`);
    else if (rec.assurance !== c.assurance) push(`${at}: assurance ${c.assurance} differs from promotion record ${rec.assurance}`);
  };

  const seenIds = new Set<string>();
  const seenTuples = new Map<string, string>();
  let prevId = "";
  units.forEach((raw, i) => {
    const at = `$[${i}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      push(`${at}: unit must be an object`);
      return;
    }
    const structural = validateSchema(stripBookkeeping(raw), UNIT_SCHEMA, { maxErrors: 10 });
    if (structural.length) {
      for (const m of structural) push(`${at}${m.slice(1)}`);
      return;
    }
    const u = raw as unknown as LedgerUnit;
    const derived = tryDeriveCoverageId(u.canonical_refs);
    if (!derived.ok) push(`${at}: ${derived.error}`);
    else if (derived.id !== u.coverage_id) push(`${at}: coverage_id does not equal the derived id`);
    for (const k of ["surface", "boundary", "subsystem", "attack_class", "lifecycle"] as const) {
      if (u[k] !== u.canonical_refs[k]) push(`${at}: ${k} differs from canonical_refs`);
    }
    if (u.coverage_id <= prevId && i > 0) push(`${at}: units must be sorted by coverage_id`);
    prevId = u.coverage_id;
    if (seenIds.has(u.coverage_id)) push(`${at}: duplicate coverage_id`);
    seenIds.add(u.coverage_id);
    if (derived.ok) {
      const prior = seenTuples.get(derived.id);
      if (prior !== undefined && prior !== u.coverage_id) push(`${at}: same tuple under a different id`);
      seenTuples.set(derived.id, u.coverage_id);
    }
    for (const p of [...u.starting_paths, ...u.reviewed_paths]) {
      const bad = checkRepoPath(p);
      if (bad) push(`${at}: path "${p}": ${bad}`);
    }

    const empty = u.reviewed_paths.length === 0 && u.local_checks.length === 0 && u.result_fingerprints.length === 0 && u.unresolved.length === 0;
    switch (u.status) {
      case "planned":
        if (u.agent_id !== null || !empty) push(`${at}: planned unit must have no agent and no results`);
        break;
      case "not_applicable":
      case "out_of_scope":
      case "deferred":
        if (u.agent_id !== null) push(`${at}: ${u.status} unit must have agent_id null`);
        if (u.unresolved.length === 0) push(`${at}: ${u.status} unit needs a non-empty unresolved`);
        break;
      case "in_progress":
        if (u.agent_id === null) push(`${at}: in_progress unit needs an owner`);
        break;
      case "blocked":
        if (!u.reviewed_paths.length || !u.local_checks.length) push(`${at}: blocked unit needs paths and checks`);
        if (!u.unresolved.length) push(`${at}: blocked unit needs unresolved`);
        break;
      case "covered":
        if (!u.reviewed_paths.length || !u.local_checks.length) push(`${at}: covered unit needs paths and checks`);
        if (u.unresolved.length) push(`${at}: covered unit must have empty unresolved`);
        break;
      case "candidate":
        if (!u.reviewed_paths.length || !u.local_checks.length || !u.result_fingerprints.length) {
          push(`${at}: candidate unit needs paths, checks and fingerprints`);
        }
        break;
    }
    if (u.agent_id !== null && !isValidAgentId(u.agent_id)) push(`${at}: invalid agent_id`);

    if (u.local_checks.length) {
      const union = u.local_checks.flatMap((c) => c.reviewed_paths);
      if (!sameSet(union, u.reviewed_paths)) push(`${at}: reviewed_paths must be exactly the union of the checks' paths`);
    }
    u.local_checks.forEach((c, j) => checkLocal(`${at}.local_checks[${j}]`, c));

    let lastWave = -1;
    const owners = new Set<string>();
    u.attempts.forEach((a, j) => {
      const aat = `${at}.attempts[${j}]`;
      if (a.wave <= lastWave) push(`${aat}: waves must strictly increase`);
      lastWave = a.wave;
      if (a.wave >= u.wave) push(`${aat}: live wave must exceed every attempt's wave`);
      if (!isValidAgentId(a.agent_id)) push(`${aat}: invalid agent_id`);
      if (owners.has(a.agent_id) || a.agent_id === u.agent_id) push(`${aat}: owner is not fresh`);
      owners.add(a.agent_id);
      a.local_checks.forEach((c, k) => checkLocal(`${aat}.local_checks[${k}]`, c));
    });
  });

  return { ok: errors.length === 0, errors, readAssurance };
}

/** Weakest assurance among a unit's local checks, used when linking findings to evidence. */
export function unitAssurance(u: Pick<LedgerUnit, "local_checks">): Assurance[] {
  return u.local_checks.flatMap((c) => (c.method === "local" && c.assurance ? [c.assurance] : []));
}
export { weakest };
