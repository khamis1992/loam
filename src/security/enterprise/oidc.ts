import { createHmac, createPublicKey, createVerify, timingSafeEqual, type JsonWebKeyInput } from "node:crypto";
import type { EnterpriseIdentity, EnterpriseRole } from "./policy.js";

interface OidcOptions {
  issuer: string;
  audience: string;
  fetchFn?: typeof fetch;
  cacheMs?: number;
}

type Jwk = NonNullable<JsonWebKeyInput["key"]> & { kid?: string; alg?: string; use?: string };

const roles = new Set<EnterpriseRole>(["client", "analyst", "reviewer", "approver", "admin"]);
const decode = (part: string): unknown => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
const secureUrl = (value: string): URL => {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !loopback) || !["http:", "https:"].includes(url.protocol)) throw new Error("identity URLs require HTTPS except loopback");
  return url;
};

export class OidcVerifier {
  private jwks?: { at: number; keys: Jwk[] };
  private readonly fetchFn: typeof fetch;
  private readonly cacheMs: number;

  constructor(private readonly options: OidcOptions) {
    secureUrl(options.issuer);
    this.fetchFn = options.fetchFn ?? fetch;
    this.cacheMs = options.cacheMs ?? 300_000;
  }

  private async json(url: string): Promise<unknown> {
    const response = await this.fetchFn(secureUrl(url), { redirect: "error", signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`identity provider returned HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 1_000_000) throw new Error("identity metadata exceeds limit");
    return JSON.parse(text);
  }

  private async keys(): Promise<Jwk[]> {
    if (this.jwks && Date.now() - this.jwks.at < this.cacheMs) return this.jwks.keys;
    const issuer = this.options.issuer.replace(/\/$/, "");
    const discovery = await this.json(`${issuer}/.well-known/openid-configuration`) as { issuer?: unknown; jwks_uri?: unknown };
    if (discovery.issuer !== this.options.issuer || typeof discovery.jwks_uri !== "string") throw new Error("invalid OIDC discovery metadata");
    const document = await this.json(discovery.jwks_uri) as { keys?: unknown };
    if (!Array.isArray(document.keys) || document.keys.length > 100) throw new Error("invalid JWKS document");
    this.jwks = { at: Date.now(), keys: document.keys as Jwk[] };
    return this.jwks.keys;
  }

  async verify(token: string): Promise<EnterpriseIdentity> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("invalid bearer token");
    const header = decode(parts[0]!) as { alg?: unknown; kid?: unknown; typ?: unknown };
    if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("unsupported token algorithm or missing kid");
    const jwk = (await this.keys()).find((key) => key.kid === header.kid && key.kty === "RSA" && (!key.alg || key.alg === "RS256") && (!key.use || key.use === "sig"));
    if (!jwk) throw new Error("token signing key not found");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${parts[0]}.${parts[1]}`);
    if (!verifier.verify(createPublicKey({ key: jwk, format: "jwk" }), parts[2]!, "base64url")) throw new Error("invalid token signature");
    const payload = decode(parts[1]!) as Record<string, unknown>;
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (payload.iss !== this.options.issuer || !audiences.includes(this.options.audience)) throw new Error("token issuer or audience mismatch");
    if (audiences.length > 1 && payload.azp !== this.options.audience) throw new Error("token authorized party mismatch");
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp <= now || (typeof payload.nbf === "number" && payload.nbf > now + 30)) throw new Error("token is expired or not active");
    if (typeof payload.sub !== "string" || !payload.sub) throw new Error("token subject is missing");
    const tenant = payload.tenant_id ?? payload.tid;
    const tenantIds = Array.isArray(tenant) ? tenant.filter((value): value is string => typeof value === "string") : typeof tenant === "string" ? [tenant] : [];
    const granted = Array.isArray(payload.roles) ? payload.roles : [];
    const identityRoles = granted.filter((role): role is EnterpriseRole => typeof role === "string" && roles.has(role as EnterpriseRole));
    if (!tenantIds.length || !identityRoles.length) throw new Error("token has no tenant or recognized role");
    return { id: payload.sub, tenantIds: [...new Set(tenantIds)], roles: [...new Set(identityRoles)], authMethod: "oidc" };
  }
}

export function verifySamlGatewayIdentity(payload: string, signature: string, secret: Buffer): EnterpriseIdentity {
  const expected = createHmac("sha256", secret).update(payload).digest();
  const actual = Buffer.from(signature, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("invalid SAML gateway signature");
  const parsed = JSON.parse(payload) as { id?: unknown; tenantIds?: unknown; roles?: unknown; expiresAt?: unknown };
  if (typeof parsed.id !== "string" || !Array.isArray(parsed.tenantIds) || !Array.isArray(parsed.roles) || typeof parsed.expiresAt !== "string" || Date.parse(parsed.expiresAt) <= Date.now()) throw new Error("invalid or expired gateway identity");
  const identityRoles = parsed.roles.filter((role): role is EnterpriseRole => typeof role === "string" && roles.has(role as EnterpriseRole));
  const tenantIds = parsed.tenantIds.filter((tenant): tenant is string => typeof tenant === "string" && /^[A-Za-z0-9_.@-]+$/.test(tenant));
  if (!tenantIds.length || !identityRoles.length) throw new Error("gateway identity has no valid tenant or role");
  return { id: parsed.id, tenantIds: [...new Set(tenantIds)], roles: [...new Set(identityRoles)], authMethod: "saml-gateway" };
}
