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

/** Names of tools whose connector is currently connected. Per-agent tool
 *  denials always win over the connector grant. */
export function connectedConnectorToolNames(disabledTools?: string[]): string[] {
  const disabled = new Set(disabledTools ?? []);
  return CONNECTORS.filter((c) => isConnected(c.id))
    .flatMap((c) => CONNECTOR_TOOLS[c.id] ?? [])
    .filter((name) => !disabled.has(name));
}
