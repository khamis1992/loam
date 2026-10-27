export type EnterpriseRole = "client" | "analyst" | "reviewer" | "approver" | "admin";
export type Permission = "engagement:read" | "engagement:create" | "engagement:execute" | "finding:review" | "engagement:approve" | "report:read" | "kill:engage" | "kill:reset" | "admin:write";

export interface EnterpriseIdentity {
  id: string;
  tenantIds: string[];
  roles: EnterpriseRole[];
  authMethod: "oidc" | "saml-gateway" | "local";
}

const rolePermissions: Record<EnterpriseRole, readonly Permission[]> = {
  client: ["engagement:read", "report:read"],
  analyst: ["engagement:read", "engagement:create", "engagement:execute", "report:read", "kill:engage"],
  reviewer: ["engagement:read", "finding:review", "report:read", "kill:engage"],
  approver: ["engagement:read", "engagement:approve", "report:read", "kill:engage"],
  admin: ["engagement:read", "engagement:create", "engagement:execute", "finding:review", "engagement:approve", "report:read", "kill:engage", "kill:reset", "admin:write"],
};

export function hasPermission(identity: EnterpriseIdentity, tenantId: string, permission: Permission): boolean {
  return identity.tenantIds.includes(tenantId) && identity.roles.some((role) => rolePermissions[role].includes(permission));
}

export function requirePermission(identity: EnterpriseIdentity, tenantId: string, permission: Permission): void {
  if (!identity.id || !identity.tenantIds.length) throw new Error("authenticated tenant identity required");
  if (!hasPermission(identity, tenantId, permission)) throw new Error(`permission denied: ${permission}`);
}

export function requireDistinctActors(requesterId: string, actorIds: string[], minimum: number): void {
  if (actorIds.length < minimum || new Set(actorIds).size !== actorIds.length || actorIds.includes(requesterId)) throw new Error("independent approval requirements not met");
}

export function localEnterpriseIdentity(): EnterpriseIdentity {
  return { id: "khamis", tenantIds: ["local"], roles: ["admin"], authMethod: "local" };
}
