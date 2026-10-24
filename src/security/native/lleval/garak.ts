/**
 * garak binding for agent self-audit (Phase G). garak is an external Python
 * process (`pip install garak`); this module only builds a bounded command
 * line and parses its `garak.*.report.jsonl` output. It is never run against
 * customer code — self-audit of Loam's own model configuration only.
 *
 * Report rows carry entry_type "attempt" with detector_results mapping each
 * detector to a list of 0..1 scores; garak counts a score >= 0.5 as a hit.
 */
import path from "node:path";

export interface GarakPlanOptions {
  /** garak generator id, e.g. "openai" or "rest". */
  modelType: string;
  modelName?: string;
  /** Probe classes to run; omitted means garak's default selection. */
  probes?: string[];
  /** Directory the `garak.*.report.jsonl` prefix is written to (created by the caller). */
  outDir: string;
  parallel?: number;
}

export function garakPlan(o: GarakPlanOptions): { argv: string[]; okCodes: number[] } {
  const argv = [
    "--model_type", o.modelType,
    ...(o.modelName ? ["--model_name", o.modelName] : []),
    ...(o.probes?.length ? ["--probes", o.probes.join(",")] : []),
    "--report_prefix", path.join(o.outDir, "garak"),
    "--narrow_output",
    ...(o.parallel ? ["--parallel_requests", String(o.parallel)] : []),
  ];
  return { argv, okCodes: [0] };
}

export interface GarakHit { probe: string; detector: string; goal: string; score: number }
export interface GarakProbeSummary { probe: string; attempts: number; hits: number; hitRate: number }

export interface GarakReport {
  attempts: number;
  hits: GarakHit[];
  byProbe: GarakProbeSummary[];
}

const HIT_THRESHOLD = 0.5;

export function parseGarakReport(jsonl: string): GarakReport {
  const hits: GarakHit[] = [];
  const perProbe = new Map<string, { attempts: number; hits: number }>();
  for (const line of jsonl.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }
    if (row.entry_type !== "attempt") continue;
    const probe = typeof row.probe_classname === "string" ? row.probe_classname : "unknown";
    const goal = typeof row.goal === "string" ? row.goal.slice(0, 200) : "";
    const agg = perProbe.get(probe) ?? { attempts: 0, hits: 0 };
    agg.attempts++;
    const detectors = row.detector_results as Record<string, unknown[]> | undefined;
    for (const [detector, scores] of Object.entries(detectors ?? {})) {
      if (!Array.isArray(scores)) continue;
      for (const s of scores) {
        if (typeof s === "number" && s >= HIT_THRESHOLD) {
          hits.push({ probe, detector, goal, score: s });
          agg.hits++;
        }
      }
    }
    perProbe.set(probe, agg);
  }
  const byProbe = [...perProbe.entries()]
    .map(([probe, a]) => ({ probe, attempts: a.attempts, hits: a.hits, hitRate: a.attempts ? a.hits / a.attempts : 0 }))
    .sort((x, y) => (x.probe < y.probe ? -1 : 1));
  return { attempts: byProbe.reduce((s, p) => s + p.attempts, 0), hits, byProbe };
}
