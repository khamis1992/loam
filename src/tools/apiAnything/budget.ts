type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

interface Target {
  holder: Json[] | { [k: string]: Json };
  key: number | string;
  size: number;
}

/** The largest array (≥ 2 items) or string (> 64 chars) below `box`, by serialized size. */
function largest(box: { [k: string]: Json }): Target | undefined {
  let best: Target | undefined;
  const visit = (v: Json, holder: Json[] | { [k: string]: Json }, key: number | string): void => {
    if (typeof v === "string") {
      if (v.length > 64 && (!best || v.length > best.size)) best = { holder, key, size: v.length };
      return;
    }
    if (Array.isArray(v)) {
      if (v.length >= 2) {
        const size = JSON.stringify(v).length;
        if (!best || size > best.size) best = { holder, key, size };
      }
      v.forEach((item, i) => visit(item, v, i));
      return;
    }
    if (v && typeof v === "object") for (const [k, item] of Object.entries(v)) visit(item, v, k);
  };
  visit(box.root as Json, box, "root");
  return best;
}

function read(t: Target): Json {
  return Array.isArray(t.holder) ? (t.holder[t.key as number] as Json) : (t.holder[t.key as string] as Json);
}
function write(t: Target, v: Json): void {
  if (Array.isArray(t.holder)) t.holder[t.key as number] = v;
  else t.holder[t.key as string] = v;
}

function annotate(v: Json, omittedItems: number, cutStrings: number): Json {
  const note = { truncated: true, omittedItems, cutStrings };
  return v && typeof v === "object" && !Array.isArray(v) ? { ...v, ...note } : { data: v, ...note };
}

/**
 * Serialize `value` to JSON of at most `max` characters. Halves the largest array or string
 * until it fits, so the result is always valid JSON (Loam's registry would otherwise cut
 * text mid-structure at 16,000 characters). Deterministic.
 */
export function fitJson(value: unknown, max: number): string {
  const first = JSON.stringify(value);
  if (first === undefined) return JSON.stringify({ ok: false, class: "error", reason: "empty result" });
  if (first.length <= max) return first;
  const box: { [k: string]: Json } = { root: JSON.parse(first) as Json };
  let omittedItems = 0;
  let cutStrings = 0;
  for (let i = 0; i < 64; i++) {
    const out = JSON.stringify(annotate(box.root as Json, omittedItems, cutStrings));
    if (out.length <= max) return out;
    const t = largest(box);
    if (!t) break;
    const v = read(t);
    if (Array.isArray(v)) {
      const keep = Math.ceil(v.length / 2);
      omittedItems += v.length - keep;
      write(t, v.slice(0, keep));
    } else if (typeof v === "string") {
      cutStrings++;
      write(t, `${v.slice(0, Math.floor(v.length / 2))}…`);
    } else break;
  }
  const original = (value && typeof value === "object" ? value : {}) as { ok?: unknown; class?: unknown };
  return JSON.stringify({
    ok: original.ok === true,
    class: typeof original.class === "string" ? original.class : "error",
    truncated: true,
    reason: `the result is larger than ${max} characters even after trimming`,
    next: "narrow the request (a more specific query or fewer results)",
  });
}
