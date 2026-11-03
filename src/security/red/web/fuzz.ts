/**
 * Fuzz capability (RED_TEAM_BUILD_SPEC §6.5) — ffuf via the red-ffuf bridge,
 * with wordlists sourced from the clean-rebuilt payload corpus (§6.7). Discovery
 * results are low-severity findings plus recon enrichment for the campaign.
 */
import fs from "node:fs";
import path from "node:path";
import type { PentestFinding } from "../../../tools/pentest.js";
import type { Evidence } from "../../orchestrator.js";
import { nextEvidenceId } from "../../orchestrator.js";
import type { RedCapability, RedCapabilityContext, RedHypothesis, RedValidation } from "../orchestrator/redOrchestrator.js";
import { wordlist } from "../payloads/payloads.js";

export interface FfufResult {
  input: string;
  status: number;
  length: number;
  url: string;
}

/** Parse ffuf JSON output: { results: [{ input: { FUZZ }, status, length, url }] }. */
export function parseFfuf(raw: string): FfufResult[] {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return [];
  }
  const results = (doc as { results?: unknown[] }).results;
  if (!Array.isArray(results)) return [];
  const out: FfufResult[] = [];
  for (const r of results) {
    const o = r as { input?: Record<string, unknown>; status?: unknown; length?: unknown; url?: unknown };
    const input = typeof o.input?.FUZZ === "string" ? o.input.FUZZ : "";
    if (!input) continue;
    out.push({ input, status: Number(o.status ?? 0), length: Number(o.length ?? 0), url: String(o.url ?? "") });
  }
  return out;
}

export function fuzzCapability(opts: { wordlistFile?: string } = {}): RedCapability {
  return {
    id: "red.fuzz",
    applicable: (target) => /^https?:/i.test(target),
    hunt: async (target): Promise<RedHypothesis[]> => [
      { id: `HYP-FUZZ-${target.length}`, capability: "red.fuzz", target, claim: "Hidden paths discoverable by content fuzzing", rationale: "ffuf dictionary pass" },
    ],
    validate: async (hyp: RedHypothesis, ctx: RedCapabilityContext): Promise<RedValidation> => {
      const wordlistFile = opts.wordlistFile ?? "red-ffuf-wordlist.txt";
      const base = hyp.target.replace(/\/+$/, "");
      const out = "red-ffuf-out.json";
      const envelope = await ctx.bridge("red-ffuf", "fuzz", {
        url: `${base}/FUZZ`,
        wordlist: wordlistFile,
        threads: 10,
        rate: 10,
        out,
      });
      if (!envelope.ok) {
        return { hypothesisId: hyp.id, status: "inconclusive", claim: hyp.claim, detail: `ffuf unavailable: ${envelope.error?.message ?? "no output"}`, evidence: [] };
      }
      // ffuf writes the JSON results to the -o file (stdout carries only the
      // progress summary), so read the out file from the bridge workspace and
      // fall back to stdout for callers without a workspace.
      let raw = typeof envelope.data === "string" ? envelope.data : `${envelope.text ?? ""}`;
      if (ctx.workspace) {
        try {
          const file = path.join(ctx.workspace, out);
          if (fs.existsSync(file)) raw = fs.readFileSync(file, "utf8");
        } catch {
          /* fall back to stdout text */
        }
      }
      const results = parseFfuf(raw);
      const discovered = results.filter((h) => [200, 301, 302].includes(h.status) && !["/", ""].includes(h.input));
      const authWalls = results.filter((h) => [401, 403].includes(h.status) && !["/", ""].includes(h.input));
      if (!discovered.length) {
        if (authWalls.length) {
          return {
            hypothesisId: hyp.id,
            status: "inconclusive",
            claim: hyp.claim,
            detail: `${authWalls.length} path(s) returned HTTP 401/403; authentication/authorization walls are reachability signals, not proof of hidden content`,
            evidence: [],
          };
        }
        return { hypothesisId: hyp.id, status: "refuted", claim: hyp.claim, detail: "ffuf found no responding hidden paths", evidence: [] };
      }
      const evidence: Evidence[] = discovered.slice(0, 50).map((h) => ({
        id: nextEvidenceId(),
        kind: "poc",
        at: new Date().toISOString(),
        poc: `ffuf -u ${base}/FUZZ (match: ${h.input} -> HTTP ${h.status}, ${h.length} bytes)`,
        observed: `Hidden path /${h.input} responded HTTP ${h.status}`,
      }));
      const finding: Omit<PentestFinding, "id"> = {
        check: "red_fuzz_discovery",
        verdict: "finding",
        severity: "low",
        title: `Hidden content discovered by fuzzing (${discovered.length} path(s))`,
        target: hyp.target,
        detail: discovered.slice(0, 20).map((h) => `/${h.input} -> HTTP ${h.status}`).join("; "),
        remediation: "Remove or protect content that should not be reachable; deny-list common backup/hidden paths.",
      };
      return { hypothesisId: hyp.id, status: "confirmed", claim: hyp.claim, detail: finding.detail, evidence, finding };
    },
  };
}

/** Materialize the dirs wordlist for the bridge (caller writes it to the workspace). */
export function fuzzWordlistLines(): string[] {
  return wordlist("dirs");
}
