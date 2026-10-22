import { createHash, randomUUID } from "node:crypto";
import { inScope, type CampaignScope, type RequestEvidence } from "./scope.js";
import { coverageKey } from "./findings.js";
import type { PentestFinding } from "../tools/pentest.js";

// Path traversal verification with independent proof controls. Each case
// targets one operator-declared file-serving GET endpoint and parameter. Three
// requests decide the verdict: a benign file that must be served with its
// declared content marker (positive control), a random nonexistent name that
// must not leak the target marker (negative control), and the traversal
// payload that must return the declared target marker from outside the served
// root for the finding to fire.

export interface TraversalCase {
  id: string;
  path: string;
  param: string;
  benignRef: string;
  benignMarkerRef: string;
  traversalRef: string;
  markerRef: string;
}
export interface TraversalProof {
  id: string; at: string; kind: "traversal"; caseId: string; target: string;
  outcome: "observed" | "not_observed" | "inconclusive";
  summary: string; requestIds: string[];
  observations: Record<string, string | number | boolean>;
}

const ref = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(v);

export function normalizeTraversalCases(value: unknown, scope: CampaignScope, profile: "quick" | "campaign"): TraversalCase[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.length) return [];
  if (profile !== "campaign") throw Error("Traversal cases require campaign mode");
  if (!scope.seeds.length) throw Error("Traversal cases require a scoped target");
  if (value.length > 5) throw Error("At most five traversal cases");
  const cases = value.map((item): TraversalCase => {
    if (!item || typeof item !== "object") throw Error("Traversal case must be an object");
    const raw = item as Record<string, unknown>;
    for (const key of ["id", "benignRef", "benignMarkerRef", "traversalRef", "markerRef"] as const) if (!ref(raw[key])) throw Error("Traversal case requires " + key);
    if (typeof raw.param !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(raw.param) || /^(?:action|cmd|command|delete|logout|method)$/i.test(raw.param)) throw Error("Traversal case requires a safe parameter name");
    if (typeof raw.path !== "string" || !raw.path.startsWith("/") || raw.path.startsWith("//") || /[?#%\\]/.test(raw.path) || new URL(raw.path, scope.seeds[0]!).pathname !== raw.path) throw Error("Traversal case requires an exact path without query or fragment");
    if (!inScope(scope, new URL(raw.path, scope.seeds[0]!).href)) throw Error("Traversal case path is outside the approved scope");
    return { id: raw.id as string, path: raw.path as string, param: raw.param as string, benignRef: raw.benignRef as string, benignMarkerRef: raw.benignMarkerRef as string, traversalRef: raw.traversalRef as string, markerRef: raw.markerRef as string };
  });
  if (new Set(cases.map(c => c.id)).size !== cases.length) throw Error("Traversal case ids must be unique");
  return cases;
}

// Benign names, markers and traversal payloads are operator-supplied plain
// strings, fresh per run and never recorded.
export function normalizeTraversalValues(value: unknown, cases: TraversalCase[]): Record<string, string> {
  if (!cases.length) return {};
  if (value === undefined || !value || typeof value !== "object" || Array.isArray(value)) throw Error("Traversal cases require fresh input: " + cases[0]!.benignRef);
  const values = value as Record<string, unknown>, result: Record<string, string> = {};
  for (const c of cases) {
    for (const [key, max] of [["benignRef", 2048], ["benignMarkerRef", 512], ["traversalRef", 2048], ["markerRef", 512]] as const) {
      const ref = c[key];
      const v = values[ref];
      if (v === undefined) throw Error("Supply fresh business input: " + ref);
      if (typeof v !== "string" || !v.trim() || v.length > max) throw Error("Traversal " + key.replace("Ref", " value") + " must be a nonempty string up to " + max + " bytes: " + ref);
      result[ref] = v;
    }
  }
  return result;
}

export type TraversalEngineInput = {
  scope: CampaignScope; secrets: Record<string, string>;
  auth: Record<string, string>; signal: AbortSignal; evidence: RequestEvidence[];
  reserve: () => Promise<{ id: string; at: number }>; redact: (value: string) => string;
  result: { proofs: TraversalProof[]; incomplete: boolean };
  publish: (proof: TraversalProof, findings: PentestFinding[], covered: string[]) => void;
};

export async function runTraversalCases(input: TraversalEngineInput, cases: TraversalCase[]): Promise<void> {
  const { scope, secrets, auth, signal, evidence, reserve, redact, result } = input;
  const hash = (data: string) => createHash("sha256").update(data).digest("hex");
  // Query strings are stripped from recorded evidence URLs; markers and the
  // traversal payload are secrets and never appear in stored output.
  const scrub = (v: string) => Object.values(secrets).reduce((acc, s) => s ? acc.split(s).join("[REDACTED]") : acc, redact(v));
  const send = async (c: TraversalCase, value: string): Promise<{ status: number; body: string | null }> => {
    const base = new URL(c.path, scope.seeds[0]!).href;
    signal.throwIfAborted();
    if (!inScope(scope, base)) throw Error("Traversal path left the approved scope");
    const ticket = await reserve();
    const started = Date.now(), url = base + "?" + encodeURIComponent(c.param) + "=" + encodeURIComponent(value);
    const item: RequestEvidence = { id: ticket.id, at: new Date(ticket.at).toISOString(), url: base, method: "GET", authenticated: !!Object.keys(auth).length, status: 0, durationMs: 0, bodyHash: "", bytes: 0, contentType: "", engine: "http" };
    evidence.push(item);
    try {
      const res = await fetch(url, { method: "GET", headers: { ...auth }, redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
      const chunks: Uint8Array[] = []; let bytes = 0, truncated = false;
      const reader = res.body?.getReader();
      if (reader) try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          const chunk = part.value.subarray(0, 32768 - bytes); chunks.push(chunk); bytes += chunk.length;
          if (chunk.length < part.value.length) { truncated = true; break; }
        }
      } finally { await reader.cancel().catch(() => {}); }
      const body = Buffer.concat(chunks).toString("utf8");
      item.status = res.status; item.bytes = bytes; item.bodyHash = hash(body);
      item.contentType = redact(res.headers.get("content-type")?.split(";")[0] ?? "");
      if (truncated) { item.bodyTruncated = true; item.error = "Response body exceeded 32768 bytes"; }
      return { status: res.status, body: truncated ? null : body };
    } catch (error) {
      item.error = redact("Traversal probe request failed: " + (error instanceof Error ? error.message : String(error)));
      return { status: 0, body: null };
    } finally { item.durationMs = Date.now() - started; }
  };
  for (const c of cases) {
    signal.throwIfAborted();
    const target = new URL(c.path, scope.seeds[0]!).href, offset = evidence.length;
    const proof: TraversalProof = { id: randomUUID(), at: new Date().toISOString(), kind: "traversal", caseId: c.id, target, outcome: "inconclusive", summary: "Traversal verification did not complete", requestIds: [], observations: { param: c.param } };
    const finish = (findings: PentestFinding[], covered: string[]) => {
      proof.requestIds = evidence.slice(offset).map(e => e.id);
      if (proof.outcome === "inconclusive") result.incomplete = true;
      result.proofs.push(proof);
      input.publish(proof, findings.map(f => ({ ...f, title: scrub(f.title), detail: scrub(f.detail) })), covered);
    };
    try {
      const benign = secrets[c.benignRef]!, benignMarker = secrets[c.benignMarkerRef]!, payload = secrets[c.traversalRef]!, marker = secrets[c.markerRef]!;
      // Positive control: the endpoint serves the declared benign file.
      const benignRes = await send(c, benign);
      proof.observations.benignStatus = benignRes.status;
      const baselineValid = benignRes.status >= 200 && benignRes.status < 300 && benignRes.body !== null && benignRes.body.includes(benignMarker);
      proof.observations.benignServed = baselineValid;
      if (!baselineValid) { proof.summary = "Positive control failed: the endpoint did not serve the declared benign file with its marker (HTTP " + benignRes.status + ")"; finish([], []); continue; }
      // Negative control: a random nonexistent name must not leak the marker.
      const missing = await send(c, "__loam_missing_" + randomUUID().replace(/-/g, "").slice(0, 12));
      proof.observations.missingStatus = missing.status;
      const negativeValid = missing.body === null || !missing.body.includes(marker);
      proof.observations.markerAbsentForMissing = negativeValid;
      if (!negativeValid) { proof.summary = "Negative control failed: the target marker appeared for a random nonexistent name; the endpoint echoes content and cannot ground a traversal verdict"; finish([], []); continue; }
      // Traversal probe: the payload must return the target marker.
      const probe = await send(c, payload);
      proof.observations.probeStatus = probe.status;
      const traversed = probe.status >= 200 && probe.status < 300 && probe.body !== null && probe.body.includes(marker);
      proof.observations.targetServed = traversed;
      const check = "traversal_" + createHash("sha256").update(c.id).digest("hex").slice(0, 16);
      if (traversed) {
        proof.outcome = "observed";
        proof.summary = "The traversal payload returned the declared target file's content";
        const finding: PentestFinding = {
          id: check, check, verdict: "finding", severity: "high", target,
          title: "Path traversal served a file outside the declared root: " + c.id,
          detail: "The endpoint served the declared benign file with its marker (positive control), did not leak the target marker for a random nonexistent name (negative control), and the traversal payload returned the target marker with HTTP " + probe.status + ". File contents beyond the declared marker are not recorded. Impact depends on which files are reachable from the served root.",
          remediation: "Resolve the parameter against a fixed served root with canonicalization and reject separators or traversal segments; serve files by identifier instead of paths. Re-run this case after repair.",
        };
        finish([finding], [coverageKey(target, check)]);
        continue;
      }
      proof.outcome = "not_observed";
      proof.summary = probe.status >= 200 && probe.status < 300
        ? "The traversal payload returned a successful response without the target marker (blocked, normalized or redirected)"
        : "The traversal payload was rejected (HTTP " + probe.status + ")";
      finish([], [coverageKey(target, check)]);
    } catch (error) {
      signal.throwIfAborted();
      proof.summary = "Traversal case could not be executed: " + scrub(error instanceof Error ? error.message : String(error));
      finish([], []);
    }
  }
}
