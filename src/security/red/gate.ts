/**
 * Red-team scope/authorization gate (RED_TEAM_BUILD_SPEC §0.4).
 *
 * Every target-touching red action consults this gate before any packet leaves
 * the box. Properties (all mandatory by spec):
 *
 *  - Allow-list only: a target is reachable only if it matches the signed
 *    authorization record's allowHosts/allowUrlPrefixes. Default-deny.
 *  - Written authorization with expiry: the gate refuses missing or expired
 *    AuthorizationRecords.
 *  - Deny-list wins over the allow-list (cloud metadata, other tenants).
 *  - Rate limits and request budgets per campaign.
 *  - Kill-switch: one flag blocks every new approval and aborts in-flight work.
 *  - Destructive actions require explicit, logged human approval.
 *  - Zero-config default posture: without any record, only loopback targets
 *    are reachable and destructive actions stay denied (spec O-1).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isLocalhostTarget } from "../orchestrator.js";
import type { GateDecision, RedAction } from "./types.js";

// ---------------------------------------------------------------------------
// Authorization records
// ---------------------------------------------------------------------------

export interface AuthorizationScope {
  /** Exact hostnames / IPv4 / IPv6 literals and IPv4 CIDRs. No wildcards. */
  allowHosts: string[];
  /** Allowed ports; empty means any port (hosts still have to match). */
  allowPorts: number[];
  /** Exact URL prefixes (origin or origin+path). */
  allowUrlPrefixes: string[];
  /** Hosts/CIDRs denied even when otherwise in scope (deny wins). */
  denyAlways: string[];
}

export interface AuthorizationLimits {
  maxReqPerSec: number;
  maxConcurrent: number;
  maxTotalRequests: number;
  destructiveAllowed: boolean;
}

export interface AuthorizationRecord {
  /** AUTHZ-####; referenced by every audit entry of the campaign. */
  id: string;
  owner: "khamis";
  scope: AuthorizationScope;
  authorization: { statement: string; acknowledgedAt: string; expiresAt: string };
  limits: AuthorizationLimits;
  /** HMAC-SHA256 over the canonical record, assigned at persistence. */
  signature?: string;
}

export interface CreateAuthorizationInput {
  statement: string;
  /** Seconds from now until the record expires; <= 0 creates an already-expired record. */
  expiresInSeconds: number;
  scope: AuthorizationScope;
  /** Defaults per spec §0.4: 10 req/s, 4 concurrent, 10_000 requests, destructive off. */
  limits?: Partial<AuthorizationLimits>;
  /** Convenience shorthand for limits.destructiveAllowed (explicit human sign-off). */
  destructiveAllowed?: boolean;
  /** Overrides the id (tests / migrations). */
  id?: string;
  /** Overrides the acknowledgement time (tests). */
  now?: Date;
  /** Data root used for persistent id allocation and record signing. */
  root?: string;
}

/** Canonical JSON with recursively sorted object keys (signing/audit hashes). */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}

/** Allocate the next id from the persisted authz directory, across restarts. */
export function nextAuthorizationId(root: string = defaultDataRoot()): string {
  let max = 0;
  try {
    for (const file of fs.readdirSync(authzDir(root))) {
      const match = /^AUTHZ-(\d+)\.json$/.exec(file);
      if (match) max = Math.max(max, Number(match[1]));
    }
  } catch {
    /* no authz directory yet */
  }
  return `AUTHZ-${String(max + 1).padStart(4, "0")}`;
}

/** Create a signed, immutable authorization record with spec defaults. */
export function createAuthorizationRecord(input: CreateAuthorizationInput): AuthorizationRecord {
  if (!input.statement || !input.statement.trim()) throw new Error("authorization statement required");
  if (!Number.isFinite(input.expiresInSeconds)) throw new Error("expiresInSeconds must be a finite number");
  validateScope(input.scope);
  const now = input.now ?? new Date();
  const limits: AuthorizationLimits = {
    maxReqPerSec: input.limits?.maxReqPerSec ?? 10,
    maxConcurrent: input.limits?.maxConcurrent ?? 4,
    maxTotalRequests: input.limits?.maxTotalRequests ?? 10_000,
    destructiveAllowed: input.destructiveAllowed ?? input.limits?.destructiveAllowed ?? false,
  };
  if (limits.maxReqPerSec < 1 || limits.maxConcurrent < 1 || limits.maxTotalRequests < 1) throw new Error("limits must be >= 1");
  return {
    id: input.id ?? nextAuthorizationId(input.root ?? defaultDataRoot()),
    owner: "khamis",
    scope: input.scope,
    authorization: {
      statement: input.statement.trim().slice(0, 500),
      acknowledgedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.expiresInSeconds * 1000).toISOString(),
    },
    limits,
  };
}

