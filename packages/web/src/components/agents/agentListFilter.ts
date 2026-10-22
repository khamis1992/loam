import type { AgentCardAgent } from './AgentCard';

/** Agent row shape used by the sidebar search + hide logic. */
export interface SidebarAgent extends AgentCardAgent {
  /** Soft-hide timestamp: set puts the agent in the collapsible "Hidden" section. */
  hiddenAt?: string;
}

/**
 * Combining marks stripped when folding a name: Latin diacritics plus the
 * Arabic harakat/tashkeel (fathatan..waqf) and superscript alef, so searching
 * an unvocalised Arabic query still matches a fully vocalised agent name.
 */
const COMBINING_MARKS = /[\u0300-\u036f\u064b-\u065f\u0670\u06d6-\u06ed]/g;

/**
 * Case/diacritic-insensitive form of a name ("Café Zoé" -> "cafe zoe",
 * "مُحَمَّد" -> "محمد"), used so searching "cafe" or "محمد" matches accented
 * or vocalised agent names.
 */
export function foldName(value: string): string {
  return value
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase();
}

/** Name (and description, matching the pre-search sidebar behavior) match test. */
export function matchesSearch<T extends SidebarAgent>(agent: T, search: string): boolean {
  const query = foldName(search.trim());
  if (!query) return true;
  return (
    foldName(agent.name).includes(query) ||
    (agent.description ? foldName(agent.description).includes(query) : false)
  );
}

export function searchAgents<T extends SidebarAgent>(agents: T[], search: string): T[] {
  if (!foldName(search.trim())) return [...agents];
  return agents.filter((agent) => matchesSearch(agent, search));
}

/** Split a filtered list into visible agents and soft-hidden agents (hiddenAt). */
export function splitHidden<T extends SidebarAgent>(agents: T[]): { visible: T[]; hidden: T[] } {
  const visible: T[] = [];
  const hidden: T[] = [];
  for (const agent of agents) {
    if (agent.hiddenAt) hidden.push(agent);
    else visible.push(agent);
  }
  return { visible, hidden };
}

/**
 * Section-header unread badge sum; returns 0 (stub) when no unread source exists.
 */
export function sumUnread(
  ids: string[],
  unreadById?: Record<string, { count?: number }>,
): number {
  if (!unreadById) return 0;
  return ids.reduce((sum, id) => sum + (unreadById[id]?.count ?? 0), 0);
}
