/**
 * Triage of Jazzer.js output into ReconHits. Findings print to stderr in
 * `==<pid>==` blocks whose first line is the detector title; crash artifacts
 * are named `crash-<sha1>`. Harness defects are separated from target findings
 * so they never enter the ledger.
 */
import { isFuzzHarnessArtifact } from "../../audit/fpFilter.js";
import type { ReconHit, Score } from "../../audit/types.js";

export type FuzzKind =
  | "command-injection" | "path-traversal" | "prototype-pollution"
  | "remote-code-execution" | "ssrf" | "crash" | "unknown";

export interface FuzzFinding { kind: FuzzKind; title: string; detail: string; raw: string }

/** Detector first lines as jazzer.js prints them (bug-detectors/internal/*); a V8 stack header may prefix the title. */
const DETECTORS: { match: RegExp; kind: FuzzKind }[] = [
  { match: /^(?:[A-Za-z_$]*Error: )?Command Injection\b/m, kind: "command-injection" },
  { match: /^(?:[A-Za-z_$]*Error: )?Path Traversal\b/m, kind: "path-traversal" },
  { match: /^(?:[A-Za-z_$]*Error: )?Prototype Pollution\b/m, kind: "prototype-pollution" },
  { match: /^(?:[A-Za-z_$]*Error: )?Remote Code Execution\b/m, kind: "remote-code-execution" },
  { match: /^(?:[A-Za-z_$]*Error: )?Server Side Request Forgery \(SSRF\)\b/m, kind: "ssrf" },
];;

export function parseJazzerStderr(stderr: string): FuzzFinding[] {
  const out: FuzzFinding[] = [];
  for (const block of stderr.split(/(?===\d+==)/)) {
    const raw = block.trim();
    if (!raw.startsWith("==")) continue;
    const body = raw.replace(/^==\d+==\s*/, "");
    if (!body) continue;
    const detector = DETECTORS.find((d) => d.match.test(body));
    if (detector) {
      const nl = body.indexOf("\n");
      out.push({
        kind: detector.kind,
        title: (nl === -1 ? body : body.slice(0, nl)).trim(),
        detail: nl === -1 ? "" : body.slice(nl + 1).trim().slice(0, 500),
        raw: body.slice(0, 1000),
      });
    } else if (/^Uncaught Exception:/.test(body)) {
      out.push({ kind: "crash", title: "Uncaught exception under fuzzing", detail: body.slice(0, 500), raw: body.slice(0, 1000) });
    } else {
      out.push({ kind: "unknown", title: body.split(/\r?\n/)[0]!.slice(0, 120), detail: "", raw: body.slice(0, 1000) });
    }
  }
  return out;
}

/** libFuzzer writes `Test unit written to <prefix>crash-<sha1>` on stdout. */
export function parseCrashArtifacts(stdout: string): string[] {
  return [...stdout.matchAll(/crash-([0-9a-f]{16,64})/g)].map((m) => m[1]!);
}

export interface TriageResult { kept: FuzzFinding[]; dropped: { title: string; reason: string }[] }

/** Harness defects (bugs in the fuzz driver itself) are dropped, not reported. */
export function triage(findings: FuzzFinding[]): TriageResult {
  const kept: FuzzFinding[] = [];
  const dropped: TriageResult["dropped"] = [];
  for (const f of findings) {
    if (isFuzzHarnessArtifact(`${f.title}\n${f.detail}`)) dropped.push({ title: f.title, reason: "fuzz-harness artifact" });
    else kept.push(f);
  }
  return { kept, dropped };
}

const KIND_MAP: Record<FuzzKind, { cls: string; severity: Score }> = {
  "command-injection": { cls: "injection", severity: "high" },
  "path-traversal": { cls: "resource-file", severity: "high" },
  "prototype-pollution": { cls: "injection", severity: "high" },
  "remote-code-execution": { cls: "injection", severity: "critical" },
  ssrf: { cls: "feature-abuse", severity: "high" },
  crash: { cls: "wildcard", severity: "medium" },
  unknown: { cls: "wildcard", severity: "medium" },
};

export function toHits(findings: FuzzFinding[], opts: { entry: string; crashHash?: string }): ReconHit[] {
  return findings.map((f) => ({
    tool: "jazzer" as const,
    ruleId: `jazzer/${f.kind}`,
    message: `${f.title}${f.detail ? ` — ${f.detail.split(/\r?\n/)[0]!.slice(0, 200)}` : ""}`,
    file: opts.entry,
    line: 1,
    cls: KIND_MAP[f.kind].cls,
    severity: KIND_MAP[f.kind].severity,
    deterministic: true,
    raw: { kind: f.kind, title: f.title, crashHash: opts.crashHash ?? null },
  }));
}

/** One pass: parse both streams, drop harness artifacts, return hits and the drop log. */
export function triageJazzerRun(opts: {
  entry: string; stdout: string; stderr: string;
}): { hits: ReconHit[]; dropped: { title: string; reason: string }[]; crashHashes: string[] } {
  const artifacts = parseCrashArtifacts(opts.stdout);
  const { kept, dropped } = triage(parseJazzerStderr(opts.stderr));
  return { hits: toHits(kept, { entry: opts.entry, crashHash: artifacts[0] }), dropped, crashHashes: artifacts };
}
