import { OfficeIntelligenceError, type OfficeScope } from "./contracts.js";

export const OFFICE_PERMISSIONS = [
  "office:read",
  "office:write",
  "office:ai",
  "office:approve",
  "office:share",
  "office:connector",
] as const;
export type OfficePermission = (typeof OFFICE_PERMISSIONS)[number];
export type OfficeRole = "partner" | "senior" | "associate" | "paralegal" | "reviewer" | "client" | "admin";

export interface OfficeIdentity {
  id: string;
  tenantIds: string[];
  roles: OfficeRole[];
  projectIds?: string[];
  matterIds?: string[];
  ethicalWallMatterIds?: string[];
}

const rolePermissions: Record<OfficeRole, readonly OfficePermission[]> = {
  partner: ["office:read", "office:write", "office:ai", "office:approve", "office:share", "office:connector"],
  senior: ["office:read", "office:write", "office:ai", "office:approve", "office:share"],
  associate: ["office:read", "office:write", "office:ai"],
  paralegal: ["office:read", "office:ai"],
  reviewer: ["office:read", "office:ai", "office:approve"],
  client: ["office:read"],
  admin: OFFICE_PERMISSIONS,
};

export function localOfficeIdentity(): OfficeIdentity {
  return { id: "local", tenantIds: ["local"], roles: ["admin"] };
}

export function hasOfficePermission(identity: OfficeIdentity, permission: OfficePermission): boolean {
  return identity.roles.some((role) => rolePermissions[role]?.includes(permission));
}

export function canAccessOfficeScope(identity: OfficeIdentity, scope: OfficeScope): boolean {
  if (!identity.id || !identity.tenantIds.includes(scope.tenantId)) return false;
  if (scope.matterId && identity.ethicalWallMatterIds?.includes(scope.matterId)) return false;
  if (scope.projectId && identity.projectIds && !identity.projectIds.includes(scope.projectId)) return false;
  if (scope.matterId && identity.matterIds && !identity.matterIds.includes(scope.matterId)) return false;
  return true;
}

export function requireOfficeAccess(identity: OfficeIdentity, scope: OfficeScope, permission: OfficePermission): void {
  if (!hasOfficePermission(identity, permission)) {
    throw new OfficeIntelligenceError(`permission denied: ${permission}`, 403, "permission_denied");
  }
  if (!canAccessOfficeScope(identity, scope)) {
    throw new OfficeIntelligenceError("access to this office scope is denied", 403, "scope_denied");
  }
  if (scope.tenantId.length === 0) throw new OfficeIntelligenceError("tenant scope is required", 403, "scope_denied");
}

export function assertSameActor(identity: OfficeIdentity, actorId: string): void {
  if (identity.id !== actorId) throw new OfficeIntelligenceError("run actor does not match the authenticated identity", 403, "actor_mismatch");
}
