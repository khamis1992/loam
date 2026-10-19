import { createHash, randomUUID } from "node:crypto";
import { inScope, type CampaignScope, type RequestEvidence } from "./scope.js";
import { coverageKey } from "./findings.js";
import type { PentestFinding } from "../tools/pentest.js";

// Template injection verification with independent proof controls. The canary
// is a harmless arithmetic expression rendered in one of three common template
// syntaxes; two distinct expressions (7*6 → 42 and 7*7 → 49) distinguish real
// evaluation from coincidence or static echo. A benign baseline (which must
// not already contain either computed value — the negative control) and its
// stability repeat complete the controls before any verdict.

export type TemplateSyntax = "mustache" | "dollar" | "erb";
export interface TemplateCase {
  id: string;
  syntax: TemplateSyntax;
  method: "get" | "post";
  path: string;
  field: string;
  baselineRef: string;
}
export interface TemplateProof {
  id: string; at: string; kind: "template"; caseId: string; target: string;
  outcome: "observed" | "not_observed" | "inconclusive";
  summary: string; requestIds: string[];
  observations: Record<string, string | number | boolean>;
}

const ref = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(v);

export function renderCanary(syntax: TemplateSyntax, expression: string): string {
  if (syntax === "mustache") return "{{" + expression + "}}";
  if (syntax === "dollar") return "${" + expression + "}";
  return "<%= " + expression + " %>";
}

