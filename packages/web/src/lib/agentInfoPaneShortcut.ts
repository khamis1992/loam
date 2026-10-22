/**
 * The Cmd/Ctrl+Shift+I keyboard toggle for the agent info pane (Grok Bot parity).
 *
 * Extracted as a pure predicate so the handler in AgentsPageClient and the
 * keyboard-toggle test share one definition.
 */
export interface AgentInfoPaneShortcutEvent {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  key: string;
}

export function isToggleAgentInfoPaneEvent(event: AgentInfoPaneShortcutEvent): boolean {
  return (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'i';
}
