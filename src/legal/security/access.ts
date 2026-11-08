import type http from "node:http";
import { localEnterpriseIdentity, requirePermission, type EnterpriseIdentity, type Permission } from "../../security/enterprise/policy.js";
import type { Matter } from "../types.js";

export interface LegalIdentityProvider {
  tenantId: string;
  verifier: { verify(token: string): Promise<EnterpriseIdentity> };
}

export class LegalAccessError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function legalPermission(method: string, segments: string[]): Permission {
  if (segments[0] === "operations") return "admin:write";
  if (method === "GET") return "engagement:read";
  if (segments[0] === "import" || (segments[0] === "coverage" && method !== "GET")) return "admin:write";
  if (segments[0] === "reviews" && (segments[2] === "approve" || segments[2] === "approve-artifact")) return "engagement:approve";
  if (segments[0] === "reviews") return "finding:review";
  return "engagement:execute";
}

export async function legalActor(req: http.IncomingMessage, provider: LegalIdentityProvider | undefined, method: string, segments: string[]): Promise<EnterpriseIdentity> {
  if (!provider) return localEnterpriseIdentity();
  const authorization = req.headers.authorization;
  const token = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token) throw new LegalAccessError(401, "a signed Legal identity token is required");
  let identity: EnterpriseIdentity;
  try { identity = await provider.verifier.verify(token); } catch { throw new LegalAccessError(401, "invalid or expired Legal identity token"); }
  try { requirePermission(identity, provider.tenantId, legalPermission(method, segments)); } catch { throw new LegalAccessError(403, `permission denied: ${legalPermission(method, segments)}`); }
  return identity;
}

export function reviewerFor(actor: EnterpriseIdentity, body: Record<string, unknown>): { name: string; licenseNo: string } {
  if (actor.authMethod === "oidc" || actor.authMethod === "saml-gateway") {
    if (!actor.name?.trim() || !actor.licenseNo?.trim()) throw new LegalAccessError(403, "the signed identity must include name and Qatar licence claims");
    return { name: actor.name, licenseNo: actor.licenseNo };
  }
  return { name: typeof body.reviewerName === "string" ? body.reviewerName : "", licenseNo: typeof body.licenseNo === "string" ? body.licenseNo : "" };
}

export function assertMatterAccess(matter: Matter, actor: EnterpriseIdentity): void {
  if (actor.roles.includes("admin") || !matter.ownerId || matter.ownerId === actor.id || matter.assignedReviewerIds?.includes(actor.id)) return;
  throw new LegalAccessError(403, "this matter is not assigned to the signed identity");
}