function validateScope(scope: AuthorizationScope): void {
  for (const key of ["allowHosts", "allowPorts", "allowUrlPrefixes", "denyAlways"] as const) {
    const list = scope[key];
    if (!Array.isArray(list) || list.some((x) => typeof x !== "string" && typeof x !== "number")) {
      throw new Error(`scope.${key} must be a list`);
    }
  }
  if (scope.allowPorts.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) throw new Error("allowPorts must be valid ports");
  for (const host of scope.allowHosts) {
    if (typeof host !== "string" || !host.trim() || host.includes("*") || host.endsWith("/0")) {
      throw new Error(`host entries must be exact and must not cover public space: ${host}`);
    }
  }
  for (const host of scope.denyAlways) {
    if (typeof host !== "string" || !host.trim() || host.includes("*")) throw new Error(`host entries must be exact (no wildcards): ${host}`);
  }
  for (const prefix of scope.allowUrlPrefixes) {
    if (typeof prefix !== "string" || !/^https?:\/\//.test(prefix)) throw new Error(`allowUrlPrefixes must be absolute http(s) URLs: ${prefix}`);
    let url: URL;
    try {
      url = new URL(prefix);
    } catch {
      throw new Error(`allowUrlPrefixes must be valid URLs: ${prefix}`);
    }
    if (url.username || url.password || url.search || url.hash) throw new Error(`allowUrlPrefixes must not contain credentials, query or fragment: ${prefix}`);
  }
}

// ---------------------------------------------------------------------------
// Persistence (immutable once signed; referenced by every audit entry)
// ---------------------------------------------------------------------------

/** Default data root for red persistence (spec U-8: ~/.loam/security). */
export function defaultDataRoot(): string {
  return path.join(os.homedir(), ".loam", "security");
}

const authzDir = (root: string) => path.join(root, "authz");
const authzFile = (root: string, id: string) => path.join(authzDir(root), `${id}.json`);

function signingKey(root: string): string {
  const file = path.join(root, "authz-signing.key");
  fs.mkdirSync(root, { recursive: true });
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  const key = randomBytes(32).toString("hex");
  fs.writeFileSync(file, key, { encoding: "utf8", mode: 0o600 });
  return key;
}

function signAuthorization(rec: AuthorizationRecord, root: string): string {
  const { signature: _ignored, ...unsigned } = rec;
  return createHmac("sha256", signingKey(root)).update(canonicalJson(unsigned)).digest("hex");
}

/** Persist a record; refuses to overwrite an existing id (immutable once signed). */
export function saveAuthorization(rec: AuthorizationRecord, root: string = defaultDataRoot()): void {
  fs.mkdirSync(authzDir(root), { recursive: true });
  const file = authzFile(root, rec.id);
  if (fs.existsSync(file)) throw new Error(`authorization ${rec.id} already exists; records are immutable once signed`);
  const signed: AuthorizationRecord = { ...rec, signature: signAuthorization(rec, root) };
  fs.writeFileSync(file, JSON.stringify(signed, null, 2), { encoding: "utf8" });
}

/** Load a record, or null when missing/unreadable/tampered. */
export function loadAuthorization(id: string, root: string = defaultDataRoot()): AuthorizationRecord | null {
  try {
    const raw = fs.readFileSync(authzFile(root, id), "utf8");
    const rec = JSON.parse(raw) as AuthorizationRecord;
    if (!rec || rec.id !== id || !rec.scope || !rec.authorization || !rec.limits) return null;
    if (rec.signature) {
      const expected = signAuthorization(rec, root);
      const actualBuffer = Buffer.from(rec.signature, "hex");
      const expectedBuffer = Buffer.from(expected, "hex");
      if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
    }
    // Unsigned records written by older Loam versions remain readable as legacy;
    // every new saveAuthorization call writes a signed record.
    return rec;
  } catch {
    return null;
  }
}

/** All persisted records (newest last). Corrupt files are skipped, never thrown. */
export function listAuthorizations(root: string = defaultDataRoot()): AuthorizationRecord[] {
  try {
    return fs
      .readdirSync(authzDir(root))
      .filter((f) => f.endsWith(".json"))
      .map((f) => loadAuthorization(f.replace(/\.json$/, ""), root))
      .filter((r): r is AuthorizationRecord => !!r);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Scope matching
// ---------------------------------------------------------------------------

const ipv4ToInt = (ip: string): number | null => {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
};

/** IPv4 CIDR containment. Non-IPv4 inputs never match. */
export function cidrMatch(cidr: string, ip: string): boolean {
  const [block, bitsRaw] = cidr.split("/");
  if (!block || bitsRaw === undefined) return false;
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const blockInt = ipv4ToInt(block);
  const ipInt = ipv4ToInt(ip);
  if (blockInt === null || ipInt === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return ((blockInt & mask) >>> 0) === ((ipInt & mask) >>> 0);
}

const hostMatches = (entry: string, host: string): boolean =>
  entry.toLowerCase() === host || (entry.includes("/") && cidrMatch(entry, host));

interface ParsedTarget {
  host: string;
  port: number;
  href: string;
  protocol: "http:" | "https:";
  pathname: string;
}

const parseTarget = (target: string): ParsedTarget | null => {
  try {
    const url = new URL(target);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // Credentials never belong in scope decisions or persisted evidence.
    if (url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    return { host, port, href: url.href, protocol: url.protocol, pathname: url.pathname };
  } catch {
    return null;
  }
};

/** Allow-list + deny-list + prefix matching. Deny always wins. */
export function targetInScope(scope: AuthorizationScope, target: string): boolean {
  const parsed = parseTarget(target);
  if (!parsed) return false;
  const denied = scope.denyAlways.some((entry) => hostMatches(entry, parsed.host));
  if (denied) return false;
  const hostAllowed = scope.allowHosts.some((entry) => !entry.endsWith("/0") && hostMatches(entry, parsed.host));
  const portAllowed = scope.allowPorts.length === 0 || scope.allowPorts.includes(parsed.port);
  if (hostAllowed && portAllowed) return true;
  return scope.allowUrlPrefixes.some((prefix) => {
    const base = parseTarget(prefix);
    if (!base || base.protocol !== parsed.protocol || base.host !== parsed.host || base.port !== parsed.port) return false;
    const prefixPath = base.pathname.replace(/\/+$/, "");
    return prefixPath === "" || parsed.pathname === prefixPath || parsed.pathname.startsWith(`${prefixPath}/`);
  });
}

/** A record authorizes only until its expiry. */
export function authorizationActive(authz: AuthorizationRecord, now: Date = new Date()): boolean {
  const expires = Date.parse(authz.authorization.expiresAt);
  return Number.isFinite(expires) && now.getTime() <= expires;
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/** Token-bucket limiter for per-second and concurrency ceilings. */
export class RateLimiter {
  private readonly window: number[] = [];
  private active = 0;

  constructor(
    private readonly maxPerSec: number,
    private readonly maxConcurrent: number,
  ) {}

  /** True when a slot and a per-second token are available. */
  tryAcquire(now: number = Date.now()): boolean {
    if (this.active >= this.maxConcurrent) return false;
    while (this.window.length && now - this.window[0]! >= 1000) this.window.shift();
    if (this.window.length >= this.maxPerSec) return false;
    this.window.push(now);
    this.active++;
    return true;
  }

  /** Release a concurrency slot (per-second tokens expire by time). */
  release(): void {
    if (this.active > 0) this.active--;
  }
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface GateState {
  killSwitch: boolean;
}

/** Process-wide kill-switch state; UI controls flip this. */
const globalGateState: GateState = { killSwitch: false };

/** Abort signals fired when the kill-switch engages (§5.5a: abort in-flight). */
const killSwitchListeners = new Set<() => void>();

/** Engage the kill-switch: every new gate consultation denies and in-flight red work aborts. */
export function engageKillSwitch(): void {
  if (globalGateState.killSwitch) return;
  globalGateState.killSwitch = true;
  for (const listener of killSwitchListeners) {
    try {
      listener();
    } catch {
      /* a faulty listener never blocks the switch */
    }
  }
}

/** Reset the kill-switch (tests, manual recovery). */
export function resetKillSwitch(): void {
  globalGateState.killSwitch = false;
}

/** Whether the process-wide kill-switch is currently engaged. */
export function isKillSwitchEngaged(): boolean {
  return globalGateState.killSwitch;
}

export interface KillSwitchSubscription {
  signal: AbortSignal;
  /** Remove the listener when work completes normally (not only on abort). */
  dispose: () => void;
}

/**
 * An AbortSignal that fires when the kill-switch engages, so in-flight red
 * requests and bridge executions abort immediately (spec §5.5a). The caller
 * must dispose the subscription when the work finishes.
 */
export function killSwitchSignal(): KillSwitchSubscription {
  const controller = new AbortController();
  if (globalGateState.killSwitch) controller.abort();
  const listener = (): void => controller.abort();
  killSwitchListeners.add(listener);
  const dispose = (): void => {
    killSwitchListeners.delete(listener);
  };
  controller.signal.addEventListener("abort", dispose, { once: true });
  return { signal: controller.signal, dispose };
}

/** Current live subscriptions (observability and leak regression tests). */
export function killSwitchListenerCount(): number {
  return killSwitchListeners.size;
}

export interface GateDeps {
  now?: () => Date;
  /** Overrides the kill-switch state (tests / isolated sessions). */
  state?: GateState;
  limiter?: RateLimiter;
  /** Human approval for destructive actions. Default: deny. */
  approval?: (action: RedAction, authz: AuthorizationRecord | null) => boolean;
  /** Requests consumed so far in the campaign, for the total budget. */
  requestCount?: () => number;
}

const DENY = (reason: string, authzId: string | null): GateDecision => ({ allow: false, reason, authzId });
const ALLOW = (reason: string, authzId: string | null): GateDecision => ({ allow: true, reason, authzId });

/**
 * The single authorization decision point (spec §0.4 gate pseudocode, made
 * total). Order: kill-switch, record presence (localhost fallback), expiry,
 * deny-list, scope, destructive approval, rate limit, request budget, allow.
 */
export function gate(target: string, action: RedAction, authz: AuthorizationRecord | null, deps: GateDeps = {}): GateDecision {
  const state = deps.state ?? globalGateState;
  if (state.killSwitch) return DENY("kill-switch engaged", authz?.id ?? null);

  if (!authz) {
    // Zero-config default posture (spec O-1): loopback read-only only, and
    // destructive actions still need the human approval callback.
    if (isLocalhostTarget(target)) {
      if (!action.destructive) return ALLOW("localhost default posture", null);
      if (deps.approval?.(action, null) ?? false) return ALLOW("destructive action approved", null);
      return DENY("destructive action requires approval", null);
    }
    return DENY("no authorization record", null);
  }

  if (!authorizationActive(authz, deps.now?.() ?? new Date())) return DENY("authorization expired", authz.id);

  const parsed = parseTarget(target);
  const host = parsed?.host ?? target;
  if (authz.scope.denyAlways.some((entry) => hostMatches(entry, host))) return DENY("target on deny-list", authz.id);
  if (!targetInScope(authz.scope, target)) return DENY("target outside authorization scope", authz.id);

  if (action.destructive && !authz.limits.destructiveAllowed) {
    const approved = deps.approval?.(action, authz) ?? false;
    if (!approved) return DENY("destructive action requires approval", authz.id);
    return ALLOW("destructive action approved", authz.id);
  }

  if (deps.limiter && !deps.limiter.tryAcquire()) return DENY("rate limit exceeded", authz.id);

  if (deps.requestCount && deps.requestCount() >= authz.limits.maxTotalRequests) {
    return DENY("request budget reached", authz.id);
  }

  return ALLOW("", authz.id);
}
