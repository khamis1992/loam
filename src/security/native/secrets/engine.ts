/**
 * Secret detection core. Keyword prefilter (Aho-Corasick), regex, entropy on the extracted secret only,
 * allowlists, redaction, same-line dedupe of generic hits and a stable fingerprint.
 */
import { DEFAULT_RULES } from "./rules.js";
import type { SecretRule } from "./rules.js";

export interface SecretFinding {
  ruleId: string;
  description: string;
  severity: SecretRule["severity"];
  file: string;
  line: number;
  /** Redacted secret, never the raw value. */
  secret: string;
  entropy: number;
  commit?: string;
  fingerprint: string;
}

export interface ScanOptions {
  /** Share of the secret to hide, 0..100. Default 100 shows "REDACTED". */
  redactPercent?: number;
  /** Fingerprints to drop (a .gitleaksignore-style baseline). */
  ignore?: ReadonlySet<string>;
  rules?: SecretRule[];
  commit?: string;
  /** Global allowlist (the vendored gitleaks [allowlist]): files, secret regexes, stopwords. */
  globalAllow?: { paths?: string[]; regexes?: string[]; stopwords?: string[] };
}

export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  const n = [...s].length;
  for (const c of counts.values()) { const p = c / n; h -= p * Math.log2(p); }
  return h;
}

const roundEven = (x: number): number => {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
};

/** Keep round-to-even(len*(100-N)/100) leading characters, then "...". 100 or more hides it all. */
export function redact(secret: string, percent: number): string {
  if (percent >= 100) return "REDACTED";
  if (percent <= 0) return secret;
  const keep = roundEven(secret.length * (100 - percent) / 100);
  return `${secret.slice(0, keep)}...`;
}

class AhoCorasick {
  private next: Array<Map<string, number>> = [new Map()];
  private fail: number[] = [0];
  private out: Array<Set<number>> = [new Set()];
  constructor(words: string[]) {
    words.forEach((w, id) => {
      let s = 0;
      for (const ch of w) {
        let t = this.next[s]!.get(ch);
        if (t === undefined) {
          t = this.next.length;
          this.next.push(new Map()); this.fail.push(0); this.out.push(new Set());
          this.next[s]!.set(ch, t);
        }
        s = t;
      }
      this.out[s]!.add(id);
    });
    const queue: number[] = [];
    for (const t of this.next[0]!.values()) queue.push(t);
    while (queue.length) {
      const s = queue.shift()!;
      for (const [ch, t] of this.next[s]!) {
        let f = this.fail[s]!;
        while (f !== 0 && !this.next[f]!.has(ch)) f = this.fail[f]!;
        const nf = this.next[f]!.get(ch);
        this.fail[t] = nf !== undefined && nf !== t ? nf : 0;
        for (const o of this.out[this.fail[t]!]!) this.out[t]!.add(o);
        queue.push(t);
      }
    }
  }
  /** Ids of every word present in `text` (already lowercased). */
  find(text: string): Set<number> {
    const found = new Set<number>();
    let s = 0;
    for (const ch of text) {
      while (s !== 0 && !this.next[s]!.has(ch)) s = this.fail[s]!;
      s = this.next[s]!.get(ch) ?? 0;
      for (const o of this.out[s]!) found.add(o);
    }
    return found;
  }
}

interface Compiled {
  rule: SecretRule;
  re: RegExp;
  pathAllow: RegExp[];
  reAllow: { re: RegExp; target: "secret" | "match" | "line" }[];
  pathRe: RegExp | null;
  stop: string[];
  kwIds: number[];
}

const compileRe = (src: string): RegExp => {
  const ci = src.startsWith("(?i)");
  return new RegExp(ci ? src.slice(4) : src, ci ? "gi" : "g");
};

/** Rule regexes are pre-validated; auxiliary regexes (allowlists, paths) compile best-effort and skip on failure. */
const tryRe = (src: string): RegExp | null => {
  try { return compileRe(src); } catch {
    try { return new RegExp(src); } catch { return null; }
  }
};

