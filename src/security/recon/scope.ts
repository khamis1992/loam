/**
 * Authorized-scope gate (ALL_SERVICES §10 / §4.2): active network probing is
 * loopback-only by construction, exactly like the pentest orchestrator's
 * assertLocalhost. Non-loopback targets require an explicit ScopeGrant
 * (operator-asserted authorization, never ambient). Enforced BEFORE any
 * request leaves the box; no code path may skip it.
 */
export interface ScopeGrant {
  /** Human-asserted authorization statement, e.g. "I own example.test". */
  authorization: string;
  owner: string;
  grantedAt: string;
  allowHosts: string[];
  expiresAt?: string;
}

export class ScopeError extends Error {
  constructor(readonly target: string) {
    super(`target ${target} is outside the authorized scope: loopback-only unless covered by an explicit grant`);
    this.name = "ScopeError";
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "ip6-localhost", "[::1]"]);

export const isLoopbackHost = (host: string): boolean => {
  const bare = host.replace(/^\[|\]$/g, "");
  if (LOOPBACK_HOSTS.has(bare.toLowerCase())) return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(bare)) return true;
  // IPv6 forms: "::1", "::ffff:127.0.0.1" — judge on the last non-empty segment.
  const segments = bare.split(":").filter((s) => s.length > 0);
  const last = segments[segments.length - 1]!;
  return /^127\.\d+\.\d+\.\d+$/.test(last);
};

const grantCovers = (host: string, grants: ScopeGrant[]): boolean =>
  grants.some((g) => {
    if (g.expiresAt && new Date(g.expiresAt).getTime() < Date.now()) return false;
    return g.allowHosts.some((allowed) => allowed.toLowerCase() === host.toLowerCase());
  });

/** Throws ScopeError unless the URL is loopback or covered by a live grant. */
export function assertAuthorizedScope(rawUrl: string, grants: ScopeGrant[] = []): URL {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new ScopeError(rawUrl); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ScopeError(rawUrl);
  if (url.username || url.password) throw new ScopeError(rawUrl); // credentials never carry scope
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!isLoopbackHost(host) && !grantCovers(host, grants)) throw new ScopeError(`${url.protocol}//${host}`);
  return url;
}

export const activeGrants = (grants: ScopeGrant[]): ScopeGrant[] =>
  grants.filter((g) => !g.expiresAt || new Date(g.expiresAt).getTime() >= Date.now());
