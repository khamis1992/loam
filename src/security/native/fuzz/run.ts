/**
 * Jazzer executor: discover fuzz targets, run the external jazzer CLI per
 * target through the injectable Exec seam, triage stderr into hits. Gated on
 * the dynamic-confirmation sandbox ([U2]): when the sandbox is unavailable the
 * tool reports skipped and nothing is executed.
 */
import fs from "node:fs";
import path from "node:path";
import { probeSandbox } from "../../audit/sandbox.js";
import type { ReconHit } from "../../audit/types.js";
// Type-only: avoids a load-time cycle with audit/scanners.ts, which imports this module.
import type { Exec, ExecOptions, ScannerReport } from "../../audit/scanners.js";
import { jazzerPlan, exitMeaning } from "./plan.js";
import { triageJazzerRun } from "./triage.js";

/** At most this many fuzz targets per audit run; extra targets are reported, not run. */
export const MAX_TARGETS = 3;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "coverage"]);

/** Files named `*.fuzz.ts` / `*.fuzz.js` anywhere under root (bounded walk). */
export function discoverFuzzTargets(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || out.length > 50) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.(fuzz|fuzz\.spec)\.(ts|js|mjs|cjs)$/.test(e.name) || /^fuzz\.(ts|js|mjs|cjs)$/.test(e.name)) out.push(p);
    }
  };
  walk(root, 0);
  return out.sort();
}

export function toSarif(hits: ReconHit[]): Record<string, unknown> {
  return {
    version: "2.1.0",
    runs: [{
      tool: { driver: { name: "jazzer", rules: [...new Set(hits.map((h) => h.ruleId))].map((id) => ({ id, shortDescription: { text: id } })) } },
      results: hits.map((h) => ({
        ruleId: h.ruleId, level: "error", message: { text: h.message },
        locations: [{ physicalLocation: { artifactLocation: { uri: h.file }, region: { startLine: h.line } } }],
      })),
    }],
  };
}

export interface JazzerScanContext {
  target: string;
  scratch: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  exec?: Exec;
  /** Test seam for the dynamic-confirmation gate; defaults to the real (static-only) probe. */
  sandboxProbe?: () => { available: boolean; blocker: string };
}

export interface JazzerScanOutcome {
  hits: ReconHit[];
  reports: ScannerReport[];
  sarif?: { tool: "jazzer"; doc: Record<string, unknown> };
}

export async function runJazzerScan(ctx: JazzerScanContext): Promise<JazzerScanOutcome> {
  const sandbox = (ctx.sandboxProbe ?? probeSandbox)();
  if (!sandbox.available) {
    return { hits: [], reports: [{ tool: "jazzer", status: "skipped", hitCount: 0, detail: sandbox.blocker }] };
  }
  const targets = discoverFuzzTargets(ctx.target);
  if (targets.length === 0) {
    return { hits: [], reports: [{ tool: "jazzer", status: "skipped", hitCount: 0, detail: "no fuzz targets (*.fuzz.ts) found" }] };
  }
  const exec = ctx.exec ?? (await import("../../audit/scanners.js")).defaultExec;
  const corpus = path.join(ctx.scratch, "jazzer-corpus");
  fs.mkdirSync(corpus, { recursive: true });
  const hits: ReconHit[] = [];
  let status: ScannerReport["status"] = "ok";
  let detail: string | undefined;
  let ran = 0;
  for (const entry of targets.slice(0, MAX_TARGETS)) {
    if (ctx.signal?.aborted) { status = "skipped"; detail = "cancelled"; break; }
    const plan = jazzerPlan({ entry, corpusDir: corpus });
    ran++;
    const opts: ExecOptions = { cwd: ctx.target, timeoutMs: ctx.timeoutMs ?? 300_000, maxBytes: 5_000_000, signal: ctx.signal };
    const r = await exec("npx", plan.argv, opts);
    if (r.spawnError) { status = "unavailable"; detail = `jazzer not runnable: ${r.spawnError.slice(0, 160)}`; break; }
    if (r.timedOut) { status = "timeout"; detail = "wall-clock limit"; break; }
    if (r.code === null || !plan.okCodes.includes(r.code)) {
      status = "tool_error";
      detail = `exit ${r.code}: ${exitMeaning(r.code) ?? r.stderr.trim().split(/\r?\n/)[0]?.slice(0, 160) ?? ""}`;
      break;
    }
    const triaged = triageJazzerRun({ entry: path.relative(ctx.target, entry).replace(/\\/g, "/"), stdout: r.stdout, stderr: r.stderr });
    hits.push(...triaged.hits);
  }
  if (targets.length > MAX_TARGETS) {
    detail = `${targets.length - MAX_TARGETS} additional fuzz target(s) not run (cap ${MAX_TARGETS})`;
  }
  const reports: ScannerReport[] = [{ tool: "jazzer", status, hitCount: hits.length, ...(detail ? { detail } : {}) }];
  return { hits, reports, ...(hits.length ? { sarif: { tool: "jazzer" as const, doc: toSarif(hits) } } : {}) };
}
