/** Connector registry: the OAuth connectors Loam ships today plus the
 *  tool-visibility mapping used when composing agent-run allowlists. */
import { isConnected } from "./oauth.js";
import { githubConnector } from "./providers/github.js";
import { gmailConnector, calendarConnector } from "./providers/google.js";
import type { ConnectorDef } from "./oauth.js";

export const CONNECTORS: ConnectorDef[] = [githubConnector, gmailConnector, calendarConnector];

export function findConnector(id: string): ConnectorDef | undefined {
  return CONNECTORS.find((c) => c.id === id);
}

/** Connector id -> agent tool names that exist only while that connector is connected. */
export const CONNECTOR_TOOLS: Record<string, string[]> = {
  github: ["github_list_repos", "github_list_issues", "github_create_issue"],
  gmail: ["gmail_search", "gmail_read", "gmail_create_draft"],
  calendar: ["calendar_list_events", "calendar_create_event"],
};

export const ALL_CONNECTOR_TOOL_NAMES: string[] = Object.values(CONNECTOR_TOOLS).flat();

import type { ConnectorGrant, ConnectorPermission } from "../agents.js";

const TOOL_PERMISSIONS: Record<string, ConnectorPermission> = {
  github_list_repos: "read",
  github_list_issues: "read",
  github_create_issue: "write",
  gmail_search: "read",
  gmail_read: "read",
  gmail_create_draft: "write",
  calendar_list_events: "read",
  calendar_create_event: "write",
};

/** Resolve connected tools against per-agent grants. Undefined grants retain
 *  legacy access; an empty list explicitly revokes every connector. */
export function connectedConnectorToolNames(disabledTools?: string[], grants?: ConnectorGrant[]): string[] {
  const disabled = new Set(disabledTools ?? []);
  return CONNECTORS.filter((c) => isConnected(c.id)).flatMap((connector) => {
    const connectorGrants = grants?.filter((grant) => grant.connectorId === connector.id);
    if (grants !== undefined && connectorGrants!.length === 0) return [];
    const allowed = grants === undefined
      ? null
      : new Set(connectorGrants!.flatMap((grant) => grant.permissions));
    return (CONNECTOR_TOOLS[connector.id] ?? []).filter((name) => {
      if (disabled.has(name)) return false;
      return allowed === null || allowed.has(TOOL_PERMISSIONS[name] ?? "read");
    });
  });
}
