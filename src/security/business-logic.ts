import { createHash, randomUUID } from "node:crypto";
import { inScope, type CampaignScope, type HttpResult, type RequestEvidence } from "./scope.js";
import { coverageKey } from "./findings.js";
import type { PentestFinding } from "../tools/pentest.js";

// Business-logic verification for explicitly authorized state-changing
// operations. Three case families share one transport and state-witness model:
//
// - replay cases: submit once (positive control), then replay the identical
//   body to measure duplication versus server-side idempotency/dedup;
// - quota cases: submit up to a declared usage limit (each submission is a
//   positive control that must apply), then one excess submission to measure
//   whether the declared quota is enforced in status and in state;
// - step cases: an ordered prerequisite sequence ending in a protected final
//   step. The final step alone is executed first against a fresh state
//   (prerequisite-bypass probe); only if it does not apply is the full ordered
//   sequence executed as the positive control.
// - pricing cases: a POST operation with a declared expected amount (price,
//   discount or credit) for a numeric witness; the actual movement must match
//   the declared computation exactly, with the accepted request and a
//   non-zero witness movement acting as the measurement controls.
// - cancel cases: a state-changing POST followed by its declared cancel/refund
//   request. The operation must apply its declared delta first (positive
//   control); the compensation must then restore the witness by the declared
//   amount (full rollback by default, or an explicit partial compensation).
// - race cases: identical POST submissions fired concurrently (2–4) at one
//     operation with a declared execution bound. Tickets are reserved through
//     the paced budget first; the burst is then released simultaneously so the
//     requests genuinely overlap, and the number of actual applications must
//     not exceed the declared bound.
// - consistency cases: a declared known value compared across 2–3 GET layers
//     (for example a UI-facing aggregate and an authoritative record view) via
//     JSON Pointers. At least one layer must reproduce the declared value
//     (positive control) before any divergent layer is reported.

export interface OperationCase {
  path: string; bodyRef: string;
  statePath: string; statePointer: string; stateDelta: number;
}
export interface BusinessCase extends OperationCase { id: string; replays: number }
export interface QuotaCase extends OperationCase { id: string; limit: number }
export interface StepSpec { path: string; bodyRef?: string }
export interface StepCase { id: string; steps: StepSpec[]; statePath: string; statePointer: string; stateDelta: number }
export interface PricingCase extends OperationCase { id: string }
export interface RaceCase extends OperationCase { id: string; concurrency: number; allowed: number }
export interface ConsistencyLayer { path: string; pointer: string }
export interface ConsistencyCase { id: string; layers: ConsistencyLayer[]; valueRef: string }
export interface CancelCase {
  id: string; operationPath: string; operationBodyRef: string;
  cancelPath: string; cancelBodyRef: string;
  statePath: string; statePointer: string; stateDelta: number; expectedCompensation: number;
}
export interface BusinessProof {
  id: string; at: string; kind: "business_replay" | "business_quota" | "business_step" | "business_pricing" | "business_cancel" | "business_race" | "business_consistency"; caseId: string; target: string;
  outcome: "observed" | "not_observed" | "inconclusive";
  summary: string; requestIds: string[];
  observations: Record<string, string | number | boolean>;
}
export interface BusinessResult { proofs: BusinessProof[]; incomplete: boolean }

const ref = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(v);

function caseRules(value: unknown, scope: CampaignScope, profile: "quick" | "campaign", label: string, maxDelta = 1000) {
  if (value === undefined) return null;
  if (!Array.isArray(value)) throw Error(label + " cases must be an array");
  if (!value.length) return null;
  if (profile !== "campaign") throw Error(label + " cases require campaign mode");
  if (!scope.seeds.length) throw Error(label + " cases require a scoped target");
  if (value.length > 5) throw Error("At most five " + label.toLowerCase() + " cases");
  const exactPath = (p: unknown): p is string => typeof p === "string" && p.length <= 300 && p.startsWith("/") && !p.startsWith("//") && !/[?#%\\]/.test(p) && new URL(p, scope.seeds[0]!).pathname === p;
  const witness = (raw: Record<string, unknown>) => {
    if (!exactPath(raw.statePath)) throw Error(label + " case requires an exact state path without query or fragment");
    if (!inScope(scope, new URL(raw.statePath, scope.seeds[0]!).href)) throw Error(label + " state path is outside the approved scope");
    const pointer = raw.statePointer === undefined ? "" : raw.statePointer;
    if (typeof pointer !== "string" || pointer.length > 300 || (pointer !== "" && !pointer.startsWith("/")) || /~(?:[^01]|$)/.test(pointer)) throw Error(label + " state pointer must be a JSON Pointer");
    const delta = raw.stateDelta === undefined ? 1 : raw.stateDelta;
    if (typeof delta !== "number" || !Number.isInteger(delta) || delta === 0 || Math.abs(delta) > maxDelta) throw Error(label + " state delta must be a nonzero integer up to " + maxDelta);
    return { statePath: raw.statePath as string, statePointer: pointer, stateDelta: delta };
  };
  const common = (raw: Record<string, unknown>): OperationCase => {
    if (!ref(raw.id) || !ref(raw.bodyRef)) throw Error(label + " case requires id and bodyRef");
    if (!exactPath(raw.path)) throw Error(label + " case requires an exact POST path without query or fragment");
    if (!inScope(scope, new URL(raw.path, scope.seeds[0]!).href)) throw Error(label + " POST path is outside the approved scope");
    return { path: raw.path as string, bodyRef: raw.bodyRef as string, ...witness(raw) };
  };
  return { raw: value as Record<string, unknown>[], common, witness, exactPath };
}

export function normalizeBusinessCases(value: unknown, scope: CampaignScope, profile: "quick" | "campaign"): BusinessCase[] {
  const parsed = caseRules(value, scope, profile, "Business logic");
  if (!parsed) return [];
  const cases = parsed.raw.map((item): BusinessCase => {
    if (!item || typeof item !== "object") throw Error("Business case must be an object");
    const base = parsed.common(item);
    const replays = item.replays === undefined ? 1 : item.replays;
    if (typeof replays !== "number" || !Number.isInteger(replays) || replays < 1 || replays > 3) throw Error("Business replays must be 1–3");
    return { id: item.id as string, ...base, replays };
  });
  if (new Set(cases.map(c => c.id)).size !== cases.length) throw Error("Business case ids must be unique");
  return cases;
}

export function normalizeQuotaCases(value: unknown, scope: CampaignScope, profile: "quick" | "campaign"): QuotaCase[] {
  const parsed = caseRules(value, scope, profile, "Business quota");
  if (!parsed) return [];
  const cases = parsed.raw.map((item): QuotaCase => {
    if (!item || typeof item !== "object") throw Error("Business quota case must be an object");
    const base = parsed.common(item);
    const limit = item.limit;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 20) throw Error("Business quota limit must be 1–20");
    return { id: item.id as string, ...base, limit };
  });
  if (new Set(cases.map(c => c.id)).size !== cases.length) throw Error("Business quota case ids must be unique");
  return cases;
}

