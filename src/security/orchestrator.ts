/**
 * Evidence-gated pentest orchestration (clean-room TypeScript).
 *
 * NOTICE: original implementation written from the behavioral specification
 * only. It reuses this repository's existing pentest tool calls and shares no
 * code, brand names or assets with any external project.
 *
 * The loop is deliberately split into three pure phases — recon, hypothesis
 * and validate — and every claim that survives to a reported finding must pass
 * a structural evidence gate. A finding is never reported as an exploit on the
 * strength of a model assertion or a static pattern alone: it needs a captured
 * request/response pair or an explicit proof-of-concept observation.
 *
 * Scope is localhost-only by construction. The orchestrator never reaches the
 * network itself; it drives an injected runner whose default implementation is
 * a thin recording wrapper around the existing pentest checks.
 */

import { safeGet, runPentestCheck, PENTEST_CHECKS, type PentestFinding } from "../tools/pentest.js";
import type { HttpResult } from "./scope.js";

/** Raised when a target is outside the permitted loopback scope. */
export class LocalhostScopeError extends Error {
  constructor(target: string) {
    super(`Refusing non-localhost pentest target: ${target}`);
    this.name = "LocalhostScopeError";
  }
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]", "ip6-localhost"]);

/** Normalize and assert a target is an HTTP(S) loopback URL. */
export function assertLocalhost(target: string): string {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new LocalhostScopeError(target);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new LocalhostScopeError(target);
  if (!LOCAL_HOSTNAMES.has(url.hostname.toLowerCase())) throw new LocalhostScopeError(target);
  return url.href;
}

/** Non-throwing loopback check. */
export function isLocalhostTarget(target: string): boolean {
  try {
    assertLocalhost(target);
    return true;
  } catch {
    return false;
  }
}

/** A captured observation that can gate a claim. */
export interface Evidence {
  id: string;
  kind: "request_response" | "poc";
  at: string;
  url?: string;
  method?: string;
  request?: string;
  status?: number;
  response?: string;
  headers?: Record<string, string>;
  /** Redacted per-cookie attribute summary; cookie values are never stored. */
  cookieFlags?: string[];
  bodyOmitted?: boolean;
  bodyTruncated?: boolean;
  poc?: string;
  observed?: string;
}

let evidenceSeq = 0;
/** Monotonic, process-local evidence identifier. */
export const nextEvidenceId = (): string => `EV${String(++evidenceSeq).padStart(4, "0")}`;

const REDACTED_COOKIE = "<redacted>";

function summarizeCookies(setCookie: string[]): string[] {
  return setCookie.map((raw) => {
    const parts = raw.split(";").map((p) => p.trim()).filter(Boolean);
    const name = (parts[0]?.split("=")[0] ?? "cookie").trim();
    const flags = parts.slice(1).map((p) => p.split("=")[0]!.trim()).filter(Boolean);
    return `${name}=${REDACTED_COOKIE}${flags.length ? "; " + flags.join("; ") : ""}`;
  });
}

/** A proof-of-concept probe the validate phase may attempt. */
export interface ProbeRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** Human-readable statement of what a successful probe demonstrates. */
  demonstrates?: string;
}

/** The only side-effecting surface the orchestrator drives. */
export interface PentestRunner {
  check(target: string, check: string, signal?: AbortSignal): Promise<PentestFinding[]>;
  probe(request: ProbeRequest, signal?: AbortSignal): Promise<HttpResult>;
  /** Evidence recorded by this runner, when it records any. */
  readonly evidence?: Evidence[];
}

/**
 * Default runner: orchestrates the existing pentest checks exactly as shipped
 * and records the request/response evidence those checks already produce.
 */
export class RecordingRunner implements PentestRunner {
  readonly evidence: Evidence[] = [];

  constructor(private readonly signal?: AbortSignal) {}

  private record(input: string, options: { method?: string; headers?: Record<string, string> }, result: HttpResult): Evidence {
    return {
      id: nextEvidenceId(),
      kind: "request_response",
      at: new Date().toISOString(),
      url: input,
      method: options.method ?? "GET",
      request: `${options.method ?? "GET"} ${input}`,
      status: result.status,
      response: result.body.slice(0, 2000),
      headers: { ...result.headers },
      cookieFlags: result.setCookie.length ? summarizeCookies(result.setCookie) : undefined,
      ...(result.bodyOmitted ? { bodyOmitted: true } : {}),
      ...(result.bodyTruncated ? { bodyTruncated: true } : {}),
    };
  }

