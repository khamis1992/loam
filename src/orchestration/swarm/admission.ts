/**
 * C11: deterministic board admission (verify, admit, dedup, render).
 * Clean-room TypeScript written from the OBSERVED behaviour of Agensh
 * board-service/verifier.py and shared_lessons.py. Executes no commands.
 */
import {
  type BoardEntry, type BoardNoteType,
  BOARD_NOTE_TYPES, MAX_BOARD_ENTRIES, MAX_CONTENT_CHARS, MAX_PATCH_SUMMARY_CHARS, CLAIM_OVERLAP_JACCARD,
} from "./types.js";

const VALID_TYPES = BOARD_NOTE_TYPES;

// Placeholder evidence that must be REJECTED on a PATCH_SUMMARY (OBSERVED verifier.py).
const INVALID_EVIDENCE = [
  "tbd", "pending", "not verified", "unverified", "should work", "should pass",
  "looks right", "looks correct", "seems to work", "to be verified", "will verify", "n/a",
];
// Solid evidence regex (OBSERVED shared_lessons.py _PATCH_SUMMARY_SOLID_EVIDENCE_RE).
const SOLID_EVIDENCE =
  /\b(pass(?:ed|es)?|verified|confirmed|no longer|now returns|now produces)\b/i;
const WEAK_EVIDENCE = [
  "pending", "not verified", "unverified", "should", "will verify",
  "to be verified", "tbd", "looks", "seems",
];

export function parsePatchField(content: string, field: string): string | null {
  const prefix = field.toLowerCase() + "=";
  for (const part of String(content ?? "").split("|")) {
    const s = part.trim();
    if (s.toLowerCase().startsWith(prefix)) return s.slice(prefix.length).trim();
  }
  return null;
}

function invalidPatchEvidence(content: string): boolean {
  const ev = parsePatchField(content, "evidence");
  if (ev === null) return true;
  const norm = ev.trim().toLowerCase();
  if (!norm) return true;
  for (const p of INVALID_EVIDENCE) {
    if (norm === p) return true;
    if (norm.startsWith(p)) {
      const tail = norm.slice(p.length);
      if (!tail || !/[a-z]/i.test(tail[0]!)) return true;
    }
  }
  return false;
}

/** Deterministic text gate. Does NOT execute the claimed tests (same as Agensh). */
export function verifyNote(note: { type: string; content: string })
    : { clean: { type: BoardNoteType; content: string } | null; reason: string } {
  const kind = String(note.type ?? "").trim().toUpperCase() as BoardNoteType;
  let content = String(note.content ?? "").trim();
  if (!VALID_TYPES.includes(kind) || !content) return { clean: null, reason: "ok:0/1" };
  const cap = kind === "PATCH_SUMMARY" ? MAX_PATCH_SUMMARY_CHARS : MAX_CONTENT_CHARS;
  content = content.slice(0, cap);
  if (kind === "PATCH_SUMMARY" && invalidPatchEvidence(content))
    return { clean: null, reason: "ok:0/1,ps_invalid_ev=1" };
  return { clean: { type: kind, content }, reason: "ok:1/1" };
}

export function isVerifiedPatchCheckpoint(content: string): boolean {
  const ev = parsePatchField(content, "evidence");
  if (!ev) return false;
  const low = ev.trim().toLowerCase();
  if (!low) return false;
  if (WEAK_EVIDENCE.some((w) => low.includes(w))) return false;
  return SOLID_EVIDENCE.test(ev);
}

export function isExpiredClaim(e: BoardEntry, nowSec: number): boolean {
  if (e.type !== "CLAIM") return false;
  if (e.expires_at == null) return false;
  return nowSec > e.expires_at;
}

/**
 * Admit a newly-verified note into an in-memory entry list, applying:
 *  - PATCH_SUMMARY replacement by (author, work_label),
 *  - FAIL invalidation of the author's latest matching PATCH_SUMMARY,
 *  - verified-checkpoint marking.
 * `entries` is mutated and the admitted/replaced entry is returned.
 * (Clean-room port of shared_lessons.py _admit; OBSERVED.)
 */
export function admit(entries: BoardEntry[], entry: BoardEntry): BoardEntry {
  const label = entry.work_label ?? null;
  const author = entry.thread_id;

  // Loam addition (design decision for UNKNOWN U12): a PATCH_SUMMARY or FAIL by the claim's author on
  // the same work label closes that author's open CLAIM, so finished work frees its scope before the TTL.
  if ((entry.type === "PATCH_SUMMARY" || entry.type === "FAIL") && label !== null) {
    for (const e of entries) {
      if (e.type === "CLAIM" && e.thread_id === author && (e.work_label ?? null) === label && !e.closed_by) e.closed_by = entry.type;
    }
  }

  if (entry.type === "PATCH_SUMMARY" && isVerifiedPatchCheckpoint(entry.content))
    entry.verified_checkpoint = true;

  const failCount = () => entries.filter(
    (e) => e.type === "FAIL" && e.thread_id === author && (e.work_label ?? null) === label).length;

  if (entry.type === "PATCH_SUMMARY") {
    const fc = failCount();
    if (fc) entry.local_failures = fc;
  }

  if (entry.type === "FAIL") {
    const fc = failCount() + 1;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      if (e.type === "PATCH_SUMMARY" && e.thread_id === author && (e.work_label ?? null) === label) {
        e.verified_checkpoint = false;
        e.invalidated_by_fail = entry.content.slice(0, MAX_CONTENT_CHARS);
        e.local_failures = fc;
        break;
      }
    }
  }

  if (entry.type === "PATCH_SUMMARY") {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      if (e.type === "PATCH_SUMMARY" && e.thread_id === author && (e.work_label ?? null) === label) {
        entry.first_ts = e.first_ts ?? e.ts;
        entry.last_ts = entry.ts;
        entries[i] = entry;      // replace recent candidate, keep first ts
        return entry;
      }
    }
  }

  entries.push(entry);
  if (entries.length > MAX_BOARD_ENTRIES) entries.splice(0, entries.length - MAX_BOARD_ENTRIES);
  return entry;
}