export function normalizeStepCases(value: unknown, scope: CampaignScope, profile: "quick" | "campaign"): StepCase[] {
  const parsed = caseRules(value, scope, profile, "Business step");  if (!parsed) return [];
  const cases = parsed.raw.map((item): StepCase => {
    if (!item || typeof item !== "object") throw Error("Business step case must be an object");
    if (!ref(item.id)) throw Error("Business step case requires id");
    if (!Array.isArray(item.steps) || item.steps.length < 2 || item.steps.length > 6) throw Error("Business step cases require 2–6 ordered steps; the last step is the protected final step");
    const steps = (item.steps as unknown[]).map((step): StepSpec => {
      if (!step || typeof step !== "object") throw Error("Business step must be an object");
      const raw = step as Record<string, unknown>;
      if (!parsed.exactPath(raw.path)) throw Error("Business step requires an exact scoped path without query or fragment");
      if (!inScope(scope, new URL(raw.path, scope.seeds[0]!).href)) throw Error("Business step path is outside the approved scope");
      // A step with bodyRef executes as POST; a step without it executes as GET.
      if (raw.bodyRef === undefined) return { path: raw.path as string };
      if (!ref(raw.bodyRef)) throw Error("Business step bodyRef must be a reference");
      return { path: raw.path as string, bodyRef: raw.bodyRef };
    });
    return { id: item.id as string, steps, ...parsed.witness(item) };
  });
  if (new Set(cases.map(c => c.id)).size !== cases.length) throw Error("Business step case ids must be unique");
  return cases;
}

export function normalizePricingCases(value: unknown, scope: CampaignScope, profile: "quick" | "campaign"): PricingCase[] {
  // Pricing deltas are amounts in minor units and may exceed the small counters
  // used by the other engines, so the bound is widened to 10^12.
  const parsed = caseRules(value, scope, profile, "Business pricing", 1e12);
  if (!parsed) return [];
  const cases = parsed.raw.map((item): PricingCase => {
    if (!item || typeof item !== "object") throw Error("Business pricing case must be an object");
    return { id: item.id as string, ...parsed.common(item) };
  });
  if (new Set(cases.map(c => c.id)).size !== cases.length) throw Error("Business pricing case ids must be unique");
  return cases;
}

export function normalizeRaceCases(value: unknown, scope: CampaignScope, profile: "quick" | "campaign"): RaceCase[] {
  const parsed = caseRules(value, scope, profile, "Business race");
  if (!parsed) return [];
  const cases = parsed.raw.map((item): RaceCase => {
    if (!item || typeof item !== "object") throw Error("Business race case must be an object");
    const base = parsed.common(item);
    const concurrency = item.concurrency === undefined ? 2 : item.concurrency;
    if (typeof concurrency !== "number" || !Number.isInteger(concurrency) || concurrency < 2 || concurrency > 4) throw Error("Business race concurrency must be 2–4 parallel submissions");
    const allowed = item.allowed === undefined ? 1 : item.allowed;
    if (typeof allowed !== "number" || !Number.isInteger(allowed) || allowed < 1 || allowed > concurrency) throw Error("Business race allowed executions must be 1–concurrency");
    return { id: item.id as string, ...base, concurrency, allowed };
  });
  if (new Set(cases.map(c => c.id)).size !== cases.length) throw Error("Business race case ids must be unique");
  return cases;
}

export function normalizeConsistencyCases(value: unknown, scope: CampaignScope, profile: "quick" | "campaign"): ConsistencyCase[] {
  const parsed = caseRules(value, scope, profile, "Business consistency");
  if (!parsed) return [];
  const cases = parsed.raw.map((item): ConsistencyCase => {
    if (!item || typeof item !== "object") throw Error("Business consistency case must be an object");
    if (!ref(item.id)) throw Error("Business consistency case requires id");
    if (!ref(item.valueRef)) throw Error("Business consistency case requires valueRef");
    if (!Array.isArray(item.layers) || item.layers.length < 2 || item.layers.length > 3) throw Error("Business consistency cases require 2–3 layer definitions");
    const layers = (item.layers as unknown[]).map((layer): ConsistencyLayer => {
      if (!layer || typeof layer !== "object") throw Error("Business consistency layer must be an object");
      const raw = layer as Record<string, unknown>;
      if (!parsed.exactPath(raw.path)) throw Error("Business consistency layer requires an exact scoped GET path without query or fragment");
      if (!inScope(scope, new URL(raw.path as string, scope.seeds[0]!).href)) throw Error("Business consistency layer path is outside the approved scope");
      const pointer = raw.pointer === undefined ? "" : raw.pointer;
      if (typeof pointer !== "string" || pointer.length > 300 || (pointer !== "" && !pointer.startsWith("/")) || /~(?:[^01]|$)/.test(pointer)) throw Error("Business consistency layer pointer must be a JSON Pointer");
      return { path: raw.path as string, pointer };
    });
    return { id: item.id as string, layers, valueRef: item.valueRef as string };
  });
  if (new Set(cases.map(c => c.id)).size !== cases.length) throw Error("Business consistency case ids must be unique");
  return cases;
}

export function normalizeCancelCases(value: unknown, scope: CampaignScope, profile: "quick" | "campaign"): CancelCase[] {
  // Charges and refunds are amounts in minor units, so the delta bound matches
  // the pricing engine rather than the small counters of the other engines.
  const parsed = caseRules(value, scope, profile, "Business cancel", 1e12);
  if (!parsed) return [];
  const cases = parsed.raw.map((item): CancelCase => {
    if (!item || typeof item !== "object") throw Error("Business cancel case must be an object");
    if (!ref(item.id)) throw Error("Business cancel case requires id");
    for (const key of ["operationPath", "cancelPath"] as const) {
      if (!parsed.exactPath(item[key])) throw Error("Business cancel case requires an exact " + key.replace("Path", " path") + " without query or fragment");
      if (!inScope(scope, new URL(item[key] as string, scope.seeds[0]!).href)) throw Error("Business cancel " + key.replace("Path", " path") + " is outside the approved scope");
    }
    for (const key of ["operationBodyRef", "cancelBodyRef"] as const) if (!ref(item[key])) throw Error("Business cancel case requires " + key);
    const witness = parsed.witness(item);
    const expectedCompensation = item.expectedCompensation === undefined ? -witness.stateDelta : item.expectedCompensation;
    if (typeof expectedCompensation !== "number" || !Number.isInteger(expectedCompensation) || expectedCompensation === 0 || Math.abs(expectedCompensation) > 1e12) throw Error("Business cancel expectedCompensation must be a nonzero integer up to 1000000000000");
    return { id: item.id as string, operationPath: item.operationPath as string, operationBodyRef: item.operationBodyRef as string, cancelPath: item.cancelPath as string, cancelBodyRef: item.cancelBodyRef as string, ...witness, expectedCompensation };
  });
  if (new Set(cases.map(c => c.id)).size !== cases.length) throw Error("Business cancel case ids must be unique");
  return cases;
}

