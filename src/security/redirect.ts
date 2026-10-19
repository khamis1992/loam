import { createHash, randomUUID } from "node:crypto";
import { inScope, type CampaignScope, type RequestEvidence } from "./scope.js";
import { coverageKey } from "./findings.js";
import type { PentestFinding } from "../tools/pentest.js";

// Open redirect verification with independent proof controls. Each case
// targets one operator-declared GET endpoint whose parameter feeds a
// redirect. Redirects are never followed — the Location header itself is the
// witness, so no external host is ever contacted. The positive control
// redirects a benign in-origin target; only a Location that carries the fresh
// foreign tokenized URL through unmodified counts as an open redirect.

export interface RedirectCase {
  id: string;
  path: string;
  param: string;
  safeTargetRef: string;
  foreignOriginRef: string;
}
export interface RedirectProof {
  id: string; at: string; kind: "redirect"; caseId: string; target: string;
  outcome: "observed" | "not_observed" | "inconclusive";
  summary: string; requestIds: string[];
  observations: Record<string, string | number | boolean>;
}

const ref = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(v);

export function normalizeRedirectCases(value: unknown, scope: CampaignScope, profile: "quick" | "campaign"): RedirectCase[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.length) return [];
  if (profile !== "campaign") throw Error("Redirect cases require campaign mode");
  if (!scope.seeds.length) throw Error("Redirect cases require a scoped target");
  if (value.length > 5) throw Error("At most five redirect cases");
  const cases = value.map((item): RedirectCase => {
    if (!item || typeof item !== "object") throw Error("Redirect case must be an object");
    const raw = item as Record<string, unknown>;
    if (!ref(raw.id) || !ref(raw.safeTargetRef) || !ref(raw.foreignOriginRef)) throw Error("Redirect case requires id, safeTargetRef and foreignOriginRef");
    if (typeof raw.param !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(raw.param) || /^(?:action|cmd|command|delete|logout|method)$/i.test(raw.param)) throw Error("Redirect case requires a safe parameter name");
    if (typeof raw.path !== "string" || !raw.path.startsWith("/") || raw.path.startsWith("//") || /[?#%\\]/.test(raw.path) || new URL(raw.path, scope.seeds[0]!).pathname !== raw.path) throw Error("Redirect case requires an exact path without query or fragment");
    if (!inScope(scope, new URL(raw.path, scope.seeds[0]!).href)) throw Error("Redirect case path is outside the approved scope");
    return { id: raw.id as string, path: raw.path, param: raw.param, safeTargetRef: raw.safeTargetRef as string, foreignOriginRef: raw.foreignOriginRef as string };
  });
  if (new Set(cases.map(c => c.id)).size !== cases.length) throw Error("Redirect case ids must be unique");
  return cases;
}

// The benign in-origin target and the foreign origin base (never contacted —
// only compared against Location) are operator-supplied, fresh per run and
// never recorded.
export function normalizeRedirectValues(value: unknown, cases: RedirectCase[]): Record<string, string> {
  if (!cases.length) return {};
  if (value === undefined || !value || typeof value !== "object" || Array.isArray(value)) throw Error("Redirect cases require fresh input: " + cases[0]!.safeTargetRef);
  const values = value as Record<string, unknown>, result: Record<string, string> = {};
  for (const c of cases) {
    const safe = values[c.safeTargetRef];
    if (safe === undefined) throw Error("Supply fresh business input: " + c.safeTargetRef);
    if (typeof safe !== "string" || !safe.startsWith("/") || safe.startsWith("//") || /[\\%]/.test(safe) || safe.length > 512) throw Error("Redirect safe target must be an absolute in-origin path: " + c.safeTargetRef);
    result[c.safeTargetRef] = safe;
    const foreign = values[c.foreignOriginRef];
    if (foreign === undefined) throw Error("Supply fresh business input: " + c.foreignOriginRef);
    if (typeof foreign !== "string" || !/^https:\/\/[a-z0-9.-]+/i.test(foreign) || foreign.length > 300 || /[\s\\%]/.test(foreign)) throw Error("Redirect foreign origin must be an https URL base (never contacted): " + c.foreignOriginRef);
    result[c.foreignOriginRef] = foreign;
  }
  return result;
}

export type RedirectEngineInput = {
  scope: CampaignScope; secrets: Record<string, string>;
  auth: Record<string, string>; signal: AbortSignal; evidence: RequestEvidence[];
  reserve: () => Promise<{ id: string; at: number }>; redact: (value: string) => string;
  result: { proofs: RedirectProof[]; incomplete: boolean };
  publish: (proof: RedirectProof, findings: PentestFinding[], covered: string[]) => void;
};

export async function runRedirectCases(input: RedirectEngineInput, cases: RedirectCase[]): Promise<void> {
  const { scope, secrets, auth, signal, evidence, reserve, redact, result } = input;
  const hash = (data: string) => createHash("sha256").update(data).digest("hex");
  const scrub = (v: string) => Object.values(secrets).reduce((acc, s) => s ? acc.split(s).join("[REDACTED]") : acc, redact(v));
  // Redirects are never followed: the probe destination is never contacted,
  // and the Location header alone decides every verdict.
  const send = async (c: RedirectCase, value: string): Promise<{ status: number; location: string | null }> => {
    const base = new URL(c.path, scope.seeds[0]!).href;
    signal.throwIfAborted();
    if (!inScope(scope, base)) throw Error("Redirect path left the approved scope");
    const ticket = await reserve();
    const started = Date.now(), url = base + "?" + encodeURIComponent(c.param) + "=" + encodeURIComponent(value);
    const item: RequestEvidence = { id: ticket.id, at: new Date(ticket.at).toISOString(), url: base, method: "GET", authenticated: !!Object.keys(auth).length, status: 0, durationMs: 0, bodyHash: "", bytes: 0, contentType: "", engine: "http" };
    evidence.push(item);
    try {
      const res = await fetch(url, { method: "GET", headers: { ...auth }, redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
      const chunks: Uint8Array[] = []; let bytes = 0;
      const reader = res.body?.getReader();
      if (reader) try { for (;;) { const part = await reader.read(); if (part.done) break; const chunk = part.value.subarray(0, 32768 - bytes); chunks.push(chunk); bytes += chunk.length; if (chunk.length < part.value.length) break; } } finally { await reader.cancel().catch(() => {}); }
      const body = Buffer.concat(chunks).toString("utf8");
      item.status = res.status; item.bytes = bytes; item.bodyHash = hash(body);
      item.contentType = redact(res.headers.get("content-type")?.split(";")[0] ?? "");
      return { status: res.status, location: res.headers.get("location") };
    } catch (error) {
      item.error = redact("Redirect probe request failed: " + (error instanceof Error ? error.message : String(error)));
      return { status: 0, location: null };
    } finally { item.durationMs = Date.now() - started; }
  };
  const seedOrigin = new URL(scope.seeds[0]!).origin;
  for (const c of cases) {
    signal.throwIfAborted();
    const target = new URL(c.path, scope.seeds[0]!).href, offset = evidence.length;
    const proof: RedirectProof = { id: randomUUID(), at: new Date().toISOString(), kind: "redirect", caseId: c.id, target, outcome: "inconclusive", summary: "Redirect verification did not complete", requestIds: [], observations: { param: c.param } };
    const finish = (findings: PentestFinding[], covered: string[]) => {
      proof.requestIds = evidence.slice(offset).map(e => e.id);
      if (proof.outcome === "inconclusive") result.incomplete = true;
      result.proofs.push(proof);
      input.publish(proof, findings.map(f => ({ ...f, title: scrub(f.title), detail: scrub(f.detail) })), covered);
    };
    try {
      const safeTarget = secrets[c.safeTargetRef]!, foreignBase = secrets[c.foreignOriginRef]!;
      const token = "loam" + randomUUID().replace(/-/g, "").slice(0, 20);
      const foreignUrl = foreignBase.replace(/\/+$/, "") + "/" + token;
      // Positive control: the benign in-origin target must produce a redirect
      // whose Location stays inside the application origin.
      const control = await send(c, safeTarget);
      proof.observations.controlStatus = control.status;
      const controlLocation = control.location ?? "";
      const controlInOrigin = control.status >= 300 && control.status < 400 && (controlLocation.startsWith("/") || controlLocation.startsWith(seedOrigin));
      proof.observations.controlInOrigin = controlInOrigin;
      if (!controlInOrigin) { proof.summary = "Positive control failed: the benign in-origin target did not produce an in-origin redirect (HTTP " + control.status + ")"; finish([], []); continue; }
      // Probe: a fresh foreign URL through the parameter. Never followed.
      const probe = await send(c, foreignUrl);
      const probeLocation = probe.location ?? "";
      proof.observations.probeStatus = probe.status;
      const openToForeign = probe.status >= 300 && probe.status < 400 && (probeLocation === foreignUrl || probeLocation.replace(/\/+$/, "") === foreignUrl.replace(/\/+$/, ""));
      proof.observations.foreignLocationPassed = openToForeign;
      const check = "redirect_" + createHash("sha256").update(c.id).digest("hex").slice(0, 16);
      if (openToForeign) {
        proof.outcome = "observed";
        proof.summary = "A user-controlled parameter redirected to a foreign origin verbatim";
        const finding: PentestFinding = {
          id: check, check, verdict: "finding", severity: "medium", target,
          title: "Open redirect passes a foreign origin through a declared parameter: " + c.id,
          detail: "The benign in-origin target produced an in-origin redirect (positive control). A fresh foreign URL submitted through the declared parameter was then passed to the Location header verbatim (HTTP " + probe.status + "). Redirects are never followed in this engine — the destination was never contacted and the foreign base is an operator-declared inert origin. Impact is phishing/credential-theft redirection and OAuth flow abuse, not direct compromise.",
          remediation: "Validate the redirect target against an explicit allowlist of in-origin paths; reject absolute and scheme-relative URLs. Re-run this case after repair.",
        };
        finish([finding], [coverageKey(target, check)]);
        continue;
      }
      proof.outcome = "not_observed";
      proof.summary = probe.status >= 300 && probe.status < 400
        ? "The redirect normalized or rejected the foreign URL (Location stayed in-origin)"
        : "The foreign probe did not produce a redirect (HTTP " + probe.status + ")";
      finish([], [coverageKey(target, check)]);
    } catch (error) {
      signal.throwIfAborted();
      proof.summary = "Redirect case could not be executed: " + scrub(error instanceof Error ? error.message : String(error));
      finish([], []);
    }
  }
}
