/**
 * Red transport (RED_TEAM_BUILD_SPEC §4.2, §5.4).
 *
 * The only in-process HTTP surface of the red build. Every request:
 *   1. passes the §0.4 authorization gate (default-deny; localhost fallback),
 *   2. is rate-limited (token bucket) and counted against the campaign budget,
 *   3. is aborted by the kill-switch or the campaign AbortSignal,
 *   4. records red request evidence (method, status, bytes, redacted body).
 *
 * Unlike the blue `scopedTransport` (GET-only by design) the red transport may
 * carry POST/PUT/PATCH bodies for payload delivery; DELETE is destructive by
 * default and requires the approval callback. The blue path is untouched.
 */
import type { BridgeEnvelope } from "../../bridges/types.js";
import { gate, killSwitchSignal, RateLimiter, type AuthorizationRecord, type GateDeps } from "./gate.js";
import type { GateDecision, RedAction } from "./types.js";

/** Red request evidence (shape-compatible with the blue RequestEvidence core). */
export interface RedRequestEvidence {
  id: string;
  at: string;
  url: string;
  method: string;
  status: number;
  durationMs: number;
  bytes: number;
  /** Redacted request body (payload proofs), capped. */
  requestBody?: string;
  error?: string;
}

export interface RedHttpResult {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  setCookie: string[];
  body: string;
  bodyTruncated?: boolean;
  error?: string;
}

/** Raised when the §0.4 gate denies a request; carries the decision for audit. */
export class RedGateError extends Error {
  constructor(public readonly decision: GateDecision) {
    super(`red gate denied ${decision.reason}`);
    this.name = "RedGateError";
  }
}

/** Raised when the campaign's total request budget is exhausted (§5.4). */
export class RedBudgetError extends Error {
  constructor() {
    super("request budget reached");
    this.name = "RedBudgetError";
  }
}

export interface RedTransportDeps {
  signal?: AbortSignal;
  limiter?: RateLimiter;
  /** Extra gate deps (clock override, kill-switch state). */
  gateDeps?: Omit<GateDeps, "approval" | "limiter" | "requestCount">;
  /** Human approval for destructive requests (default: deny). */
  approval?: GateDeps["approval"];
  evidence?: RedRequestEvidence[];
  maxBodyBytes?: number;
  timeoutMs?: number;
  /** Capability tag used in the gate action. */
  actionTag?: string;
}

export interface RedRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Mark this request destructive (default: only DELETE). */
  destructive?: boolean;
}

export interface RedTransport {
  request(input: string, opts?: RedRequestOptions): Promise<RedHttpResult>;
  readonly evidence: RedRequestEvidence[];
  readonly count: number;
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ALLOWED_METHODS = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);

/**
 * Build a gated transport bound to one authorization record (or the localhost
 * default posture when null). The gate sees the live request count so the
 * campaign budget is enforced on every subsequent decision.
 */
export function redTransport(authz: AuthorizationRecord | null, deps: RedTransportDeps = {}): RedTransport {
  const limiter = deps.limiter ?? new RateLimiter(authz?.limits.maxReqPerSec ?? 10, authz?.limits.maxConcurrent ?? 4);
  const evidence: RedRequestEvidence[] = deps.evidence ?? [];
  const maxBodyBytes = deps.maxBodyBytes ?? 32768;
  const timeoutMs = deps.timeoutMs ?? 8000;
  let count = 0;

  const transport: RedTransport = {
    get count() {
      return count;
    },
    get evidence() {
      return evidence;
    },
    async request(input, opts = {}) {
      const method = (opts.method ?? "GET").toUpperCase();
      if (!ALLOWED_METHODS.has(method)) throw new Error(`unsupported red request method: ${method}`);
      const action: RedAction = {
        capability: deps.actionTag ?? "red.http",
        verb: READ_METHODS.has(method) ? "read" : "write",
        ...(opts.destructive ?? method === "DELETE" ? { destructive: opts.destructive ?? method === "DELETE" } : {}),
      };
      const decision = gate(input, action, authz, {
        ...deps.gateDeps,
        ...(deps.approval ? { approval: deps.approval } : {}),
        limiter,
        requestCount: () => count,
      });
      if (!decision.allow) {
        if (decision.reason === "request budget reached") throw new RedBudgetError();
        throw new RedGateError(decision);
      }

      const acquired = limiter.tryAcquire();
      if (!acquired) throw new RedGateError({ allow: false, reason: "rate limit exceeded", authzId: decision.authzId });
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = (): void => controller.abort();
      deps.signal?.addEventListener("abort", onAbort, { once: true });
      // §5.5a: engaging the kill-switch aborts in-flight red requests too.
      const kill = killSwitchSignal();
      kill.addEventListener("abort", onAbort, { once: true });
      try {
        const res = await fetch(input, {
          method,
          headers: opts.headers,
          body: opts.body,
          redirect: "manual",
          signal: controller.signal,
        });
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
        const setCookie =
          typeof (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function"
            ? (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
            : headers["set-cookie"]
              ? [headers["set-cookie"]]
              : [];
        let body = "";
        let bodyTruncated = false;
        if (method !== "HEAD") {
          const text = await res.text();
          if (text.length > maxBodyBytes) {
            body = text.slice(0, maxBodyBytes);
            bodyTruncated = true;
          } else {
            body = text;
          }
        }
        count++;
        evidence.push({
          id: `R${count}`,
          at: new Date().toISOString(),
          url: input,
          method,
          status: res.status,
          durationMs: Date.now() - started,
          bytes: body.length,
          ...(opts.body ? { requestBody: opts.body.slice(0, 2048) } : {}),
        });
        return {
          ok: res.status >= 200 && res.status < 300,
          status: res.status,
          headers,
          setCookie,
          body,
          ...(bodyTruncated ? { bodyTruncated: true } : {}),
        };
      } finally {
        clearTimeout(timer);
        deps.signal?.removeEventListener("abort", onAbort);
        kill.removeEventListener("abort", onAbort);
        limiter.release();
      }
    },
  };
  return transport;
}

/** Convenience type re-export for capability contexts. */
export type { BridgeEnvelope };