  private request: typeof safeGet = async (input, options = {}) => {
    const result = await safeGet(input, { ...options, signal: this.signal ?? options.signal });
    this.evidence.push(this.record(input, options, result));
    return result;
  };

  async check(target: string, check: string, signal?: AbortSignal): Promise<PentestFinding[]> {
    return runPentestCheck(target, check, signal ?? this.signal, this.request);
  }

  async probe(request: ProbeRequest, signal?: AbortSignal): Promise<HttpResult> {
    return this.request(request.url, { method: request.method, headers: request.headers, signal: signal ?? this.signal });
  }
}

// ---------------------------------------------------------------------------
// Evidence gate
// ---------------------------------------------------------------------------

export interface GateInput {
  id: string;
  claim: string;
  status: "confirmed" | "refuted" | "inconclusive";
  evidence?: Evidence[];
}

export interface GateResult {
  id: string;
  /** True when the gate is satisfied and the claim may be reported. */
  gated: boolean;
  /** True only when the claim is reportable as a confirmed finding. */
  reported: boolean;
  reason: string;
  evidence: Evidence[];
}

/** Structural validity of a single evidence item. */
export function isValidEvidence(e: Evidence | undefined): e is Evidence {
  if (!e || typeof e !== "object") return false;
  if (e.kind !== "request_response" && e.kind !== "poc") return false;
  if (typeof e.at !== "string" || !e.at) return false;
  if (e.kind === "request_response") {
    return (
      typeof e.url === "string" &&
      !!e.url &&
      typeof e.method === "string" &&
      !!e.method &&
      typeof e.status === "number" &&
      (typeof e.response === "string" || e.bodyOmitted === true)
    );
  }
  return typeof e.poc === "string" && !!e.poc && typeof e.observed === "string" && !!e.observed;
}

/** Whether an item actually demonstrates a claim rather than merely existing. */
export function demonstratesClaim(e: Evidence): boolean {
  if (e.kind === "poc") return typeof e.observed === "string" && e.observed.length > 0;
  if (e.bodyOmitted === true) return false;
  return typeof e.status === "number" && typeof e.response === "string" && e.response.length > 0;
}

/**
 * The single gate every claim must pass before it is reported.
 *
 * Rules, in order: a non-empty claim; a "confirmed" status; at least one
 * structurally valid evidence item; and at least one item that actually
 * demonstrates the claim (a captured response body or a PoC observation).
 * Anything else is returned as not reported with an explicit reason.
 */
export function evaluateEvidenceGate(input: GateInput): GateResult {
  const evidence = (input.evidence ?? []).filter(isValidEvidence);
  if (!input.claim || !input.claim.trim()) {
    return { id: input.id, gated: false, reported: false, reason: "empty claim", evidence };
  }
  if (input.status !== "confirmed") {
    return { id: input.id, gated: false, reported: false, reason: `status is "${input.status}", not "confirmed"`, evidence };
  }
  if (!evidence.length) {
    return { id: input.id, gated: false, reported: false, reason: "no valid evidence attached", evidence };
  }
  if (!evidence.some(demonstratesClaim)) {
    return {
      id: input.id,
      gated: false,
      reported: false,
      reason: "attached evidence does not demonstrate the claim (missing response body or PoC observation)",
      evidence,
    };
  }
  return { id: input.id, gated: true, reported: true, reason: "", evidence };
}

// ---------------------------------------------------------------------------
// Phase 1 — recon
// ---------------------------------------------------------------------------

export interface ReconObservation {
  id: string;
  check: string;
  target: string;
  verdict: PentestFinding["verdict"];
  severity: PentestFinding["severity"];
  title: string;
  detail: string;
  remediation?: string;
  evidence: Evidence[];
}

const makeId = (prefix: string) => {
  let n = 0;
  return () => `${prefix}${String(++n).padStart(4, "0")}`;
};
const nextObservationId = makeId("OBS");
const nextHypothesisId = makeId("HYP");

