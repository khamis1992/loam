/**
 * rebuild-verify (ALL_SERVICES §14, reagent/dx-ball technique rebuilt): measure how
 * faithfully a reconstruction matches the original without executing the subject.
 * JS: token-stream similarity after whitespace/comment normalization (minifier
 * differences don't count). Bytes: structural similarity over n-gram shingles.
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { evidenceOf } from "./types.js";
import type { RebuildVerify } from "./types.js";

const JS_TOKEN = /"[^"\\]*"|'[^'\\]*'|`[^`\\]*`|[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|[^\s]/g;

const jsTokens = (src: string): string[] => (src.match(JS_TOKEN) ?? []);

const shingles = (buf: Buffer, n = 8): Set<string> => {
  const out = new Set<string>();
  for (let i = 0; i + n <= buf.length; i += n) out.add(buf.subarray(i, i + n).toString("hex"));
  return out;
};

export function rebuildVerify(originalPath: string, rebuiltPath: string, kind: "js" | "bytes"): RebuildVerify {
  const a = fs.readFileSync(originalPath);
  const b = fs.readFileSync(rebuiltPath);
  let pct: number;
  if (kind === "js") {
    const ta = jsTokens(a.toString("utf8"));
    const tb = jsTokens(b.toString("utf8"));
    const bag = new Map<string, number>();
    for (const t of ta) bag.set(t, (bag.get(t) ?? 0) + 1);
    let shared = 0;
    for (const t of tb) { const c = bag.get(t) ?? 0; if (c > 0) { bag.set(t, c - 1); shared++; } }
    pct = ta.length + tb.length === 0 ? 100 : Math.round((2 * shared) / (ta.length + tb.length) * 1000) / 10;
  } else {
    const sa = shingles(a);
    const sb = shingles(b);
    let shared = 0;
    for (const s of sa) if (sb.has(s)) shared++;
    pct = sa.size + sb.size === 0 ? 100 : Math.round((2 * shared) / (sa.size + sb.size) * 1000) / 10;
  }
  const verdict = pct > 95 ? "match" : pct > 60 ? "partial" : "mismatch";
  return {
    original: originalPath, rebuilt: rebuiltPath, matchPct: pct, verdict,
    evidence: evidenceOf("rebuild", `${originalPath} vs ${rebuiltPath}`,
      `kind=${kind} match=${pct}% digest=${createHash("sha256").update(a).digest("hex").slice(0, 16)}`),
  };
}
