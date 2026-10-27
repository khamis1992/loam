import { randomBytes } from "node:crypto";
import { allEntities, getEntity, putEntity } from "../../../server/sqliteStore.js";
import { OfficeIntelligenceError } from "../contracts.js";
import { getMatter, type MatterDeadline } from "./matters.js";

const PORTAL_KIND = "office-client-portal-shares";

export interface ClientPortalShare {
  id: string;
  token: string;
  matterId: string;
  tenantId: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
}

export interface ClientPortalView {
  title: string;
  client: string;
  status: string;
  summary: string;
  updatedAt: string;
  deadlines: MatterDeadline[];
  artifacts: string[];
}

export function createClientPortalShare(matterId: string, expiresAt?: string): ClientPortalShare {
  const matter = getMatter(matterId);
  if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) throw new OfficeIntelligenceError("portal expiry must be a future date", 422, "invalid_portal");
  const token = randomBytes(32).toString("base64url");
  const share: ClientPortalShare = {
    id: token,
    token,
    matterId,
    tenantId: matter.tenantId,
    createdAt: new Date().toISOString(),
    ...(expiresAt ? { expiresAt } : {}),
  };
  putEntity(PORTAL_KIND, share);
  return share;
}

export function listClientPortalShares(matterId: string): ClientPortalShare[] {
  getMatter(matterId);
  return allEntities<ClientPortalShare>(PORTAL_KIND).filter((share) => share.matterId === matterId);
}

export function revokeClientPortalShare(token: string): void {
  const share = getEntity<ClientPortalShare>(PORTAL_KIND, token);
  if (!share) throw new OfficeIntelligenceError("portal share not found", 404, "portal_not_found");
  if (!share.revokedAt) {
    const revoked: ClientPortalShare = { ...share, revokedAt: new Date().toISOString() };
    putEntity(PORTAL_KIND, revoked);
  }
}

export function readClientPortal(token: string): ClientPortalView {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new OfficeIntelligenceError("portal share not found", 404, "portal_not_found");
  const share = getEntity<ClientPortalShare>(PORTAL_KIND, token);
  if (!share || share.revokedAt || (share.expiresAt && Date.parse(share.expiresAt) <= Date.now())) throw new OfficeIntelligenceError("portal share is expired or revoked", 404, "portal_not_found");
  const matter = getMatter(share.matterId);
  return {
    title: matter.title,
    client: matter.client,
    status: matter.status,
    summary: matter.summary,
    updatedAt: matter.updatedAt,
    deadlines: matter.deadlines.filter((deadline) => deadline.status === "upcoming"),
    artifacts: matter.artifacts.map((artifact) => artifact.path.replace(/\\/g, "/").split("/").pop() ?? artifact.path).slice(0, 100),
  };
}