export function normalizeTemplateCases(value: unknown, scope: CampaignScope, profile: "quick" | "campaign", postPaths: string[]): TemplateCase[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.length) return [];
  if (profile !== "campaign") throw Error("Template cases require campaign mode");
  if (!scope.seeds.length) throw Error("Template cases require a scoped target");
  if (value.length > 5) throw Error("At most five template cases");
  const cases = value.map((item): TemplateCase => {
    if (!item || typeof item !== "object") throw Error("Template case must be an object");
    const raw = item as Record<string, unknown>;
    if (!ref(raw.id) || !ref(raw.baselineRef)) throw Error("Template case requires id and baselineRef");
    if (raw.syntax !== "mustache" && raw.syntax !== "dollar" && raw.syntax !== "erb") throw Error("Template case syntax must be mustache, dollar or erb");
    if (raw.method !== "get" && raw.method !== "post") throw Error("Template case method must be get or post");
    if (typeof raw.field !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(raw.field) || /^(?:action|cmd|command|delete|logout|method)$/i.test(raw.field)) throw Error("Template case requires a safe field or parameter name");
    if (typeof raw.path !== "string" || !raw.path.startsWith("/") || raw.path.startsWith("//") || /[?#%\\]/.test(raw.path) || new URL(raw.path, scope.seeds[0]!).pathname !== raw.path) throw Error("Template case requires an exact path without query or fragment");
    if (!inScope(scope, new URL(raw.path, scope.seeds[0]!).href)) throw Error("Template case path is outside the approved scope");
    if (raw.method === "post" && !postPaths.includes(raw.path)) throw Error("Template POST path must be allowlisted in postPaths");
    return { id: raw.id as string, syntax: raw.syntax, method: raw.method, path: raw.path, field: raw.field, baselineRef: raw.baselineRef as string };
  });
  if (new Set(cases.map(c => c.id)).size !== cases.length) throw Error("Template case ids must be unique");
  return cases;
}

// The benign baseline value is operator-supplied, fresh per run, never
// recorded, and must not contain either computed witness.
export function normalizeTemplateValues(value: unknown, cases: TemplateCase[]): Record<string, string> {
  if (!cases.length) return {};
  if (value === undefined || !value || typeof value !== "object" || Array.isArray(value)) throw Error("Template cases require fresh input: " + cases[0]!.baselineRef);
  const values = value as Record<string, unknown>, result: Record<string, string> = {};
  for (const c of cases) {
    const baseline = values[c.baselineRef];
    if (baseline === undefined) throw Error("Supply fresh business input: " + c.baselineRef);
    if (typeof baseline !== "string" || !baseline.trim() || baseline.length > 512) throw Error("Template baseline must be a nonempty string up to 512 bytes: " + c.baselineRef);
    if (baseline.includes("42") || baseline.includes("49")) throw Error("Template baseline must not contain either computed witness (42 or 49): " + c.baselineRef);
    result[c.baselineRef] = baseline;
  }
  return result;
}

export type TemplateEngineInput = {
  scope: CampaignScope; secrets: Record<string, string>;
  auth: Record<string, string>; signal: AbortSignal; evidence: RequestEvidence[];
  reserve: () => Promise<{ id: string; at: number }>; redact: (value: string) => string;
  result: { proofs: TemplateProof[]; incomplete: boolean };
  publish: (proof: TemplateProof, findings: PentestFinding[], covered: string[]) => void;
};

export async function runTemplateCases(input: TemplateEngineInput, cases: TemplateCase[]): Promise<void> {
  const { scope, secrets, auth, signal, evidence, reserve, redact, result } = input;
  const hash = (data: string) => createHash("sha256").update(data).digest("hex");
  const scrub = (v: string) => Object.values(secrets).reduce((acc, s) => s ? acc.split(s).join("[REDACTED]") : acc, redact(v));
  const send = async (c: TemplateCase, value: string): Promise<{ status: number; body: string | null; signature: string | null }> => {
    const base = new URL(c.path, scope.seeds[0]!).href;
    signal.throwIfAborted();
    if (!inScope(scope, base)) throw Error("Template path left the approved scope");
    const ticket = await reserve();
    const started = Date.now();
    let requestUrl = base, bodyText: string | undefined;
    const headers: Record<string, string> = { ...auth };
    if (c.method === "get") requestUrl = base + "?" + encodeURIComponent(c.field) + "=" + encodeURIComponent(value);
    else { headers["content-type"] = "application/json"; bodyText = JSON.stringify({ [c.field]: value }); }
    const item: RequestEvidence = { id: ticket.id, at: new Date(ticket.at).toISOString(), url: base, method: c.method === "get" ? "GET" : "POST", authenticated: !!Object.keys(auth).length, status: 0, durationMs: 0, bodyHash: "", bytes: 0, contentType: "", engine: "http" };
    if (c.method === "post") { item.requestBytes = Buffer.byteLength(bodyText!); item.postPolicy = c.path; }
    evidence.push(item);
    try {
      const res = await fetch(requestUrl, { method: c.method === "get" ? "GET" : "POST", headers, body: bodyText, redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
      const chunks: Uint8Array[] = []; let bytes = 0, truncated = false;
      const reader = res.body?.getReader();
      if (reader) try { for (;;) { const part = await reader.read(); if (part.done) break; const chunk = part.value.subarray(0, 32768 - bytes); chunks.push(chunk); bytes += chunk.length; if (chunk.length < part.value.length) { truncated = true; break; } } } finally { await reader.cancel().catch(() => {}); }
      const body = Buffer.concat(chunks).toString("utf8");
      item.status = res.status; item.bytes = bytes; item.bodyHash = hash(body);
      item.contentType = redact(res.headers.get("content-type")?.split(";")[0] ?? "");
      if (truncated) { item.bodyTruncated = true; item.error = "Response body exceeded 32768 bytes"; }
      return { status: res.status, body: truncated ? null : body, signature: truncated ? null : res.status + "\n" + item.bodyHash };
    } catch (error) {
      item.error = redact("Template probe request failed: " + (error instanceof Error ? error.message : String(error)));
      return { status: 0, body: null, signature: null };
    } finally { item.durationMs = Date.now() - started; }
  };
  for (const c of cases) {
    signal.throwIfAborted();
    const target = new URL(c.path, scope.seeds[0]!).href, offset = evidence.length;
    const proof: TemplateProof = { id: randomUUID(), at: new Date().toISOString(), kind: "template", caseId: c.id, target, outcome: "inconclusive", summary: "Template verification did not complete", requestIds: [], observations: { syntax: c.syntax, method: c.method, field: c.field } };
    const finish = (findings: PentestFinding[], covered: string[]) => {
      proof.requestIds = evidence.slice(offset).map(e => e.id);
      if (proof.outcome === "inconclusive") result.incomplete = true;
      result.proofs.push(proof);
      input.publish(proof, findings.map(f => ({ ...f, title: scrub(f.title), detail: scrub(f.detail) })), covered);
    };
    try {
      const baseline = secrets[c.baselineRef]!;
      const truthPayload = renderCanary(c.syntax, "7*6"), falsyPayload = renderCanary(c.syntax, "7*7");
      const control = await send(c, baseline);
      proof.observations.controlStatus = control.status;
      if (!(control.status >= 200 && control.status < 300) || control.body === null) { proof.summary = "Baseline request was not a complete successful response (HTTP " + control.status + "); review the case path, field and baseline value"; finish([], []); continue; }
      // Negative control: the benign response must contain neither witness.
      if (control.body.includes("42") || control.body.includes("49")) { proof.summary = "Negative control failed: the baseline response already contains a computed witness (42 or 49); the page cannot ground a template differential"; finish([], []); continue; }
      const truth = await send(c, truthPayload);
      const falsy = await send(c, falsyPayload);
      const repeat = await send(c, baseline);
      proof.observations.truthStatus = truth.status; proof.observations.falsyStatus = falsy.status; proof.observations.repeatStatus = repeat.status;
      const stable = repeat.signature === control.signature;
      const truthEvaluated = truth.body !== null && truth.body.includes("42");
      const falsyEvaluated = falsy.body !== null && falsy.body.includes("49");
      const echoedRaw = (truth.body ?? "").includes(truthPayload);
      proof.observations.baselineStable = stable; proof.observations.truthEvaluated = truthEvaluated; proof.observations.falsyEvaluated = falsyEvaluated; proof.observations.payloadEchoedRaw = echoedRaw;
      const check = "template_" + createHash("sha256").update(c.id).digest("hex").slice(0, 16);
      if (!stable) { proof.summary = "The baseline response was not repeatable; volatile responses cannot ground a template differential"; finish([], []); continue; }
      if (truthEvaluated && falsyEvaluated) {
        proof.outcome = "observed";
        proof.summary = "Two distinct arithmetic canaries were evaluated by the template engine";
        const finding: PentestFinding = {
          id: check, check, verdict: "finding", severity: "high", target,
          title: "Template injection confirmed by dual-expression evaluation: " + c.id,
          detail: "The benign baseline succeeded twice with identical signatures and contained neither computed witness. Submitting the " + c.syntax + "-syntax canaries through the declared " + (c.method === "get" ? "parameter" : "JSON field") + " caused the application to evaluate both expressions: 7*6 rendered 42 and 7*7 rendered 49 (truth HTTP " + truth.status + ", falsy HTTP " + falsy.status + "). Two distinct computed outputs rule out coincidence or static echo. Only inert arithmetic was submitted — no data access, no side effects.",
          remediation: "Never pass user input into template compilation; render user data as values, not template source. If templating is required, use a sandboxed engine with no unsafe extensions and re-run this case after repair.",
        };
        finish([finding], [coverageKey(target, check)]);
        continue;
      }
      proof.outcome = "not_observed";
      proof.summary = echoedRaw
        ? "The canary was echoed back verbatim without evaluation (treated as data, not template source)"
        : "Neither expression was evaluated within the observation window (encoded, rejected or normalized)";
      finish([], [coverageKey(target, check)]);
    } catch (error) {
      signal.throwIfAborted();
      proof.summary = "Template case could not be executed: " + scrub(error instanceof Error ? error.message : String(error));
      finish([], []);
    }
  }
}