export class SecretScanner {
  private compiled: Compiled[] = [];
  private ac: AhoCorasick;
  private gPaths: RegExp[] = [];
  private gRegexes: RegExp[] = [];
  private gStop: string[] = [];
  constructor(private readonly opts: ScanOptions = {}) {
    const words: string[] = [];
    for (const rule of opts.rules ?? DEFAULT_RULES) {
      const allowRegexes = rule.allow?.regexes ?? [];
      const c: Compiled = {
        rule, re: compileRe(rule.regex),
        pathAllow: (rule.allow?.paths ?? []).map(tryRe).filter((r): r is RegExp => r !== null),
        reAllow: allowRegexes
          .map((r) => {
            const entry = typeof r === "string" ? { re: r } : r;
            const re = tryRe(entry.re);
            return re ? { re, target: (entry.target ?? "secret") as "secret" | "match" | "line" } : null;
          })
          .filter((x): x is { re: RegExp; target: "secret" | "match" | "line" } => x !== null),
        pathRe: rule.path ? tryRe(rule.path) : null,
        stop: (rule.allow?.stopwords ?? []).map((s) => s.toLowerCase()),
        kwIds: rule.keywords.map((k) => { words.push(k.toLowerCase()); return words.length - 1; }),
      };
      this.compiled.push(c);
    }
    this.ac = new AhoCorasick(words);
    this.gPaths = (opts.globalAllow?.paths ?? []).map(tryRe).filter((r): r is RegExp => r !== null);
    this.gRegexes = (opts.globalAllow?.regexes ?? []).map(tryRe).filter((r): r is RegExp => r !== null);
    this.gStop = (opts.globalAllow?.stopwords ?? []).map((s) => s.toLowerCase());
  }

  scan(text: string, file: string): SecretFinding[] {
    if (!text) return [];
    if (this.gPaths.some((p) => p.test(file))) return [];
    const present = this.ac.find(text.toLowerCase());
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
    const lineAt = (idx: number): number => {
      let lo = 0; let hi = lineStarts.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid]! <= idx) lo = mid; else hi = mid - 1; }
      return lo + 1;
    };
    const lines = text.split("\n");
    const found: SecretFinding[] = [];
    const percent = this.opts.redactPercent ?? 100;
    for (const c of this.compiled) {
      if (c.kwIds.length && !c.kwIds.some((id) => present.has(id))) continue;
      if (c.pathAllow.some((p) => p.test(file))) continue;
      if (c.pathRe && !c.pathRe.test(file)) continue;
      c.re.lastIndex = 0;
      for (let m = c.re.exec(text); m; m = c.re.exec(text)) {
        if (m[0].length === 0) { c.re.lastIndex++; continue; }
        const secret = m[c.rule.secretGroup ?? 0] ?? m[0];
        const line = lineAt(m.index);
        if (/(?:loam|gitleaks):allow/.test(lines[line - 1] ?? "")) continue;
        const ent = shannonEntropy(secret);
        if (c.rule.entropy !== undefined && ent <= c.rule.entropy) continue;
        const low = secret.toLowerCase();
        if (c.stop.some((w) => low.includes(w))) continue;
        if (this.gStop.some((w) => low.includes(w))) continue;
        if (this.gRegexes.some((r) => r.test(secret))) continue;
        if (c.reAllow.some((a) => a.re.test(a.target === "line" ? (lines[line - 1] ?? "") : a.target === "match" ? m[0] : secret))) continue;
        const fingerprint = `${this.opts.commit ?? ""}:${file}:${c.rule.id}:${line}`;
        found.push({
          ruleId: c.rule.id, description: c.rule.description, severity: c.rule.severity, file, line,
          secret: redact(secret, percent), entropy: Math.round(ent * 100) / 100, fingerprint,
          ...(this.opts.commit ? { commit: this.opts.commit } : {}),
        });
      }
    }
    // Ignore after the generic dedupe, so baselining a specific hit does not resurface the generic one on its line.
    return dedupeGeneric(found, new Set(this.compiled.filter((c) => c.rule.generic).map((c) => c.rule.id)))
      .filter((f) => !this.opts.ignore?.has(f.fingerprint));
  }
}

/** A generic hit is dropped when a more specific rule already hit the same line. */
export function dedupeGeneric(f: SecretFinding[], generic: ReadonlySet<string>): SecretFinding[] {
  const specific = new Set(f.filter((x) => !generic.has(x.ruleId)).map((x) => `${x.file}:${x.line}`));
  return f.filter((x) => !generic.has(x.ruleId) || !specific.has(`${x.file}:${x.line}`));
}
