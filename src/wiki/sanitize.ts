import { assertNoSecret, stripSecrets } from "../memory/redact.js";
import type { Page } from "./types.js";

export const MAX_BODY_CHARS = 60_000;
export const MAX_TITLE_CHARS = 160;
const MAX_TAGS = 12;

/**
 * Single write boundary for the wiki: nothing reaches disk, the index, git or an
 * export without passing here. Credentials are removed first, then the result is
 * asserted clean, so a pattern the stripper misses fails closed instead of leaking.
 */
export function sanitizeText(text: string, max = MAX_BODY_CHARS): string {
  const clipped = text.length > max ? `${text.slice(0, max)}\n[truncated]` : text;
  const clean = stripSecrets(clipped).replace(/\0/g, "");
  assertNoSecret(clean);
  return clean;
}

export function sanitizePage(page: Page): Page {
  const title = sanitizeText(page.meta.title.replace(/\s+/g, " ").trim(), MAX_TITLE_CHARS);
  if (!title) throw new Error("wiki page needs a title");
  const tags = [...new Set(page.meta.tags.map((t) => sanitizeText(t.trim().toLowerCase(), 40)).filter(Boolean))].slice(0, MAX_TAGS);
  return { meta: { ...page.meta, title, tags }, body: sanitizeText(page.body) };
}
