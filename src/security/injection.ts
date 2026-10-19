import { createHash, randomUUID } from "node:crypto";
import { inScope, type CampaignScope, type RequestEvidence } from "./scope.js";
import { coverageKey } from "./findings.js";
import type { PentestFinding } from "../tools/pentest.js";

// Dynamic SQL / NoSQL injection verification with independent proof controls.
// Each case targets one operator-declared path and input field. The engine
// submits four requests: a benign baseline value, a tautology payload that a
// vulnerable query absorbs (same answer as the baseline), a contradiction
// payload that changes the answer, and a repeat of the baseline. Injection is
// reported only when the baseline is successful and stable, the tautology
// reproduces the baseline signature exactly, and the contradiction differs —
// a repeatable boolean differential rather than an error guess.

export interface InjectionCase {
  id: string;
  kind: "sql" | "nosql";
  path: string;
  method: "GET" | "POST";
  field: string;
  baselineRef: string;
}
export interface InjectionProof {
  id: string; at: string; kind: "injection"; caseId: string; target: string;
  outcome: "observed" | "not_observed" | "inconclusive";
  summary: string; requestIds: string[];
  observations: Record<string, string | number | boolean>;
}

const ref = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(v);

export function normalizeInjectionCases(value: unknown, scope: CampaignScope, profile: "quick" | "campaign", postPaths: string[]): InjectionCase[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.length) return [];
  if (profile !== "campaign") throw Error("Injection cases require campaign mode");
  if (!scope.seeds.length) throw Error("Injection cases require a scoped target");
  if (value.length > 5) throw Error("At most five injection cases");
  const cases = value.map((item): InjectionCase => {
    if (!item || typeof item !== "object") throw Error("Injection case must be an object");
    const raw = item as Record<string, unknown>;
    if (!ref(raw.id) || !ref(raw.baselineRef)) throw Error("Injection case requires id and baselineRef");
    if (raw.kind !== "sql" && raw.kind !== "nosql") throw Error("Injection case kind must be sql or nosql");
    if (raw.method !== "GET" && raw.method !== "POST") throw Error("Injection case method must be GET or POST");
    if (typeof raw.field !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(raw.field) || /^(?:action|cmd|command|delete|logout|method)$/i.test(raw.field)) throw Error("Injection case requires a safe field or parameter name");
    if (typeof raw.path !== "string" || !raw.path.startsWith("/") || raw.path.startsWith("//") || /[?#%\\]/.test(raw.path) || new URL(raw.path, scope.seeds[0]!).pathname !== raw.path) throw Error("Injection case requires an exact path without query or fragment");
    if (!inScope(scope, new URL(raw.path, scope.seeds[0]!).href)) throw Error("Injection case path is outside the approved scope");
    if (raw.method === "POST" && !postPaths.includes(raw.path)) throw Error("Injection POST path must be allowlisted in postPaths");
    return { id: raw.id as string, kind: raw.kind, path: raw.path, method: raw.method, field: raw.field, baselineRef: raw.baselineRef as string };
  });
  if (new Set(cases.map(c => c.id)).size !== cases.length) throw Error("Injection case ids must be unique");
  return cases;
}

// The benign baseline value is operator-supplied and fresh per run; it is a
// plain string compared and never recorded.
export function normalizeInjectionValues(value: unknown, cases: InjectionCase[]): Record<string, string> {
  if (!cases.length) return {};
  if (value === undefined || !value || typeof value !== "object" || Array.isArray(value)) throw Error("Injection cases require fresh input: " + cases[0]!.baselineRef);
  const values = value as Record<string, unknown>, result: Record<string, string> = {};
  for (const c of cases) {
    const baseline = values[c.baselineRef];
    if (baseline === undefined) throw Error("Supply fresh business input: " + c.baselineRef);
    if (typeof baseline !== "string" || !baseline.trim() || baseline.length > 512) throw Error("Injection baseline must be a nonempty string up to 512 bytes: " + c.baselineRef);
    result[c.baselineRef] = baseline;
  }
  return result;
}

export type InjectionEngineInput = {
  scope: CampaignScope; secrets: Record<string, string>;
  auth: Record<string, string>; signal: AbortSignal; evidence: RequestEvidence[];
  reserve: () => Promise<{ id: string; at: number }>; redact: (value: string) => string;
  result: { proofs: InjectionProof[]; incomplete: boolean };
  publish: (proof: InjectionProof, findings: PentestFinding[], covered: string[]) => void;
};

export async function runInjectionCases(input: InjectionEngineInput, cases: InjectionCase[]): Promise<void> {
  const { scope, secrets, auth, signal, evidence, reserve, redact, result } = input;
  const hash = (data: string) => createHash("sha256").update(data).digest("hex");
  // Values never appear in evidence: query strings are stripped from recorded
  // URLs and POST bodies are stored as sizes and hashes only.
  const scrub = (v: string) => Object.values(secrets).reduce((acc, s) => s ? acc.split(s).join("[REDACTED]") : acc, redact(v));
  const send = async (c: InjectionCase, probe: unknown): Promise<{ status: number; signature: string | null }> => {
    const base = new URL(c.path, scope.seeds[0]!).href;
    signal.throwIfAborted();
    if (!inScope(scope, base)) throw Error("Injection path left the approved scope");
    const ticket = await reserve();
    const started = Date.now();
    let requestUrl = base, bodyText: string | undefined;
    const headers: Record<string, string> = { ...auth };
    if (c.method === "GET") requestUrl = base + "?" + encodeURIComponent(c.field) + "=" + encodeURIComponent(String(probe));
    else { headers["content-type"] = "application/json"; bodyText = JSON.stringify({ [c.field]: probe }); }
    const item: RequestEvidence = { id: ticket.id, at: new Date(ticket.at).toISOString(), url: base, method: c.method, authenticated: !!Object.keys(auth).length, status: 0, durationMs: 0, bodyHash: "", bytes: 0, contentType: "", engine: "http" };
    if (c.method === "POST") { item.requestBytes = Buffer.byteLength(bodyText!); item.postPolicy = c.path; }
    evidence.push(item);
    try {
      const res = await fetch(requestUrl, { method: c.method, headers, body: bodyText, redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
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
      if (truncated) { item.bodyTruncated = true; item.error = "Response body exceeded 32768 bytes"; item.bodyHash = ""; }
      return { status: res.status, signature: truncated ? null : res.status + "\n" + item.bodyHash };
    } catch (error) {
      item.error = redact("Injection probe request failed: " + (error instanceof Error ? error.message : String(error)));
      return { status: 0, signature: null };
    } finally { item.durationMs = Date.now() - started; }
  };
  for (const c of cases) {
    signal.throwIfAborted();
    const target = new URL(c.path, scope.seeds[0]!).href, offset = evidence.length;
    const proof: InjectionProof = { id: randomUUID(), at: new Date().toISOString(), kind: "injection", caseId: c.id, target, outcome: "inconclusive", summary: "Injection verification did not complete", requestIds: [], observations: { injectionKind: c.kind, method: c.method, field: c.field } };
    const finish = (findings: PentestFinding[], covered: string[]) => {
      proof.requestIds = evidence.slice(offset).map(e => e.id);
      if (proof.outcome === "inconclusive") result.incomplete = true;
      result.proofs.push(proof);
      input.publish(proof, findings.map(f => ({ ...f, title: scrub(f.title), detail: scrub(f.detail) })), covered);
    };
    try {
      const baseline = secrets[c.baselineRef]!;
      const marker = "__loam_" + randomUUID().replace(/-/g, "").slice(0, 16);
      // Tautology probes a vulnerable engine absorbs; contradiction changes
      // the answer. Both are non-destructive boolean differentials only.
      const probes = c.kind === "sql"
        ? { control: baseline, truthy: baseline + "' AND '1'='1", falsy: baseline + "' AND '1'='2" }
        : { control: baseline, truthy: { $eq: baseline }, falsy: { $eq: marker } };
      const control = await send(c, probes.control);
      proof.observations.controlStatus = control.status;
      if (!(control.status >= 200 && control.status < 300) || control.signature === null) { proof.summary = "Baseline request was not a complete successful response (HTTP " + control.status + "); review the case path, field and baseline value"; finish([], []); continue; }
      const truthy = await send(c, probes.truthy);
      const falsy = await send(c, probes.falsy);
      const repeat = await send(c, probes.control);
      proof.observations.truthyStatus = truthy.status; proof.observations.falsyStatus = falsy.status; proof.observations.repeatStatus = repeat.status;
      const stable = repeat.signature === control.signature;
      const absorbed = truthy.signature === control.signature;
      const distinguished = falsy.signature !== control.signature;
      proof.observations.baselineStable = stable; proof.observations.tautologyAbsorbed = absorbed; proof.observations.contradictionDistinguished = distinguished;
      const check = "injection_" + createHash("sha256").update(c.id).digest("hex").slice(0, 16);
      if (!stable) { proof.summary = "The baseline response was not repeatable; volatile responses cannot ground a boolean differential"; finish([], []); continue; }
      if (absorbed && distinguished) {
        proof.outcome = "observed";
        proof.summary = "A repeatable boolean differential: the tautology payload reproduced the baseline response and the contradiction changed it";
        const finding: PentestFinding = {
          id: check, check, verdict: "finding", severity: "high", target,
          title: (c.kind === "sql" ? "SQL" : "NoSQL") + " injection confirmed by boolean differential: " + c.id,
          detail: "Four probes hit the declared " + c.method + " path. The benign baseline succeeded twice with identical signatures (stability control). The " + (c.kind === "sql" ? "tautology payload (' AND '1'='1)" : "equality-operator payload") + " reproduced the baseline signature exactly, and the contradiction payload changed the response (HTTP " + control.status + " → " + falsy.status + " with a different body). Only non-destructive boolean differentials were used — no data was read beyond what the benign query already returns, and no state was changed. Impact depends on the reachable query and data.",
          remediation: c.kind === "sql" ? "Use the database driver's parameter binding for every value; never concatenate input into SQL text. Re-run this case after repair." : "Reject object or operator values in this field with strict schema validation before building filters. Re-run this case after repair.",
        };
        finish([finding], [coverageKey(target, check)]);
        continue;
      }
      proof.outcome = "not_observed";
      proof.summary = !absorbed && !distinguished
        ? "Neither probe changed the response relative to the stable baseline (encoded, rejected or normalized input)"
        : !absorbed
          ? "The tautology payload did not reproduce the baseline signature; a boolean differential was not established (HTTP " + truthy.status + ")"
          : "The contradiction payload did not change the response; the injected boolean did not alter the query result";
      finish([], [coverageKey(target, check)]);
    } catch (error) {
      signal.throwIfAborted();
      proof.summary = "Injection case could not be executed: " + scrub(error instanceof Error ? error.message : String(error));
      finish([], []);
    }
  }
}
