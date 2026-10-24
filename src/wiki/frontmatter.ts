import type { Page, PageMeta } from "./types.js";
import { assertValidId, assertValidKind } from "./paths.js";

/**
 * Pages are markdown with a `---` header of `key: <json>` lines. Every value is
 * JSON, so titles with colons or newlines round-trip without a YAML dependency.
 */
const KEYS: Array<keyof PageMeta> = [
  "id", "kind", "title", "created", "updated", "tags", "supersedes", "supersededBy", "sessionId",
];

export function serializePage(page: Page): string {
  const lines = ["---"];
  for (const key of KEYS) {
    const value = page.meta[key];
    if (value === undefined) continue;
    lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push("---", "", page.body.replace(/\s+$/, ""), "");
  return lines.join("\n");
}

export function parsePage(text: string): Page {
  const norm = text.replace(/\r\n/g, "\n");
  if (!norm.startsWith("---\n")) throw new Error("wiki page has no header");
  const end = norm.indexOf("\n---", 4);
  if (end < 0) throw new Error("wiki page header is not closed");
  const raw: Record<string, unknown> = {};
  for (const line of norm.slice(4, end).split("\n")) {
    const at = line.indexOf(": ");
    if (at < 0) continue;
    const key = line.slice(0, at);
    if (!(KEYS as string[]).includes(key)) continue;
    try { raw[key] = JSON.parse(line.slice(at + 2)); } catch { /* skip an unreadable field */ }
  }
  const str = (k: string): string => (typeof raw[k] === "string" ? (raw[k] as string) : "");
  const meta: PageMeta = {
    id: assertValidId(str("id")),
    kind: assertValidKind(str("kind")),
    title: str("title"),
    created: str("created"),
    updated: str("updated"),
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string") : [],
  };
  if (str("supersedes")) meta.supersedes = str("supersedes");
  if (str("supersededBy")) meta.supersededBy = str("supersededBy");
  if (str("sessionId")) meta.sessionId = str("sessionId");
  return { meta, body: norm.slice(end + 4).replace(/^\n+/, "").replace(/\s+$/, "") };
}
