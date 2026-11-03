import { createHash } from "node:crypto";

export function textHash(text: string): string {
  return createHash("sha256").update(text.normalize("NFKC").trim()).digest("hex");
}

/** Drop exact-hash duplicates, keeping the first. */
export function dedupByHash<T extends { text: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const h = textHash(i.text);
    if (seen.has(h)) return false;
    seen.add(h);
    return true;
  });
}
