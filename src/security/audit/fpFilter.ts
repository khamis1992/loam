/** Tier A false-positive filter: deterministic hard-exclusions, confidence floor, rank-and-keep. */
import type { Confirmed, NeedsValidation } from "./types.js";

export type Candidate = (Confirmed | NeedsValidation) & { primary_file?: string; cls?: string };

export interface TierAOptions {
  /** Candidates below this confidence (0..1) are dropped. */
  fpFloor: number;
  /** Keep at most this many survivors, best first. */
  keepTop: number;
}
export interface Dropped { fingerprint: string; reason: string }
export interface TierAResult { kept: Candidate[]; dropped: Dropped[] }

const MEMORY_SAFE_OK = /\.(c|cc|cpp|cxx|h|hh|hpp|rs)$/i;
const HTML_ONLY = /\.(html?|xhtml)$/i;
const DOS = /\b(denial[- ]of[- ]service|dos\b|rate[- ]limit|resource exhaustion|redos|regex dos)\b/i;
const MEMORY = /\b(buffer overflow|use[- ]after[- ]free|out[- ]of[- ]bounds|heap overflow|stack overflow|double free|memory corruption|null pointer dereference)\b/i;
const SSRF = /\bssrf\b|server[- ]side request forgery/i;
const SECRET = /\b(hard[- ]?coded|leaked|exposed)\b.*\b(secret|api[- ]?key|token|password|credential)s?\b|\bsecret\b.*\b(in (source|code|repo))\b/i;
const FUZZ_ARTIFACT = /\b(fuzz(er|ing)? (harness|driver)|harness (bug|crash)|libfuzzer|assertion in (the )?harness)\b/i;

/** True when text describes a fuzzing-harness defect rather than a target vulnerability. Shared with native/fuzz triage. */
export function isFuzzHarnessArtifact(text: string): boolean {
  return FUZZ_ARTIFACT.test(text);
}

const CONFIDENCE = { low: 0.4, medium: 0.7, high: 0.9 } as const;

export function confidenceOf(c: Candidate): number {
  return c.verdict === "confirmed" ? CONFIDENCE[c.confidence.score] : 0.7;
}

function fileOf(c: Candidate): string {
  return c.primary_file ?? c.trace[0]?.file ?? c.evidence[0]?.file ?? "";
}

/** Reason a candidate is hard-excluded, or null. `handledBySecretScanner` = the scanner already reports secrets. */
export function hardExclusion(c: Candidate, handledBySecretScanner = true): string | null {
  const text = `${c.title}\n${c.description}`;
  const file = fileOf(c);
  if (DOS.test(text)) return "denial-of-service / rate-limit findings are excluded";
  if (MEMORY.test(text) && !MEMORY_SAFE_OK.test(file)) return "memory-safety finding outside C/C++/Rust";
  if (SSRF.test(text) && HTML_ONLY.test(file)) return "SSRF in an HTML-only file";
  if (handledBySecretScanner && (c.cls === "secret" || SECRET.test(text))) return "secret already handled by the scanner";
  if (isFuzzHarnessArtifact(text)) return "fuzz-harness artifact";
  return null;
}

export function tierA(cands: Candidate[], opts: TierAOptions): TierAResult {
  const dropped: Dropped[] = [];
  const survivors: Candidate[] = [];
  for (const c of cands) {
    const ex = hardExclusion(c);
    if (ex) { dropped.push({ fingerprint: c.fingerprint, reason: ex }); continue; }
    if (confidenceOf(c) < opts.fpFloor) {
      dropped.push({ fingerprint: c.fingerprint, reason: `confidence ${confidenceOf(c)} below floor ${opts.fpFloor}` });
      continue;
    }
    survivors.push(c);
  }
  // Stable rank: confirmed before needs_validation, then confidence, then fingerprint for determinism.
  survivors.sort((a, b) =>
    (a.verdict === b.verdict ? 0 : a.verdict === "confirmed" ? -1 : 1) ||
    confidenceOf(b) - confidenceOf(a) || (a.fingerprint < b.fingerprint ? -1 : 1));
  const kept = survivors.slice(0, Math.max(0, opts.keepTop));
  for (const c of survivors.slice(kept.length)) dropped.push({ fingerprint: c.fingerprint, reason: "below the top-ranked slice" });
  return { kept, dropped };
}
