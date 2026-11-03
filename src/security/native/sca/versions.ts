/**
 * Generic version ordering, good enough to pick an upgrade target across
 * ecosystems (semver, PEP 440, Maven, Debian epochs and `~`).
 * Port of cve-intel versions.rs (MIT/Apache-2.0, Fazmin/cve-intel).
 */

type Tok = { k: "pre"; rank: number } | { k: "word"; w: string } | { k: "num"; n: string };

/** Pre-release markers rank below everything; `final/ga/release` vanish. */
function word(w: string): Tok | null {
  const lw = w.toLowerCase();
  const rank = lw === "dev" || lw === "snapshot" ? 1
    : lw === "a" || lw === "alpha" ? 2
    : lw === "b" || lw === "beta" ? 3
    : lw === "m" || lw === "milestone" || lw === "pre" || lw === "preview" ? 4
    : lw === "c" || lw === "rc" || lw === "cr" ? 5
    : null;
  if (rank !== null) return { k: "pre", rank };
  if (lw === "final" || lw === "ga" || lw === "release") return null;
  return { k: "word", w: lw };
}

function tokenize(raw: string): { epoch: number; toks: Tok[] } {
  let s = raw.trim();
  if (s.length > 1 && (s[0] === "v" || s[0] === "V") && /\d/.test(s[1]!)) s = s.slice(1);
  let epoch = 0;
  const colon = s.indexOf(":");
  if (colon > 0 && /^\d+$/.test(s.slice(0, colon))) {
    epoch = Number(s.slice(0, colon));
    s = s.slice(colon + 1);
  }
  const toks: Tok[] = [];
  let cur = "";
  const flush = (): void => {
    if (!cur) return;
    if (/\d/.test(cur[0]!)) toks.push({ k: "num", n: cur.replace(/^0+/, "") });
    else {
      const t = word(cur);
      if (t) toks.push(t);
    }
    cur = "";
  };
  for (const c of s) {
    if (/[0-9a-zA-Z]/.test(c)) {
      if (cur && /\d/.test(cur[0]!) !== /\d/.test(c)) flush();
      cur += c;
    } else {
      flush();
      if (c === "~") toks.push({ k: "pre", rank: 0 });
    }
  }
  flush();
  return { epoch, toks };
}

const kindRank = (t: Tok): number => (t.k === "pre" ? 0 : t.k === "word" ? 1 : 2);

function cmpTok(a: Tok, b: Tok): number {
  if (a.k === "num" && b.k === "num") return a.n.length - b.n.length || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0);
  if (a.k === "pre" && b.k === "pre") return a.rank - b.rank;
  if (a.k === "word" && b.k === "word") return a.w < b.w ? -1 : a.w > b.w ? 1 : 0;
  return kindRank(a) - kindRank(b);
}

const isZeroNum = (t: Tok): boolean => t.k === "num" && t.n === "";

/** -1 | 0 | 1. `1.0` == `1.0.0`; `1.0-rc1` < `1.0`; `1.0.post1` > `1.0`. */
export function compare(a: string, b: string): -1 | 0 | 1 {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.epoch !== tb.epoch) return ta.epoch < tb.epoch ? -1 : 1;
  const n = Math.max(ta.toks.length, tb.toks.length);
  for (let i = 0; i < n; i++) {
    const x = ta.toks[i] ?? null;
    const y = tb.toks[i] ?? null;
    if (x && y) {
      const c = cmpTok(x, y);
      if (c !== 0) return c < 0 ? -1 : 1;
    } else if (x && !y) {
      if (isZeroNum(x)) continue;
      return x.k === "pre" ? -1 : 1;
    } else if (!x && y) {
      if (isZeroNum(y)) continue;
      return y.k === "pre" ? 1 : -1;
    }
  }
  return 0;
}

export const gt = (a: string, b: string): boolean => compare(a, b) === 1;

/** Highest of `versions`, if any. */
export function maxOf(versions: string[]): string | null {
  let best: string | null = null;
  for (const v of versions) if (best === null || compare(v, best) === 1) best = v;
  return best;
}

/** Smallest fix strictly above `installed` — the minimal upgrade that resolves this advisory. */
export function smallestFixAbove(fixedEvents: string[], installed: string): string | null {
  const above = fixedEvents.filter((f) => f && compare(f, installed) === 1);
  let best: string | null = null;
  for (const v of above) if (best === null || compare(v, best) === -1) best = v;
  return best;
}
