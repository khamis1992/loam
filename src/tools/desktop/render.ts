/** B2 renderer (§3.5): the exact compact text form measured in Phase 1 —
 *  keep-ref nodes with name/value/states + hidden-children drill hints — plus
 *  the error renderer and the ref-stripped line delta. */
import type { AdErr, AdNode, AdSnapshot } from "./adTypes.js";

export function renderTree(n: AdNode, maxLines = 400, d = 0, lines: string[] = []): string[] {
  if (lines.length > maxLines) return lines;
  const keep = !!(n.ref_id || n.name || n.children_count);
  if (keep) {
    lines.push(
      "  ".repeat(d) +
        n.role +
        (n.name ? ` "${String(n.name).slice(0, 80)}"` : "") +
        (n.value && n.value !== n.name ? ` =${JSON.stringify(String(n.value).slice(0, 60))}` : "") +
        (n.ref_id ? " " + n.ref_id : "") +
        (n.states?.length ? ` [${n.states.join(",")}]` : "") +
        (n.children_count ? ` (+${n.children_count} hidden; drill with root=${n.ref_id || "?"})` : ""),
    );
  }
  for (const c of n.children ?? []) renderTree(c, maxLines, keep ? d + 1 : d, lines);
  return lines;
}

export function renderSnapshot(s: AdSnapshot, maxLines = 400): string {
  const body = renderTree(s.tree, maxLines);
  const cut = body.length > maxLines ? `\n[truncated at ${maxLines} lines; use root=@ref to drill]` : "";
  return `snapshot ${s.snapshot_id} complete=${s.complete}${s.truncated ? " truncated=true" : ""}\n` + body.slice(0, maxLines).join("\n") + cut;
}

export function renderError(e: AdErr["error"]): string {
  return (
    `ERROR ${e.code} delivery=${e.disposition?.delivery} retry=${e.disposition?.retry}: ${e.message}. ${e.suggestion ?? ""}`.trim() +
    "\nRule: retry only if retry=safe; on STALE_REF take a new snapshot."
  );
}

/** Refs change with every snapshot, so compare lines with refs stripped. */
const stripRefs = (l: string) => l.replace(/@[a-z0-9]+:e\d+/gi, "@ref");

export function renderDelta(prev: string[], next: string[], maxLines = 40): string {
  const a = prev.map(stripRefs);
  const b = next.map(stripRefs);
  const setA = new Map<string, number>();
  a.forEach((l) => setA.set(l, (setA.get(l) ?? 0) + 1));
  const setB = new Map<string, number>();
  b.forEach((l) => setB.set(l, (setB.get(l) ?? 0) + 1));
  const out: string[] = [];
  b.forEach((l, i) => {
    const k = setA.get(l) ?? 0;
    if (k > 0) setA.set(l, k - 1);
    else out.push("+ " + next[i]);
  });
  a.forEach((l, i) => {
    const k = setB.get(l) ?? 0;
    if (k > 0) setB.set(l, k - 1);
    else out.push("- " + prev[i]);
  });
  if (out.length === 0) return "unchanged";
  if (out.length > maxLines) return `changed: ${out.length} lines; call computer_snapshot to see it`;
  return out.join("\n");
}