export function normalizeBusinessSecrets(value: unknown, ...lists: Array<Array<{ bodyRef: string }>>): Record<string, string> {
  const all = lists.flat();
  if (!all.length) return {};
  if (value === undefined || !value || typeof value !== "object" || Array.isArray(value)) throw Error("Business logic cases require fresh input: " + all[0]!.bodyRef);
  const values = value as Record<string, unknown>, result: Record<string, string> = {};
  for (const c of all) {
    const body = values[c.bodyRef];
    if (body === undefined) throw Error("Supply fresh business input: " + c.bodyRef);
    if (typeof body !== "string" || Buffer.byteLength(body) > 8192) throw Error("Business operation body must be JSON up to 8192 bytes: " + c.bodyRef);
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { throw Error("Business operation body must be valid JSON: " + c.bodyRef); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Error("Business operation body must be a JSON object: " + c.bodyRef);
    result[c.bodyRef] = body;
  }
  return result;
}

// Consistency declared values are plain strings compared exactly across
// layers; they are not operation bodies and get their own validation.
export function normalizeConsistencyValues(value: unknown, cases: ConsistencyCase[]): Record<string, string> {
  if (!cases.length) return {};
  if (value === undefined || !value || typeof value !== "object" || Array.isArray(value)) throw Error("Business logic cases require fresh input: " + cases[0]!.valueRef);
  const values = value as Record<string, unknown>, result: Record<string, string> = {};
  for (const c of cases) {
    const declared = values[c.valueRef];
    if (declared === undefined) throw Error("Supply fresh business input: " + c.valueRef);
    if (typeof declared !== "string" || !declared.trim() || declared.length > 8192) throw Error("Business consistency value must be a nonempty string up to 8192 bytes: " + c.valueRef);
    result[c.valueRef] = declared;
  }
  return result;
}

function resolvePointer(data: unknown, pointer: string): unknown {
  let value = data;
  for (const key of pointer === "" ? [] : pointer.slice(1).split("/").map(v => v.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (value === null || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export type BusinessEngineInput = {
  scope: CampaignScope; secrets: Record<string, string>;
  auth: Record<string, string>; signal: AbortSignal; evidence: RequestEvidence[];
  reserve: () => Promise<{ id: string; at: number }>; redact: (value: string) => string;
  request: (url: string) => Promise<HttpResult>;
  result: BusinessResult;
  publish: (proof: BusinessProof, findings: PentestFinding[], covered: string[]) => void;
};

function buildContext(input: BusinessEngineInput) {
  const { scope, secrets, auth, signal, evidence, reserve, redact, request } = input;
  // Body values are operator-supplied test data; never echo them into evidence
  // text. Plain non-JSON secrets (consistency declared values) are redacted
  // as-is; JSON bodies contribute all of their string leaves.
  const privateValues = new Set<string>();
  for (const body of Object.values(secrets)) {
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { privateValues.add(body); continue; }
    const pending: unknown[] = [parsed];
    while (pending.length) {
      const value = pending.pop();
      if (typeof value === "string" && value) privateValues.add(value);
      else if (value && typeof value === "object") pending.push(...(Array.isArray(value) ? value : Object.values(value)));
    }
  }
  const scrub = (value: string) => [...privateValues].reduce((acc, secret) => secret ? acc.split(secret).join("[REDACTED]") : acc, redact(value));
  const hash = (data: string) => createHash("sha256").update(data).digest("hex");
  const readState = async (c: Pick<OperationCase, "statePath" | "statePointer">): Promise<{ ok: true; value: number } | { ok: false; reason: string }> => {
    const url = new URL(c.statePath, scope.seeds[0]!).href;
    const res = await request(url);
    if (!res.ok) return { ok: false, reason: "State witness request failed (HTTP " + res.status + ")" + (res.error ? ": " + scrub(res.error) : "") };
    if (res.bodyTruncated) return { ok: false, reason: "State witness response was truncated" };
    let data: unknown;
    try { data = JSON.parse(res.body); } catch { return { ok: false, reason: "State witness response was not valid JSON" }; }
    const value = resolvePointer(data, c.statePointer);
    if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, reason: "State pointer did not resolve to a finite number" };
    return { ok: true, value };
  };
  const postWithTicket = async (c: { path: string; bodyRef: string }, ticket: { id: string; at: number }): Promise<{ status: number }> => {
    const url = new URL(c.path, scope.seeds[0]!).href;
    signal.throwIfAborted();
    if (!inScope(scope, url)) throw Error("Business POST path left the approved scope");
    const started = Date.now(), body = secrets[c.bodyRef]!;
    const item: RequestEvidence = { id: ticket.id, at: new Date(ticket.at).toISOString(), url, method: "POST", authenticated: !!Object.keys(auth).length, status: 0, durationMs: 0, bodyHash: "", bytes: 0, contentType: "", engine: "http", requestBytes: Buffer.byteLength(body), postPolicy: c.path };
    evidence.push(item);
    try {
      const res = await fetch(url, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body, redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
      const chunks: Uint8Array[] = []; let bytes = 0, truncated = false;
      const reader = res.body?.getReader();
      if (reader) try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          const chunk = part.value.subarray(0, 32768 - bytes); chunks.push(chunk); bytes += chunk.length;
          if (chunk.length < part.value.length) { truncated = true; break; }
        }
      } finally { await reader.cancel().catch(() => {}); }
      const text = Buffer.concat(chunks).toString("utf8");
      item.status = res.status; item.bytes = bytes; item.bodyHash = hash(text);
      item.contentType = redact(res.headers.get("content-type")?.split(";")[0] ?? "");
      if (truncated) { item.bodyTruncated = true; item.error = "Response body exceeded 32768 bytes"; }
      return { status: res.status };
    } catch (error) {
      item.error = redact("Business operation request failed: " + (error instanceof Error ? error.message : String(error)));
      return { status: 0 };
    } finally { item.durationMs = Date.now() - started; }
  };
  const post = async (c: { path: string; bodyRef: string }): Promise<{ status: number }> => postWithTicket(c, await reserve());
  return { scrub, readState, post, postWithTicket };
}

export async function runBusinessCases(input: BusinessEngineInput, cases: BusinessCase[]): Promise<void> {
  const { scope, signal, evidence, result } = input;
  const { scrub, readState, post } = buildContext(input);
  for (const c of cases) {
    signal.throwIfAborted();
    const target = new URL(c.path, scope.seeds[0]!).href, offset = evidence.length;
    const proof: BusinessProof = { id: randomUUID(), at: new Date().toISOString(), kind: "business_replay", caseId: c.id, target, outcome: "inconclusive", summary: "Business logic verification did not complete", requestIds: [], observations: { replays: c.replays, stateDelta: c.stateDelta, statePath: c.statePath, statePointer: c.statePointer } };
    const finish = (findings: PentestFinding[], covered: string[]) => {
      proof.requestIds = evidence.slice(offset).map(e => e.id);
      if (proof.outcome === "inconclusive") result.incomplete = true;
      result.proofs.push(proof);
      input.publish(proof, findings.map(f => ({ ...f, title: scrub(f.title), detail: scrub(f.detail) })), covered);
    };
    try {
      const before = await readState(c);
      if (!before.ok) { proof.summary = "State witness unavailable before the operation: " + before.reason; finish([], []); continue; }
      const first = await post(c);
      if (first.status < 200 || first.status >= 300) { proof.summary = "Operation was not accepted (HTTP " + first.status + "); review the case body, authentication and authorization"; proof.observations.firstStatus = first.status; finish([], []); continue; }
      const mid = await readState(c);
      if (!mid.ok) { proof.summary = "State witness unavailable after the first submission: " + mid.reason; proof.observations.firstStatus = first.status; finish([], []); continue; }
      if (mid.value !== before.value + c.stateDelta) { proof.summary = "Positive control failed: the state witness did not change by the declared delta (" + before.value + " → " + mid.value + ", expected " + c.stateDelta + ")"; proof.observations = { ...proof.observations, firstStatus: first.status, stateBefore: before.value, stateAfterFirst: mid.value }; finish([], []); continue; }
      const replayStatuses: number[] = [];
      for (let i = 0; i < c.replays; i++) replayStatuses.push((await post(c)).status);
      const after = await readState(c);
      if (!after.ok) { proof.summary = "Final state witness unavailable: " + after.reason; proof.observations = { ...proof.observations, firstStatus: first.status, stateBefore: before.value, stateAfterFirst: mid.value, replayStatuses: replayStatuses.join(", ") }; finish([], []); continue; }
      const applied = (after.value - mid.value) / c.stateDelta;
      const transportValid = replayStatuses.every(s => s > 0);
      const accepted = replayStatuses.filter(s => s >= 200 && s < 300).length;
      const rejected = replayStatuses.filter(s => [409, 422].includes(s)).length;
      proof.observations = { ...proof.observations, firstStatus: first.status, replayStatuses: replayStatuses.join(", "), acceptedReplays: accepted, rejectedReplays: rejected, stateBefore: before.value, stateAfterFirst: mid.value, stateAfterReplays: after.value, appliedAdditional: applied, transportValid, executions: 1 + c.replays };
      const check = "business_replay_" + createHash("sha256").update(c.id).digest("hex").slice(0, 16);
      if (!transportValid || !Number.isInteger(applied) || applied < 0) {
        proof.summary = !transportValid ? "A replayed submission did not complete at the transport level" : "The state witness changed by an amount that does not map to whole operation executions (" + (after.value - mid.value) + ")";
        finish([], []); continue;
      }
      if (applied === 0) {
        proof.outcome = "not_observed";
        proof.summary = accepted === 0 && rejected > 0
          ? "Every replayed submission was rejected (duplicate rejection) and the state witness did not advance"
          : "A replayed submission was accepted but the operation was not applied again (server-side idempotency or deduplication)";
        finish([], [coverageKey(target, check)]);
        continue;
      }
      proof.outcome = "observed";
      proof.summary = "Replaying the identical submission applied the operation " + applied + " additional time(s)";
      const finding: PentestFinding = {
        id: check, check, verdict: "finding", severity: "medium", target,
        title: "Duplicated submission re-applied a declared state-changing operation: " + c.id,
        detail: "The first submission applied the declared state delta (positive control). Replaying the identical body " + c.replays + " time(s) applied the operation again: state moved from " + mid.value + " to " + after.value + " with replay statuses [" + replayStatuses.join(", ") + "]. Impact depends on the operation semantics (for example duplicate orders, charges or messages). Duplicate records created by this test may persist; plan test-data cleanup separately.",
        remediation: "Make this operation idempotent (idempotency key or unique constraint), reject or deduplicate identical repeated submissions server-side, and re-run this case after repair.",
      };
      finish([finding], [coverageKey(target, check)]);
    } catch (error) {
      signal.throwIfAborted();
      proof.summary = "Business case could not be executed: " + scrub(error instanceof Error ? error.message : String(error));
      finish([], []);
    }
  }
}

export async function runQuotaCases(input: BusinessEngineInput, cases: QuotaCase[]): Promise<void> {
  const { scope, signal, evidence, result } = input;
  const { scrub, readState, post } = buildContext(input);
  for (const c of cases) {
    signal.throwIfAborted();
    const target = new URL(c.path, scope.seeds[0]!).href, offset = evidence.length;
    const proof: BusinessProof = { id: randomUUID(), at: new Date().toISOString(), kind: "business_quota", caseId: c.id, target, outcome: "inconclusive", summary: "Business quota verification did not complete", requestIds: [], observations: { limit: c.limit, stateDelta: c.stateDelta, statePath: c.statePath, statePointer: c.statePointer } };
    const finish = (findings: PentestFinding[], covered: string[]) => {
      proof.requestIds = evidence.slice(offset).map(e => e.id);
      if (proof.outcome === "inconclusive") result.incomplete = true;
      result.proofs.push(proof);
      input.publish(proof, findings.map(f => ({ ...f, title: scrub(f.title), detail: scrub(f.detail) })), covered);
    };
    try {
      const before = await readState(c);
      if (!before.ok) { proof.summary = "State witness unavailable before the operation: " + before.reason; finish([], []); continue; }
      const controlStatuses: number[] = [];
      let current = before.value;
      let controlFailed = "";
      for (let i = 0; i < c.limit; i++) {
        const status = (await post(c)).status;
        controlStatuses.push(status);
        if (!(status >= 200 && status < 300)) { controlFailed = "Control submission " + (i + 1) + " of the declared limit was rejected (HTTP " + status + "); the enforced limit may be lower than the declared one"; break; }
        const mid = await readState(c);
        if (!mid.ok) { controlFailed = "State witness unavailable during control submission " + (i + 1) + ": " + mid.reason; break; }
        if (mid.value !== current + c.stateDelta) { controlFailed = "Positive control failed at submission " + (i + 1) + ": state moved from " + current + " to " + mid.value + " instead of the declared delta " + c.stateDelta; break; }
        current = mid.value;
      }
      if (controlFailed) { proof.summary = controlFailed; proof.observations.controlStatuses = controlStatuses.join(", "); proof.observations.stateBefore = before.value; finish([], []); continue; }
      const excess = await post(c);
      const after = await readState(c);
      if (!after.ok) { proof.summary = "Final state witness unavailable: " + after.reason; proof.observations = { ...proof.observations, controlStatuses: controlStatuses.join(", "), excessStatus: excess.status }; finish([], []); continue; }
      const applied = (after.value - current) / c.stateDelta;
      proof.observations = { ...proof.observations, controlStatuses: controlStatuses.join(", "), excessStatus: excess.status, stateBefore: before.value, stateAtLimit: current, stateAfterExcess: after.value, appliedBeyondLimit: applied, executions: c.limit + 1, transportValid: excess.status > 0 };
      const check = "business_quota_" + createHash("sha256").update(c.id).digest("hex").slice(0, 16);
      if (!(excess.status > 0) || !Number.isInteger(applied) || applied < 0) {
        proof.summary = !(excess.status > 0) ? "The excess submission did not complete at the transport level" : "The state witness changed by an amount that does not map to whole operation executions (" + (after.value - current) + ")";
        finish([], []); continue;
      }
      if (applied === 0) {
        proof.outcome = "not_observed";
        const rejected = [403, 409, 422, 429].includes(excess.status);
        proof.summary = rejected
          ? "The submission beyond the declared limit was rejected (HTTP " + excess.status + ") and the state witness did not advance"
          : "The submission beyond the declared limit returned HTTP " + excess.status + " without applying the operation again; the declared quota held in state";
        finish([], [coverageKey(target, check)]);
        continue;
      }
      proof.outcome = "observed";
      proof.summary = (excess.status >= 200 && excess.status < 300)
        ? "A submission beyond the declared limit was accepted and applied the operation again"
        : "The submission beyond the declared limit returned an error (HTTP " + excess.status + ") yet still advanced the state witness";
      const finding: PentestFinding = {
        id: check, check, verdict: "finding", severity: "medium", target,
        title: "Declared usage limit was exceeded without enforcement: " + c.id,
        detail: "All " + c.limit + " control submissions applied the declared delta (positive control; state " + before.value + " → " + current + "). One further identical submission returned HTTP " + excess.status + " and moved the state witness to " + after.value + ", beyond the declared limit of " + c.limit + " executions. Impact depends on the operation semantics (for example free credits, votes, trials or rate-limited grants). Extra records created by this test may persist; plan test-data cleanup separately.",
        remediation: "Enforce the declared usage limit server-side for this operation and identity (counter with a unique key, or a database constraint), reject submissions beyond it, and re-run this case after repair.",
      };
      finish([finding], [coverageKey(target, check)]);
    } catch (error) {
      signal.throwIfAborted();
      proof.summary = "Business quota case could not be executed: " + scrub(error instanceof Error ? error.message : String(error));
      finish([], []);
    }
  }
}

export async function runStepCases(input: BusinessEngineInput, cases: StepCase[]): Promise<void> {
  const { scope, signal, evidence, result } = input;
  const { scrub, readState, post } = buildContext(input);
  const executeSteps = async (steps: StepSpec[]): Promise<{ ok: boolean; stepIndex: number; status: number; statuses: number[] }> => {
    const statuses: number[] = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      // Steps with a body execute as POST; steps without one execute as GET.
      const status = step.bodyRef ? (await post({ path: step.path, bodyRef: step.bodyRef })).status : (await input.request(new URL(step.path, scope.seeds[0]!).href)).status;
      statuses.push(status);
      if (!(status >= 200 && status < 300)) return { ok: false, stepIndex: i, status, statuses };
    }
    return { ok: true, stepIndex: steps.length - 1, status: statuses[statuses.length - 1] ?? 0, statuses };
  };
  for (const c of cases) {
    signal.throwIfAborted();
    const final = c.steps[c.steps.length - 1]!;
    const target = new URL(final.path, scope.seeds[0]!).href, offset = evidence.length;
    const proof: BusinessProof = { id: randomUUID(), at: new Date().toISOString(), kind: "business_step", caseId: c.id, target, outcome: "inconclusive", summary: "Business step-order verification did not complete", requestIds: [], observations: { steps: c.steps.length, stateDelta: c.stateDelta, statePath: c.statePath, statePointer: c.statePointer } };
    const finish = (findings: PentestFinding[], covered: string[]) => {
      proof.requestIds = evidence.slice(offset).map(e => e.id);
      if (proof.outcome === "inconclusive") result.incomplete = true;
      result.proofs.push(proof);
      input.publish(proof, findings.map(f => ({ ...f, title: scrub(f.title), detail: scrub(f.detail) })), covered);
    };
    try {
      const before = await readState(c);
      if (!before.ok) { proof.summary = "State witness unavailable before the bypass probe: " + before.reason; finish([], []); continue; }
      const bypass = await executeSteps([final]);
      if (bypass.status === 0) { proof.summary = "The final step did not complete at the transport level during the bypass probe"; proof.observations.bypassStatus = bypass.status; finish([], []); continue; }
      const afterBypass = await readState(c);
      if (!afterBypass.ok) { proof.summary = "State witness unavailable after the bypass probe: " + afterBypass.reason; proof.observations.bypassStatus = bypass.status; finish([], []); continue; }
      const bypassDelta = afterBypass.value - before.value;
      const check = "business_step_" + createHash("sha256").update(c.id).digest("hex").slice(0, 16);
      if (bypassDelta === c.stateDelta) {
        proof.outcome = "observed";
        proof.summary = "The final step applied the declared effect without any declared prerequisite";
        const finding: PentestFinding = {
          id: check, check, verdict: "finding", severity: "medium", target,
          title: "Final operation step applied without its declared prerequisites: " + c.id,
          detail: "With a fresh state, executing only the final step (" + final.path + ", HTTP " + bypass.status + ") moved the state witness from " + before.value + " to " + afterBypass.value + " by the declared delta " + c.stateDelta + ". The declared prerequisite sequence was never executed in this probe. The ordered control sequence was skipped to avoid repeating side effects once the bypass already applied. Impact depends on the workflow (for example shipping, payout or approval effects reached before their prerequisites). Records created by this test may persist; plan test-data cleanup separately.",
          remediation: "Enforce the prerequisite or approval state machine server-side before executing this step, and re-run this case after repair.",
        };
        proof.observations = { ...proof.observations, bypassStatus: bypass.status, stateBefore: before.value, stateAfterBypass: afterBypass.value, bypassApplied: true, controlSkipped: true };
        finish([finding], [coverageKey(target, check)]);
        continue;
      }
      if (bypassDelta !== 0) { proof.summary = "The state witness changed unexpectedly during the bypass probe (" + bypassDelta + " instead of 0 or " + c.stateDelta + ")"; proof.observations = { ...proof.observations, bypassStatus: bypass.status, stateBefore: before.value, stateAfterBypass: afterBypass.value }; finish([], []); continue; }
      const control = await executeSteps(c.steps);
      if (!control.ok) { proof.summary = control.status === 0 ? "The ordered control sequence did not complete at the transport level" : "The ordered control sequence was rejected at step " + (control.stepIndex + 1) + " (HTTP " + control.status + "); review the declared steps and bodies"; proof.observations = { ...proof.observations, bypassStatus: bypass.status, controlStatuses: control.statuses.join(", ") }; finish([], []); continue; }
      const afterControl = await readState(c);
      if (!afterControl.ok) { proof.summary = "State witness unavailable after the control sequence: " + afterControl.reason; proof.observations = { ...proof.observations, bypassStatus: bypass.status, controlStatuses: control.statuses.join(", ") }; finish([], []); continue; }
      const applied = afterControl.value === afterBypass.value + c.stateDelta;
      proof.observations = { ...proof.observations, bypassStatus: bypass.status, controlStatuses: control.statuses.join(", "), stateBefore: before.value, stateAfterBypass: afterBypass.value, stateAfterControl: afterControl.value, bypassApplied: false, controlApplied: applied };
      if (!applied) { proof.summary = "The ordered control sequence completed but the state witness did not change by the declared delta (" + afterBypass.value + " → " + afterControl.value + ")"; finish([], []); continue; }
      proof.outcome = "not_observed";
      proof.summary = bypass.status >= 400
        ? "The final step alone was rejected (HTTP " + bypass.status + ") and the full ordered sequence applied the declared effect"
        : "The final step alone did not apply the declared effect and the full ordered sequence applied it";
      finish([], [coverageKey(target, check)]);
      continue;
    } catch (error) {
      signal.throwIfAborted();
      proof.summary = "Business step case could not be executed: " + scrub(error instanceof Error ? error.message : String(error));
      finish([], []);
    }
  }
}

export async function runPricingCases(input: BusinessEngineInput, cases: PricingCase[]): Promise<void> {
  const { scope, signal, evidence, result } = input;
  const { scrub, readState, post } = buildContext(input);
  for (const c of cases) {
    signal.throwIfAborted();
    const target = new URL(c.path, scope.seeds[0]!).href, offset = evidence.length;
    const proof: BusinessProof = { id: randomUUID(), at: new Date().toISOString(), kind: "business_pricing", caseId: c.id, target, outcome: "inconclusive", summary: "Business pricing verification did not complete", requestIds: [], observations: { expectedDelta: c.stateDelta, statePath: c.statePath, statePointer: c.statePointer } };
    const finish = (findings: PentestFinding[], covered: string[]) => {
      proof.requestIds = evidence.slice(offset).map(e => e.id);
      if (proof.outcome === "inconclusive") result.incomplete = true;
      result.proofs.push(proof);
      input.publish(proof, findings.map(f => ({ ...f, title: scrub(f.title), detail: scrub(f.detail) })), covered);
    };
    try {
      const before = await readState(c);
      if (!before.ok) { proof.summary = "State witness unavailable before the operation: " + before.reason; finish([], []); continue; }
      const submitted = await post(c);
      if (submitted.status < 200 || submitted.status >= 300) { proof.summary = "Operation was not accepted (HTTP " + submitted.status + "); review the case body, authentication and authorization"; proof.observations.postStatus = submitted.status; finish([], []); continue; }
      const after = await readState(c);
      if (!after.ok) { proof.summary = "State witness unavailable after the operation: " + after.reason; proof.observations.postStatus = submitted.status; finish([], []); continue; }
      const moved = after.value - before.value;
      const check = "business_pricing_" + createHash("sha256").update(c.id).digest("hex").slice(0, 16);
      proof.observations = { ...proof.observations, postStatus: submitted.status, stateBefore: before.value, stateAfter: after.value, moved, directionReversed: Math.sign(moved) !== Math.sign(c.stateDelta) };
      // A non-zero movement proves the witness measures this operation; without
      // it a mismatch cannot be distinguished from a misdeclared witness.
      if (moved === 0) { proof.summary = "The operation was accepted but the state witness did not move; a zero charge and an unresponsive witness cannot be distinguished"; finish([], []); continue; }
      if (moved === c.stateDelta) {
        proof.outcome = "not_observed";
        proof.summary = "The operation moved the declared witness by exactly the declared amount";
        finish([], [coverageKey(target, check)]);
        continue;
      }
      proof.outcome = "observed";
      proof.summary = Math.sign(moved) !== Math.sign(c.stateDelta)
        ? "The operation moved the declared witness in the opposite direction of the declared amount"
        : "The operation moved the declared witness by " + moved + " instead of the declared " + c.stateDelta;
      const finding: PentestFinding = {
        id: check, check, verdict: "finding", severity: "medium", target,
        title: (Math.sign(moved) !== Math.sign(c.stateDelta) ? "Operation applied the declared amount in the opposite direction: " : "Operation amount differs from the declared computation: ") + c.id,
        detail: "The accepted submission (HTTP " + submitted.status + ") moved the state witness from " + before.value + " to " + after.value + " (movement " + moved + ") where the declared price/discount/credit computation expects " + c.stateDelta + " in the same minor units. The declared expectation is the operator's model of the correct arithmetic; verify the currency and unit scale before acting. Impact depends on the direction (overcharge, undercharge, inverted credit or refund). Records created by this test may persist; plan test-data cleanup separately.",
        remediation: "Recompute prices, discounts and credits server-side from authoritative data and re-validate the declared arithmetic; never trust client-supplied totals. Re-run this case after repair.",
      };
      finish([finding], [coverageKey(target, check)]);
    } catch (error) {
      signal.throwIfAborted();
      proof.summary = "Business pricing case could not be executed: " + scrub(error instanceof Error ? error.message : String(error));
      finish([], []);
    }
  }
}

export async function runCancelCases(input: BusinessEngineInput, cases: CancelCase[]): Promise<void> {
  const { scope, signal, evidence, result } = input;
  const { scrub, readState, post } = buildContext(input);
  for (const c of cases) {
    signal.throwIfAborted();
    const target = new URL(c.cancelPath, scope.seeds[0]!).href, offset = evidence.length;
    const proof: BusinessProof = { id: randomUUID(), at: new Date().toISOString(), kind: "business_cancel", caseId: c.id, target, outcome: "inconclusive", summary: "Business cancel verification did not complete", requestIds: [], observations: { stateDelta: c.stateDelta, expectedCompensation: c.expectedCompensation, statePath: c.statePath, statePointer: c.statePointer } };
    const finish = (findings: PentestFinding[], covered: string[]) => {
      proof.requestIds = evidence.slice(offset).map(e => e.id);
      if (proof.outcome === "inconclusive") result.incomplete = true;
      result.proofs.push(proof);
      input.publish(proof, findings.map(f => ({ ...f, title: scrub(f.title), detail: scrub(f.detail) })), covered);
    };
    try {
      const before = await readState(c);
      if (!before.ok) { proof.summary = "State witness unavailable before the operation: " + before.reason; finish([], []); continue; }
      const operation = await post({ path: c.operationPath, bodyRef: c.operationBodyRef });
      if (operation.status < 200 || operation.status >= 300) { proof.summary = "Operation was not accepted (HTTP " + operation.status + "); review the case body, authentication and authorization"; proof.observations.operationStatus = operation.status; finish([], []); continue; }
      const mid = await readState(c);
      if (!mid.ok) { proof.summary = "State witness unavailable after the operation: " + mid.reason; proof.observations.operationStatus = operation.status; finish([], []); continue; }
      if (mid.value !== before.value + c.stateDelta) { proof.summary = "Positive control failed: the operation did not apply the declared delta (" + before.value + " → " + mid.value + ", expected " + c.stateDelta + ")"; proof.observations = { ...proof.observations, operationStatus: operation.status, stateBefore: before.value, stateAfterOperation: mid.value }; finish([], []); continue; }
      const cancel = await post({ path: c.cancelPath, bodyRef: c.cancelBodyRef });
      if (cancel.status === 0) { proof.summary = "The cancel/refund request did not complete at the transport level"; proof.observations = { ...proof.observations, operationStatus: operation.status, cancelStatus: cancel.status }; finish([], []); continue; }
      const after = await readState(c);
      if (!after.ok) { proof.summary = "State witness unavailable after the cancel/refund: " + after.reason; proof.observations = { ...proof.observations, operationStatus: operation.status, cancelStatus: cancel.status }; finish([], []); continue; }
      const moved = after.value - mid.value;
      const check = "business_cancel_" + createHash("sha256").update(c.id).digest("hex").slice(0, 16);
      const accepted = cancel.status >= 200 && cancel.status < 300;
      proof.observations = { ...proof.observations, operationStatus: operation.status, cancelStatus: cancel.status, stateBefore: before.value, stateAfterOperation: mid.value, stateAfterCancel: after.value, moved };
      if (moved === c.expectedCompensation) {
        proof.outcome = "not_observed";
        proof.summary = accepted
          ? "The cancel/refund applied the declared compensation and restored the declared state"
          : "The declared compensation applied although the cancel request returned HTTP " + cancel.status;
        finish([], [coverageKey(target, check)]);
        continue;
      }
      if (accepted) {
        proof.outcome = "observed";
        proof.summary = "The cancel/refund was accepted but moved the state witness by " + moved + " instead of the declared compensation " + c.expectedCompensation;
        const finding: PentestFinding = {
          id: check, check, verdict: "finding", severity: "medium", target,
          title: "Cancel/refund did not restore the declared state: " + c.id,
          detail: "The operation applied its declared delta (positive control; state " + before.value + " → " + mid.value + "). The accepted cancel/refund (HTTP " + cancel.status + ") then moved the witness to " + after.value + " (movement " + moved + ") where the declared compensation is " + c.expectedCompensation + " in the same minor units. Impact depends on the direction (kept charges after a promised refund, partial or double refunds). Asynchronous settlement can show the same signature; verify final settlement before acting. Records created by this test may persist; plan test-data cleanup separately.",
          remediation: "Implement the declared rollback atomically with the cancel/refund (transactional reversal or explicit partial-compensation policy), and re-run this case after repair.",
        };
        finish([finding], [coverageKey(target, check)]);
        continue;
      }
      if (moved !== 0) {
        proof.outcome = "observed";
        proof.summary = "The cancel/refund request was rejected (HTTP " + cancel.status + ") yet still moved the state witness by " + moved;
        const finding: PentestFinding = {
          id: check, check, verdict: "finding", severity: "medium", target,
          title: "Rejected cancel/refund still changed state: " + c.id,
          detail: "The operation applied its declared delta (positive control; state " + before.value + " → " + mid.value + "). The cancel/refund then returned HTTP " + cancel.status + " while moving the witness to " + after.value + " (movement " + moved + "), although a rejected request must not change state. Impact depends on the direction (unauthorized refunds or reversals on denial). Records created by this test may persist; plan test-data cleanup separately.",
          remediation: "Apply the compensation only when the cancel/refund is accepted, atomically with the decision, and re-run this case after repair.",
        };
        finish([finding], [coverageKey(target, check)]);
        continue;
      }
      proof.summary = "The cancel/refund request was rejected (HTTP " + cancel.status + ") and the state did not change; review whether this operation is cancellable under the declared policy";
      finish([], []);
    } catch (error) {
      signal.throwIfAborted();
      proof.summary = "Business cancel case could not be executed: " + scrub(error instanceof Error ? error.message : String(error));
      finish([], []);
    }
  }
}

export async function runRaceCases(input: BusinessEngineInput, cases: RaceCase[]): Promise<void> {
  const { scope, signal, evidence, result, reserve } = input;
  const { scrub, readState, postWithTicket } = buildContext(input);
  for (const c of cases) {
    signal.throwIfAborted();
    const target = new URL(c.path, scope.seeds[0]!).href, offset = evidence.length;
    const proof: BusinessProof = { id: randomUUID(), at: new Date().toISOString(), kind: "business_race", caseId: c.id, target, outcome: "inconclusive", summary: "Business race verification did not complete", requestIds: [], observations: { concurrency: c.concurrency, allowed: c.allowed, stateDelta: c.stateDelta, statePath: c.statePath, statePointer: c.statePointer } };
    const finish = (findings: PentestFinding[], covered: string[]) => {
      proof.requestIds = evidence.slice(offset).map(e => e.id);
      if (proof.outcome === "inconclusive") result.incomplete = true;
      result.proofs.push(proof);
      input.publish(proof, findings.map(f => ({ ...f, title: scrub(f.title), detail: scrub(f.detail) })), covered);
    };
    try {
      const before = await readState(c);
      if (!before.ok) { proof.summary = "State witness unavailable before the burst: " + before.reason; finish([], []); continue; }
      // Reserve every ticket through the paced budget first, then release the
      // burst simultaneously so the requests genuinely overlap in flight.
      const tickets: Array<{ id: string; at: number }> = [];
      for (let i = 0; i < c.concurrency; i++) tickets.push(await reserve());
      signal.throwIfAborted();
      const burst = await Promise.all(tickets.map(ticket => postWithTicket({ path: c.path, bodyRef: c.bodyRef }, ticket)));
      const statuses = burst.map(b => b.status);
      const after = await readState(c);
      if (!after.ok) { proof.summary = "State witness unavailable after the burst: " + after.reason; proof.observations.burstStatuses = statuses.join(", "); finish([], []); continue; }
      const applied = (after.value - before.value) / c.stateDelta;
      const accepted = statuses.filter(s => s >= 200 && s < 300).length;
      const transportValid = statuses.every(s => s > 0);
      const check = "business_race_" + createHash("sha256").update(c.id).digest("hex").slice(0, 16);
      proof.observations = { ...proof.observations, burstStatuses: statuses.join(", "), acceptedSubmissions: accepted, stateBefore: before.value, stateAfterBurst: after.value, appliedExecutions: applied, transportValid };
      if (!transportValid || !Number.isInteger(applied) || applied < 0) {
        proof.summary = !transportValid ? "A concurrent submission did not complete at the transport level" : "The state witness changed by an amount that does not map to whole operation executions (" + (after.value - before.value) + ")";
        finish([], []); continue;
      }
      if (applied > c.allowed) {
        proof.outcome = "observed";
        proof.summary = applied + " concurrent executions applied the operation where at most " + c.allowed + " " + (c.allowed === 1 ? "execution is" : "executions are") + " allowed";
        const finding: PentestFinding = {
          id: check, check, verdict: "finding", severity: "medium", target,
          title: "Concurrent submissions exceeded the declared execution bound: " + c.id,
          detail: c.concurrency + " identical submissions were released simultaneously (statuses [" + statuses.join(", ") + "], " + accepted + " accepted). The state witness moved from " + before.value + " to " + after.value + ", which is " + applied + " executions of the declared delta where the declared bound allows at most " + c.allowed + ". This is direct evidence that the bound is not enforced atomically under concurrency. Timing-dependent: a clean re-run does not prove safety, only that the race did not trigger. Records created by this test may persist; plan test-data cleanup separately.",
          remediation: "Enforce the bound atomically (unique constraint, transactional check-and-set or row lock) instead of a check-then-act sequence, and re-run this case after repair.",
        };
        finish([finding], [coverageKey(target, check)]);
        continue;
      }
      if (accepted === 0 && applied === 0) { proof.summary = "Every concurrent submission was rejected and the witness did not move; the case could not establish that a valid execution is possible (review the body, authentication and availability)"; finish([], []); continue; }
      proof.outcome = "not_observed";
      proof.summary = "The declared bound held under " + c.concurrency + " concurrent submissions (" + applied + (applied === 1 ? " execution" : " executions") + ", " + accepted + " accepted)";
      finish([], [coverageKey(target, check)]);
    } catch (error) {
      signal.throwIfAborted();
      proof.summary = "Business race case could not be executed: " + scrub(error instanceof Error ? error.message : String(error));
      finish([], []);
    }
  }
}

export async function runConsistencyCases(input: BusinessEngineInput, cases: ConsistencyCase[]): Promise<void> {
  const { scope, signal, evidence, result, request } = input;
  const { scrub } = buildContext(input);
  for (const c of cases) {
    signal.throwIfAborted();
    const target = new URL(c.layers[0]!.path, scope.seeds[0]!).href, offset = evidence.length;
    const proof: BusinessProof = { id: randomUUID(), at: new Date().toISOString(), kind: "business_consistency", caseId: c.id, target, outcome: "inconclusive", summary: "Business consistency verification did not complete", requestIds: [], observations: { layers: c.layers.length } };
    const finish = (findings: PentestFinding[], covered: string[]) => {
      proof.requestIds = evidence.slice(offset).map(e => e.id);
      if (proof.outcome === "inconclusive") result.incomplete = true;
      result.proofs.push(proof);
      input.publish(proof, findings.map(f => ({ ...f, title: scrub(f.title), detail: scrub(f.detail) })), covered);
    };
    try {
      // The declared value never appears in observations or findings; only
      // per-layer match booleans, statuses and value kinds are recorded.
      const expected = input.secrets[c.valueRef]!;
      const layerResults: Array<{ path: string; status: number; resolved: boolean; matched: boolean; kind: string }> = [];
      for (const layer of c.layers) {
        const url = new URL(layer.path, scope.seeds[0]!).href;
        const res = await request(url);
        if (!res.ok || res.bodyTruncated) { layerResults.push({ path: layer.path, status: res.status, resolved: false, matched: false, kind: res.bodyTruncated ? "truncated" : "unavailable" }); continue; }
        let data: unknown;
        try { data = JSON.parse(res.body); } catch { layerResults.push({ path: layer.path, status: res.status, resolved: false, matched: false, kind: "invalid-json" }); continue; }
        const value = resolvePointer(data, layer.pointer);
        if (value === undefined || value === null) { layerResults.push({ path: layer.path, status: res.status, resolved: false, matched: false, kind: "missing-pointer" }); continue; }
        if (typeof value === "string") { layerResults.push({ path: layer.path, status: res.status, resolved: true, matched: value === expected, kind: "string" }); continue; }
        if (typeof value === "number" && Number.isFinite(value)) { layerResults.push({ path: layer.path, status: res.status, resolved: true, matched: String(value) === expected, kind: "number" }); continue; }
        layerResults.push({ path: layer.path, status: res.status, resolved: false, matched: false, kind: "unsupported-type" });
      }
      const resolved = layerResults.filter(l => l.resolved), matched = resolved.filter(l => l.matched), divergent = resolved.filter(l => !l.matched), unresolved = layerResults.filter(l => !l.resolved);
      proof.observations = { ...proof.observations, layerStatuses: layerResults.map(l => l.path + ":" + l.status + ":" + (l.resolved ? (l.matched ? "matched" : "divergent") : l.kind)).join(", "), matchedLayers: matched.length, divergentLayers: divergent.length, unresolvedLayers: unresolved.length };
      const check = "business_consistency_" + createHash("sha256").update(c.id).digest("hex").slice(0, 16);
      if (matched.length === 0) {
        proof.summary = resolved.length === 0
          ? "No declared layer resolved its pointer to a comparable value; review the layer paths, pointers and availability"
          : "No layer reproduced the declared value; verify the expected value and its freshness before inferring divergence";
        finish([], []);
        continue;
      }
      if (divergent.length > 0) {
        proof.outcome = "observed";
        proof.summary = divergent.length + " of " + resolved.length + " comparable layers exposed a different value than the declared one";
        const finding: PentestFinding = {
          id: check, check, verdict: "finding", severity: "medium", target,
          title: "Layers expose divergent values for a declared field: " + c.id,
          detail: "The declared value was reproduced by " + matched.length + " layer(s) (positive control), but " + divergent.map(l => l.path + " (HTTP " + l.status + ")").join(", ") + " resolved the declared pointer to a different value. The declared value itself is never recorded here. Review caching, replication lag, serialization or authorization filtering between the layers. This is a point-in-time comparison: transient replication lag can look identical, so verify freshness before acting. Unresolved layers: " + (unresolved.length || 0) + ".",
          remediation: "Serve the declared field from one authoritative source (or invalidate derived views on write), and re-run this case after repair.",
        };
        finish([finding], [coverageKey(target, check)]);
        continue;
      }
      if (unresolved.length > 0) {
        proof.summary = "All comparable layers matched, but " + unresolved.length + " layer(s) could not be compared (" + unresolved.map(l => l.path + ": " + l.kind).join(", ") + "); consistency across every declared layer is unverified";
        finish([], []);
        continue;
      }
      proof.outcome = "not_observed";
      proof.summary = "Every declared layer resolved its pointer and reproduced the declared value exactly";
      finish([], [coverageKey(target, check)]);
    } catch (error) {
      signal.throwIfAborted();
      proof.summary = "Business consistency case could not be executed: " + scrub(error instanceof Error ? error.message : String(error));
      finish([], []);
    }
  }
}
