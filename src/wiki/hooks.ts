/**
 * Glue between the agent run and the project wiki. Both entry points are inert
 * unless `wiki.enabled` is set, and neither may ever fail a run.
 */
import { sessionStartNotice } from "./handoff.js";
import { wikiRoot } from "./paths.js";
import { writeSessionPage } from "./sessionPage.js";

interface WikiCfg {
  workspace: string;
  wiki?: { enabled?: boolean };
}

/** Metadata-only notice about open handoffs, or "" when the wiki is off or empty. */
export function wikiStartNotice(cfg: WikiCfg): string {
  if (cfg.wiki?.enabled !== true) return "";
  try {
    return sessionStartNotice(wikiRoot(cfg.workspace));
  } catch {
    return "";
  }
}

/** Write the session page for a finished task. Returns true when a page was written. */
export function recordWikiSession(cfg: WikiCfg, taskId: string): boolean {
  if (cfg.wiki?.enabled !== true) return false;
  try {
    return writeSessionPage(wikiRoot(cfg.workspace), taskId) !== undefined;
  } catch {
    return false;
  }
}