/** Conservative dedup for the RENDERED view. Never collapses CLAIM/PATCH_SUMMARY. */
export function dedupeEntries(entries: BoardEntry[]): BoardEntry[] {
  const norm = (s: string) => s.split(/\s+/).join(" ");
  const index = new Map<string, BoardEntry>();
  const out: BoardEntry[] = [];
  for (const e of entries) {
    if (e.type === "CLAIM" || e.type === "PATCH_SUMMARY") continue;
    const key = e.type + "\u0000" + norm(e.content);
    const prior = index.get(key);
    if (prior) {
      prior.dup = (prior.dup ?? 1) + 1;
      prior.last_ts = Math.max(prior.last_ts ?? prior.ts, e.ts);
    } else {
      const ee = { ...e, dup: 1, first_ts: e.ts, last_ts: e.ts };
      index.set(key, ee);
      out.push(ee);
    }
  }
  for (const e of entries) if (e.type === "CLAIM" || e.type === "PATCH_SUMMARY") out.push({ ...e });
  return out;
}

/** Live view: hide expired claims, dedupe, sort by ts, section-render. */
export function renderBoard(entries: BoardEntry[], nowSec: number): string {
  const kept = dedupeEntries(entries).filter((e) => !isExpiredClaim(e, nowSec) && !e.closed_by);
  kept.sort((a, b) => a.ts - b.ts);
  if (!kept.length) return "(no shared lessons yet)";
  const patches = kept.filter((e) => e.type === "PATCH_SUMMARY");
  const claims = kept.filter((e) => e.type === "CLAIM");
  const durable = kept.filter((e) => e.type !== "PATCH_SUMMARY" && e.type !== "CLAIM");
  const line = (e: BoardEntry) => {
    if (e.type === "PATCH_SUMMARY") {
      const st: string[] = [];
      if (e.verified_checkpoint) st.push("verified");
      if (e.invalidated_by_fail) st.push("invalidated");
      if (e.local_failures) st.push(`local_failures=${e.local_failures}`);
      return `[${e.thread_id}/PATCH_SUMMARY] ${e.content}${st.length ? ` [status=${st.join(",")}]` : ""}`;
    }
    if (e.type === "CLAIM") {
      const left = e.expires_at != null ? `, +${Math.max(0, (e.expires_at - nowSec) / 60).toFixed(1)}m left` : "";
      return `[${e.thread_id}/CLAIM${left}] ${e.content}`;
    }
    const dup = (e.dup ?? 1) > 1 ? ` (x${e.dup})` : "";
    return `[${e.thread_id}/${e.type}] ${e.content}${dup}`;
  };
  const parts: string[] = [];
  if (patches.length) { parts.push("[Patch summaries - review before proposing your own]"); patches.forEach((e) => parts.push(line(e))); }
  if (claims.length) { if (parts.length) parts.push(""); parts.push("[Active claims - pick a different angle if yours duplicates these]"); claims.forEach((e) => parts.push(line(e))); }
  if (durable.length) { if (parts.length) parts.push(""); parts.push("[Shared lessons]"); durable.forEach((e) => parts.push(line(e))); }
  return parts.join("\n");
}

/** Work labels are short slugs: lower case, [a-z0-9-], at most 48 chars. Empty when nothing usable remains. */
export function normalizeWorkLabel(label: string | undefined | null): string {
  return String(label ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

function words(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9\u0600-\u06ff]+/).filter((w) => w.length > 1));
}

/** Jaccard similarity of two word sets (0 when both are empty). */
export function jaccard(a: string, b: string): number {
  const A = words(a), B = words(b);
  if (!A.size && !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Overlap rule for the CLAIM notice (4.5): same normalized work label, or content Jaccard >= 0.6,
 * among non-expired CLAIMs of OTHER workers. Claims never hard-lock; the writer is only told.
 */
export function findOverlappingClaim(entries: readonly BoardEntry[], claim: { thread_id: string; work_label?: string; content: string }, nowSec: number): BoardEntry | null {
  const label = normalizeWorkLabel(claim.work_label);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.type !== "CLAIM" || e.thread_id === claim.thread_id || e.closed_by || isExpiredClaim(e, nowSec)) continue;
    if (label && normalizeWorkLabel(e.work_label) === label) return e;
    if (jaccard(e.content, claim.content) >= CLAIM_OVERLAP_JACCARD) return e;
  }
  return null;
}

/** A CLAIM that still holds scope: not expired and not closed by its author's PATCH_SUMMARY or FAIL. */
export function isOpenClaim(e: BoardEntry, nowSec: number): boolean {
  return e.type === "CLAIM" && !e.closed_by && !isExpiredClaim(e, nowSec);
}