export async function reconAgent(opts: {
  target: string;
  checks: string[];
  runner: PentestRunner;
  signal?: AbortSignal;
}): Promise<{ observations: ReconObservation[]; evidence: Evidence[] }> {
  const observations: ReconObservation[] = [];
  for (const check of opts.checks) {
    opts.signal?.throwIfAborted();
    const before = opts.runner.evidence?.length ?? 0;
    let findings: PentestFinding[];
    try {
      findings = await opts.runner.check(opts.target, check, opts.signal);
    } catch (err) {
      observations.push({
        id: nextObservationId(),
        check,
        target: opts.target,
        verdict: "error",
        severity: "info",
        title: "Recon check failed",
        detail: (err as Error).message,
        evidence: [],
      });
      continue;
    }
    const recorded = opts.runner.evidence?.slice(before) ?? [];
    for (const f of findings) {
      observations.push({
        id: nextObservationId(),
        check,
        target: f.target,
        verdict: f.verdict,
        severity: f.severity,
        title: f.title,
        detail: f.detail,
        ...(f.remediation ? { remediation: f.remediation } : {}),
        evidence: recorded,
      });
    }
  }
  return { observations, evidence: opts.runner.evidence ?? [] };
}

// ---------------------------------------------------------------------------
// Phase 2 — hypothesis
// ---------------------------------------------------------------------------

export interface Hypothesis {
  id: string;
  source: string;
  check: string;
  target: string;
  title: string;
  rationale: string;
  probe: ProbeRequest;
  /** Returns a demonstration string when the probe reproduces the claim, else null. */
  confirm: (result: HttpResult) => string | null;
}

const joinUrl = (base: string, sub: string): string =>
  base.replace(/\/+$/, "") + (sub.startsWith("/") ? sub : "/" + sub);

const SENSITIVE_PATHS = ["/.env", "/.git/HEAD", "/swagger.json", "/openapi.json", "/actuator/env"];
const UNTRUSTED_ORIGIN = "https://untrusted-origin-check.invalid";

function parseExposedPaths(detail: string): string[] {
  const out: string[] = [];
  const re = /(\/[^\s,()]+)\s+\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(detail)) !== null) out.push(m[1]!);
  return [...new Set(out)];
}

function missingCoreHeaders(headers: Record<string, string>): string[] {
  const missing: string[] = [];
  if (!headers["content-security-policy"]) missing.push("Content-Security-Policy");
  if (!headers["x-frame-options"] && !(headers["content-security-policy"] ?? "").includes("frame-ancestors")) missing.push("X-Frame-Options");
  if (!headers["x-content-type-options"]) missing.push("X-Content-Type-Options");
  if (!headers["referrer-policy"]) missing.push("Referrer-Policy");
  if (!headers["permissions-policy"]) missing.push("Permissions-Policy");
  return missing;
}

function weakCookies(setCookie: string[]): string[] {
  return setCookie.filter((raw) => {
    const attrs = new Set(raw.split(";").slice(1).map((a) => a.trim().split("=")[0]!.toLowerCase()));
    return !attrs.has("httponly") || !attrs.has("secure") || !attrs.has("samesite");
  });
}

interface HypothesisRule {
  applies: (o: ReconObservation) => boolean;
  make: (o: ReconObservation) => Hypothesis[];
}

