/**
 * Reversible redaction of client data before any (opted-in) cloud call.
 * Matching runs on a 1:1 folded copy (digits to ASCII, hamza/yaa/ta-marbuta
 * folded) so offsets map straight back to the original text. The mapping never
 * leaves the machine; `restore` puts the originals back into a model reply.
 * Credential-shaped strings are removed with Loam's own `stripSecrets`.
 */
import { stripSecrets } from "../memory/redact.js";
import type { MatterParty } from "./types.js";

export type RedactionKind = "party" | "qid" | "phone" | "iban" | "email" | "cr" | "passport";

export interface RedactionEntry { placeholder: string; original: string; kind: RedactionKind }
export interface RedactionResult { text: string; map: RedactionEntry[]; counts: Partial<Record<RedactionKind, number>> }

const FOLD: Record<string, string> = { "أ": "ا", "إ": "ا", "آ": "ا", "ة": "ه", "ى": "ي", "ی": "ي", "ؤ": "و", "ئ": "ي" };

/** One code unit in, one out: safe for offset mapping. */
export function fold1to1(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    const c = ch.charCodeAt(0);
    if (c >= 0x0660 && c <= 0x0669) out += String.fromCharCode(48 + c - 0x0660);
    else if (c >= 0x06f0 && c <= 0x06f9) out += String.fromCharCode(48 + c - 0x06f0);
    else out += FOLD[ch] ?? ch.toLowerCase();
  }
  return out;
}

const PATTERNS: Array<{ kind: RedactionKind; re: RegExp }> = [
  { kind: "iban", re: /\bqa\d{2}[a-z]{4}[a-z0-9]{21}\b/g },
  { kind: "email", re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g },
  { kind: "phone", re: /(?:\+|00)974[\s-]?\d{4}[\s-]?\d{4}\b/g },
  { kind: "qid", re: /(?<!\d)[23]\d{10}(?!\d)/g },
  { kind: "phone", re: /(?<!\d)[34567]\d{3}[\s-]?\d{4}(?!\d)/g },
  { kind: "cr", re: /(?:سجل\s*تجاري\s*(?:رقم)?|c\.?\s*r\.?\s*(?:no\.?)?)\s*[:\-]?\s*\d{3,8}/g },
  { kind: "passport", re: /(?:جواز\s*(?:ال)?سفر\s*(?:رقم)?|passport\s*(?:no\.?)?)\s*[:\-]?\s*[a-z0-9]{6,9}/g },
];

const LABEL_AR: Record<RedactionKind, string> = {
  party: "طرف", qid: "رقم-شخصي", phone: "هاتف", iban: "حساب", email: "بريد", cr: "سجل-تجاري", passport: "جواز",
};

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export function redactForCloud(text: string, parties: MatterParty[]): RedactionResult {
  const base = stripSecrets(text);
  const folded = fold1to1(base);
  const hits: Array<{ start: number; end: number; kind: RedactionKind; key: string }> = [];
  const taken = (a: number, b: number): boolean => hits.some((h) => a < h.end && b > h.start);

  const needles = parties.flatMap((p) => [p.name, ...p.identifiers]).map((n) => n.trim()).filter((n) => n.length >= 3)
    .sort((a, b) => b.length - a.length);
  for (const needle of needles) {
    // Arabic attaches conjunctions/prepositions to the next word ("وشركة", "لشركة", "بشركة"):
    // the prefix stays, the name is replaced.
    const re = new RegExp(`(?<=(?:^|[^\\p{L}\\p{N}])(?:[وفبلك]|لل|وب|ول|وك|فب|فل)?)${escapeRe(fold1to1(needle))}(?![\\p{L}\\p{N}])`, "gu");
    for (const m of folded.matchAll(re)) {
      const start = m.index ?? 0; const end = start + m[0].length;
      if (!taken(start, end)) hits.push({ start, end, kind: "party", key: fold1to1(needle) });
    }
  }
  for (const { kind, re } of PATTERNS) {
    for (const m of folded.matchAll(new RegExp(re.source, re.flags))) {
      const start = m.index ?? 0; const end = start + m[0].length;
      if (!taken(start, end)) hits.push({ start, end, kind, key: m[0] });
    }
  }

  const placeholders = new Map<string, string>();
  const counters: Partial<Record<RedactionKind, number>> = {};
  const map: RedactionEntry[] = [];
  const ordered = [...hits].sort((a, b) => a.start - b.start);
  for (const h of ordered) {
    const id = `${h.kind}:${h.key}`;
    if (!placeholders.has(id)) {
      counters[h.kind] = (counters[h.kind] ?? 0) + 1;
      const placeholder = `[${LABEL_AR[h.kind]}-${counters[h.kind]}]`;
      placeholders.set(id, placeholder);
      map.push({ placeholder, original: base.slice(h.start, h.end), kind: h.kind });
    }
  }
  let out = base;
  for (const h of [...ordered].reverse()) {
    out = out.slice(0, h.start) + (placeholders.get(`${h.kind}:${h.key}`) ?? "[محجوب]") + out.slice(h.end);
  }
  return { text: out, map, counts: counters };
}

export function restore(text: string, map: RedactionEntry[]): string {
  let out = text;
  for (const e of map) out = out.split(e.placeholder).join(e.original);
  return out;
}
