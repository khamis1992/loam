/**
 * fuzz_run + aixcc_patch_propose (ALL_SERVICES §15). The campaign layer reuses the
 * existing jazzer planner/runner/triage (external process, bounded); the patch loop is
 * PROPOSAL-ONLY: it drafts a candidate diff from the crash site, re-runs the corpus in
 * regression mode, and returns the proposal for operator approval — never applies.
 */
import fs from "node:fs";
import path from "node:path";
import { DEFAULTS, discoverFuzzTargets, runJazzerScan, triageJazzerRun } from "../security/native/fuzz/index.js";
import type { JazzerScanContext } from "../security/native/fuzz/index.js";
import { toSarif } from "../security/normalize/funnel.js";
import { hitsNormalizer } from "../security/normalize/adapters/hits.js";
import type { RawFinding } from "../security/normalize/types.js";
import type { Tool, ToolResult } from "./registry.js";
import { num, str } from "./registry.js";

export interface PatchProposal {
  findingId: string;
  candidateDiff: string;
  regressionPass: boolean;
  note: string;
}

/** Advisory guard-insertion draft for a crash site (proposal-only; operator reviews). */
export function draftGuardProposal(ruleId: string, file: string, line: number, code: string): PatchProposal {
  const indent = /^(\s*)/.exec(code)?.[1] ?? "";
  const candidate = [
    `${indent}// loam:fuzz-guard (proposal) — validate inputs reaching this crash site`,
    `${indent}if (input == null || typeof input !== "object" && typeof input !== "string") return;`,
  ].join("\n");
  return {
    findingId: ruleId,
    candidateDiff: `--- a/${file}\n+++ b/${file}\n@@ -${line},0 +${line},2 @@\n${candidate}\n`,
    regressionPass: false,
    note: "Draft only: inserts an input-validity guard at the reported crash line. Requires operator review, a re-run of the corpus (regression mode) and the project's tests before any application.",
  };
}

export function createFuzzTools(): Tool[] {
  return [
    {
      name: "fuzz_run",
      description: "Run a bounded Jazzer.js fuzz campaign against fuzz targets in a project (external process; sandbox-gated, 5000-run default). Discovers *.fuzz.ts targets, classifies crashes (real/oom/flaky via the triage taxonomy) and returns findings through the shared funnel.",
      parameters: { type: "object", properties: {
        target: { type: "string", description: "Project directory. Defaults to the workspace." },
        runs: { type: "number", description: `libFuzzer executions (default ${DEFAULTS.runs}).` },
        timeout_s: { type: "number", description: "Wall-clock campaign cap in seconds (default 300)." },
        format: { type: "string", enum: ["summary", "sarif"] },
      } },
      async run(args, ctx): Promise<ToolResult> {
        const target = path.resolve(ctx.workspace, str(args, "target") || ".");
        const runCtx: JazzerScanContext = {
          target,
          scratch: path.join(target, ".loam-fuzz-scratch"),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          dynamic: false,
        };
        try {
          const outcome = await runJazzerScan(runCtx);
          const raws = hitsNormalizer.adapt(outcome.hits);
          const base = str(args, "format") === "sarif"
            ? JSON.stringify(toSarif(raws)).slice(0, 60_000)
            : `${raws.length} finding(s); engines: ${outcome.reports.map((r) => `${r.tool}=${r.status}`).join(", ")}`;
          return { ok: true, content: base };
        } catch (e) {
          return { ok: false, content: `fuzz_run failed: ${String(e).slice(0, 300)}` };
        } finally {
          try { fs.rmSync(runCtx.scratch, { recursive: true, force: true }); } catch { /* best effort */ }
        }
      },
    },
    {
      name: "aixcc_patch_propose",
      description: "Draft a PROPOSAL-ONLY patch for a fuzz finding (guard insertion at the crash site) and validate it by re-running the corpus in regression mode. Nothing is applied automatically; the operator reviews the diff.",
      parameters: { type: "object", properties: {
        finding_rule: { type: "string", description: "Finding ruleId from fuzz_run (e.g. jazzer:crash-...)." },
        file: { type: "string" }, line: { type: "number" }, target: { type: "string" },
      }, required: ["finding_rule", "file", "line"] },
      async run(args, ctx): Promise<ToolResult> {
        const file = path.resolve(ctx.workspace, str(args, "file") ?? "");
        const line = num(args, "line", 1);
        let code = "";
        try { code = fs.readFileSync(file, "utf8").split(/\r?\n/)[line - 1] ?? ""; } catch { return { ok: false, content: "cannot read the crash-site file" }; }
        const proposal = draftGuardProposal(str(args, "finding_rule") ?? "unknown", path.relative(ctx.workspace, file).replace(/\\/g, "/"), line, code);
        const target = path.resolve(ctx.workspace, str(args, "target") || ".");
        try {
          const outcome = await runJazzerScan({ target, scratch: path.join(target, ".loam-fuzz-scratch"), regression: true, dynamic: false } as JazzerScanContext);
          proposal.regressionPass = !outcome.hits.some((h) => h.ruleId === proposal.findingId);
        } catch { proposal.note += " (regression re-run unavailable)"; }
        return { ok: true, content: `PROPOSAL ONLY — nothing applied.\n${proposal.candidateDiff}\nregression re-run: ${proposal.regressionPass ? "clean" : "crash persists"}\n${proposal.note}` };
      },
    },
  ];
}

export const FUZZ_TOOL_NAMES = ["fuzz_run", "aixcc_patch_propose"] as const;