const HYPOTHESIS_RULES: HypothesisRule[] = [
  {
    applies: (o) => o.check === "security_headers" && o.verdict === "finding",
    make: (o) => [
      {
        id: nextHypothesisId(),
        source: o.id,
        check: o.check,
        target: o.target,
        title: "Missing response security headers can enable injection or clickjacking",
        rationale: `Recon reported: ${o.detail}`,
        probe: { url: o.target, method: "GET", demonstrates: "absence of a core response security header" },
        confirm: (r) => {
          const missing = missingCoreHeaders(r.headers);
          return missing.length ? `Missing ${missing.join(", ")} on HTTP ${r.status}` : null;
        },
      },
    ],
  },
  {
    applies: (o) => o.check === "cookie_flags" && o.verdict === "finding",
    make: (o) => [
      {
        id: nextHypothesisId(),
        source: o.id,
        check: o.check,
        target: o.target,
        title: "Session cookies lack HttpOnly/Secure/SameSite flags",
        rationale: `Recon reported: ${o.detail}`,
        probe: { url: o.target, method: "GET", demonstrates: "a Set-Cookie header missing a security attribute" },
        confirm: (r) => {
          const weak = weakCookies(r.setCookie);
          return weak.length ? `${weak.length} cookie(s) missing HttpOnly/Secure/SameSite` : null;
        },
      },
    ],
  },
  {
    applies: (o) => o.check === "server_banner" && o.verdict !== "pass" && o.verdict !== "error",
    make: (o) => [
      {
        id: nextHypothesisId(),
        source: o.id,
        check: o.check,
        target: o.target,
        title: "Server discloses technology version banners",
        rationale: `Recon reported: ${o.detail}`,
        probe: { url: o.target, method: "GET", demonstrates: "a Server/X-Powered-By version banner" },
        confirm: (r) => {
          const disclosed = ["server", "x-powered-by", "x-aspnet-version", "x-generator"].filter((k) => r.headers[k]);
          return disclosed.length ? `Disclosed ${disclosed.map((k) => `${k}: ${r.headers[k]}`).join(", ")}` : null;
        },
      },
    ],
  },
  {
    applies: (o) => o.check === "exposed_files" && o.verdict === "finding",
    make: (o) => {
      const paths = parseExposedPaths(o.detail).length ? parseExposedPaths(o.detail) : SENSITIVE_PATHS;
      return paths.map((p) => ({
        id: nextHypothesisId(),
        source: o.id,
        check: o.check,
        target: o.target,
        title: `Sensitive path ${p} is publicly retrievable`,
        rationale: `Recon reported: ${o.detail}`,
        probe: { url: joinUrl(o.target, p), method: "GET", demonstrates: `HTTP 200 body for ${p}` },
        confirm: (r) => (r.ok && r.status === 200 && r.body.length > 0 ? `HTTP ${r.status} returned ${r.body.length} byte(s) from ${p}` : null),
      }));
    },
  },
  {
    applies: (o) => o.check === "directory_listing" && o.verdict === "finding",
    make: (o) => [
      {
        id: nextHypothesisId(),
        source: o.id,
        check: o.check,
        target: o.target,
        title: "Directory listing exposes internal file names",
        rationale: `Recon reported: ${o.detail}`,
        probe: { url: o.target, method: "GET", demonstrates: "an 'Index of /' auto-index body" },
        confirm: (r) => (/<(title|h1)>[^<]*Index of \//i.test(r.body) ? "Response contains a directory auto-index" : null),
      },
    ],
  },
  {
    applies: (o) => o.check === "cors_policy" && o.verdict === "finding",
    make: (o) => [
      {
        id: nextHypothesisId(),
        source: o.id,
        check: o.check,
        target: o.target,
        title: "Permissive CORS reflects an untrusted origin",
        rationale: `Recon reported: ${o.detail}`,
        probe: {
          url: o.target,
          method: "GET",
          headers: { Origin: UNTRUSTED_ORIGIN },
          demonstrates: "reflection of an untrusted Origin, optionally with credentials",
        },
        confirm: (r) => {
          const acao = r.headers["access-control-allow-origin"] ?? "";
          const acac = (r.headers["access-control-allow-credentials"] ?? "").toLowerCase() === "true";
          if (!acao || (!acao.includes("untrusted-origin-check") && acao !== "*")) return null;
          return `Access-Control-Allow-Origin: ${acao}${acac ? " with Access-Control-Allow-Credentials: true" : ""}`;
        },
      },
    ],
  },
  {
    applies: (o) => o.check === "http_methods" && o.verdict === "finding",
    make: (o) => [
      {
        id: nextHypothesisId(),
        source: o.id,
        check: o.check,
        target: o.target,
        title: "Dangerous HTTP methods are advertised",
        rationale: `Recon reported: ${o.detail}`,
        probe: { url: o.target, method: "OPTIONS", demonstrates: "risky methods in the Allow header" },
        confirm: (r) => {
          const allow = (r.headers["allow"] ?? r.headers["access-control-allow-methods"] ?? "").toUpperCase();
          const risky = ["TRACE", "TRACK", "PUT", "DELETE"].filter((m) => allow.split(/\s*,\s*/).includes(m));
          return risky.length ? `Allow: ${allow}` : null;
        },
      },
    ],
  },
];

/** Derive falsifiable hypotheses from recon observations. */
export function hypothesisAgent(observations: ReconObservation[]): Hypothesis[] {
  const hypotheses: Hypothesis[] = [];
  for (const o of observations) {
    for (const rule of HYPOTHESIS_RULES) {
      if (rule.applies(o)) hypotheses.push(...rule.make(o));
    }
  }
  return hypotheses;
}

// ---------------------------------------------------------------------------
// Phase 3 — validate
// ---------------------------------------------------------------------------

export interface ValidationOutcome {
  hypothesisId: string;
  status: "confirmed" | "refuted" | "inconclusive";
  claim: string;
  evidence: Evidence[];
  detail: string;
}

export async function validateAgent(opts: {
  hypotheses: Hypothesis[];
  runner: PentestRunner;
  signal?: AbortSignal;
}): Promise<ValidationOutcome[]> {
  const outcomes: ValidationOutcome[] = [];
  for (const h of opts.hypotheses) {
    opts.signal?.throwIfAborted();
    const before = opts.runner.evidence?.length ?? 0;
    let result: HttpResult;
    try {
      result = await opts.runner.probe(h.probe, opts.signal);
    } catch (err) {
      outcomes.push({ hypothesisId: h.id, status: "inconclusive", claim: h.title, evidence: [], detail: `PoC failed: ${(err as Error).message}` });
      continue;
    }
    const recorded = opts.runner.evidence?.slice(before) ?? [];
    const observed = h.confirm(result);
    if (observed) {
      const poc: Evidence = {
        id: nextEvidenceId(),
        kind: "poc",
        at: new Date().toISOString(),
        poc: `${h.probe.method ?? "GET"} ${h.probe.url}`,
        observed,
      };
      outcomes.push({ hypothesisId: h.id, status: "confirmed", claim: h.title, evidence: [...recorded, poc], detail: observed });
    } else {
      outcomes.push({
        hypothesisId: h.id,
        status: "refuted",
        claim: h.title,
        evidence: recorded,
        detail: "PoC did not reproduce the recon observation; the recon signal stays unconfirmed.",
      });
    }
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

const CHECK_SEVERITY: Record<string, PentestFinding["severity"]> = {
  exposed_files: "high",
  cors_policy: "high",
  http_methods: "low",
  security_headers: "medium",
  cookie_flags: "medium",
  directory_listing: "medium",
  server_banner: "info",
  tls_info: "high",
};

export interface OrchestratedFinding {
  id: string;
  check: string;
  target: string;
  title: string;
  severity: PentestFinding["severity"];
  detail: string;
  evidence: Evidence[];
  hypothesisId: string;
}

export interface UnverifiedClaim {
  id: string;
  check: string;
  target: string;
  title: string;
  detail: string;
  reason: string;
  evidence: Evidence[];
}

export interface OrchestratorResult {
  target: string;
  phases: { recon: number; hypothesis: number; validate: number };
  observations: ReconObservation[];
  hypotheses: Hypothesis[];
  validations: ValidationOutcome[];
  /** Gate-passing confirmed findings; the only claims safe to report. */
  findings: OrchestratedFinding[];
  /** Gate-blocked claims, retained with the reason they were withheld. */
  unverified: UnverifiedClaim[];
  evidence: Evidence[];
}

export interface OrchestratorOptions {
  target: string;
  checks?: string[];
  runner?: PentestRunner;
  maxHypotheses?: number;
  signal?: AbortSignal;
}

/**
 * Run the full recon -> hypothesis -> validate loop against a localhost target
 * and return only gate-passing findings. Every intermediate artifact is kept so
 * a withheld claim can be audited against its evidence and the gate reason.
 */
export async function orchestrate(opts: OrchestratorOptions): Promise<OrchestratorResult> {
  const target = assertLocalhost(opts.target);
  const checks = opts.checks?.length ? opts.checks : PENTEST_CHECKS.map((c) => c.name);
  const runner = opts.runner ?? new RecordingRunner(opts.signal);

  const { observations } = await reconAgent({ target, checks, runner, signal: opts.signal });
  const hypotheses = hypothesisAgent(observations).slice(0, opts.maxHypotheses ?? 50);
  const validations = await validateAgent({ hypotheses, runner, signal: opts.signal });

  const findings: OrchestratedFinding[] = [];
  const unverified: UnverifiedClaim[] = [];
  for (const v of validations) {
    const h = hypotheses.find((x) => x.id === v.hypothesisId);
    if (!h) continue;
    const gate = evaluateEvidenceGate({ id: v.hypothesisId, claim: v.claim, status: v.status, evidence: v.evidence });
    if (gate.reported) {
      findings.push({
        id: v.hypothesisId,
        check: h.check,
        target: h.target,
        title: h.title,
        severity: CHECK_SEVERITY[h.check] ?? "medium",
        detail: v.detail,
        evidence: gate.evidence,
        hypothesisId: h.id,
      });
    } else {
      unverified.push({
        id: v.hypothesisId,
        check: h.check,
        target: h.target,
        title: h.title,
        detail: v.detail,
        reason: gate.reason,
        evidence: gate.evidence,
      });
    }
  }

  return {
    target,
    phases: { recon: observations.length, hypothesis: hypotheses.length, validate: validations.length },
    observations,
    hypotheses,
    validations,
    findings,
    unverified,
    evidence: runner.evidence ?? [],
  };
}
