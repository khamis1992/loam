import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { safeGet, validatePentestTarget } from "../tools/pentest.js";

export interface CampaignScope {
  seeds: string[]; exclusions: string[]; maxPages: number; maxRequests: number;
  delayMs: number; maxDepth: number; timeoutSeconds: number;
}
export interface RequestEvidence {
  id: string; at: string; url: string; method: string; authenticated: boolean;
  status: number; durationMs: number; bodyHash: string; bytes: number;
  contentType: string; error?: string;
  engine?: "http" | "browser";
  requestBytes?: number; postPolicy?: string;
  accountId?: string;
  apiOrigin?: string;
  bodyTruncated?: boolean;
  bodyOmitted?: boolean;
  corsAllowed?: boolean;
    corsCredentials?: 'omit'|'include';
    corsRequestHeaders?: string[];
}
export type HttpResult = Awaited<ReturnType<typeof safeGet>>;
export class ScopeError extends Error {}
export class BudgetError extends Error {}
export function normalizeScope(target: string, value: unknown): CampaignScope {
  if(value!==undefined&&value!==null&&(typeof value!=="object"||Array.isArray(value)))throw new ScopeError("Scope must be an object");
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const n = raw[key] ?? fallback;
    if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw new ScopeError(`${key} must be ${min}–${max}`);
    return n;
  };
  const seeds = raw.seeds === undefined ? (target ? [target] : []) : raw.seeds;
  if (!Array.isArray(seeds) || seeds.length > 10 || seeds.some(s => typeof s !== "string")) throw new ScopeError("Scope requires up to 10 exact seed URLs");
  const normalized = [...new Set((target ? [target, ...seeds] : seeds).map(s => validatePentestTarget(s)))];
  if (normalized.length > 10) throw new ScopeError("At most 10 scope seeds");
  const exclusions = raw.exclusions ?? [];
  if (!Array.isArray(exclusions) || exclusions.length > 30 || exclusions.some(s => typeof s !== "string" || !s.startsWith("/") || s.length > 200 || /[?#\\%]/.test(s))) throw new ScopeError("Exclusions must be literal absolute URL paths");
  return { seeds: normalized, exclusions: exclusions as string[], maxPages: integer("maxPages", 20, 1, 100), maxRequests: integer("maxRequests", 200, 10, 10000), delayMs: integer("delayMs", 200, 0, 5000), maxDepth: integer("maxDepth", 2, 0, 5), timeoutSeconds: integer("timeoutSeconds", 180, 10, 900) };
}
const pathUnder = (pathname: string, prefix: string) => prefix === "/" || pathname === prefix.replace(/\/+$/, "") || pathname.startsWith(prefix.replace(/\/+$/, "") + "/");
export function inScope(scope: CampaignScope, input: string): boolean {
  try {
    if(/[\\%]/.test(input))return false;
    const url = new URL(input);
    if (url.search || url.hash || url.username || url.password || /%|\\/.test(url.pathname)) return false;
    const excluded = scope.exclusions.some(prefix => pathUnder(url.pathname, prefix));
    // GET endpoints with action-like names can mutate server state; do not discover or invoke them.
    if (excluded || /(?:^|\/)(?:logout|signout|delete|remove|destroy|reset|unsubscribe)(?:\/|$)/i.test(url.pathname)) return false;
    return scope.seeds.some(seed => { const s = new URL(seed); return url.origin === s.origin && pathUnder(url.pathname, s.pathname); });
  } catch { return false; }
}
export function normalizeAuth(input: unknown, scope: CampaignScope): Record<string, string> {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new ScopeError("Invalid authentication configuration");
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some(k => !["bearer", "cookie"].includes(k))) throw new ScopeError("Only bearer or cookie authentication is supported");
  const headers: Record<string, string> = {};
  for (const key of ["bearer", "cookie"] as const) {
    const value = raw[key]; if (value === undefined || value === "") continue;
    if (typeof value !== "string" || value.length > 8192 || /[\r\n\x00-\x1f\x7f]/.test(value)) throw new ScopeError("Invalid authentication value");
    headers[key === "bearer" ? "Authorization" : "Cookie"] = key === "bearer" ? `Bearer ${value}` : value;
  }
  if (Object.keys(headers).length && new Set(scope.seeds.map(s => new URL(s).origin)).size !== 1) throw new ScopeError("Authenticated campaigns must use one origin to contain credentials");
  return headers;
}
export function scopedTransport(scope: CampaignScope, signal: AbortSignal, auth: Record<string, string>, evidence: RequestEvidence[]) {
  let count = 0, lastRequest = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const reserve = () => {
    const next=queue.then(async()=>{
      signal.throwIfAborted();
      if(count>=scope.maxRequests)throw new BudgetError("Request budget reached");
      await delay(Math.max(0,scope.delayMs-(Date.now()-lastRequest)),undefined,{signal});
      signal.throwIfAborted();count++;lastRequest=Date.now();
      return {id:`R${count}`,at:lastRequest};
    });
    queue=next.catch(()=>{});return next;
  };
  const secrets = Object.values(auth).flatMap(v => [v, v.replace(/^Bearer /, "")]);
  if(auth.Cookie)secrets.push(...auth.Cookie.split(";").map(c=>c.slice(c.indexOf("=")+1).trim()).filter(Boolean));
  const redact = (value: string) => secrets.reduce((s, secret) => secret ? s.split(secret).join("[REDACTED]") : s, value);
  const request = async (input: string, options: Parameters<typeof safeGet>[1] = {}, anonymous = false): Promise<HttpResult> => {
    signal.throwIfAborted();
    if (!inScope(scope, input)) throw new ScopeError("Request outside approved scope");
    const method = options.method ?? "GET";
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) throw new ScopeError("Unsupported request method");
    const ticket=await reserve();
    const result = await safeGet(input, { ...options, signal, headers: { ...(anonymous ? {} : auth), ...options.headers } });
    const item: RequestEvidence = { id: ticket.id, at: new Date(ticket.at).toISOString(), url: input, method, authenticated: !anonymous && !!Object.keys(auth).length, status: result.status, durationMs: Date.now() - ticket.at, bodyHash: createHash("sha256").update(result.body).digest("hex"), bytes: Buffer.byteLength(result.body), contentType: redact(result.headers["content-type"]?.split(";")[0] ?? ""),engine:"http" };
    if (!result.ok) item.error = redact(result.error ?? "Request failed");
    if(result.bodyTruncated)item.bodyTruncated=true;
    if(result.bodyOmitted){item.bodyOmitted=true;item.bodyHash='';}
    evidence.push(item);
    // Keep authentication in memory only; suppress any echoed credential from downstream evidence.
    return { ...result, body: redact(result.body), headers: Object.fromEntries(Object.entries(result.headers).map(([k,v]) => [k,redact(v)])), setCookie: result.setCookie.map(redact) };
  };
  return { request, redact, reserve, get count() { return count; } };
}
