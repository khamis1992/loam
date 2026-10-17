import { log } from "../log.js";
import { newId } from "../server/db.js";
import { runSuite, type EvalDeps, type ProgressEvent } from "./runner.js";
import type { EvalRun, EvalSuite } from "./types.js";
import { executionQueue } from "../server/executionQueue.js";

let busy = false;

export function evalBusy(): boolean {
  return busy;
}

export interface RunOpts {
  caseFilter?: string;
  onProgress?: (e: ProgressEvent) => void;
  signal?: AbortSignal;
}

export async function runSuiteLocked(suite: EvalSuite, deps: EvalDeps, opts?: RunOpts): Promise<EvalRun> {
  if (busy) throw new Error("يوجد تشغيل تقييم جارٍ بالفعل");
  busy = true;
  try {
    return await executionQueue.enqueue(newId("eval"), () => runSuite({ suite, deps, caseFilter: opts?.caseFilter, onProgress: opts?.onProgress, signal: opts?.signal }), opts?.signal);
  } finally {
    busy = false;
  }
}

export function runSuiteBackground(suite: EvalSuite, deps: EvalDeps, opts?: RunOpts): { runId: string } {
  if (busy) throw new Error("يوجد تشغيل تقييم جارٍ بالفعل");
  busy = true;
  const runId = newId("eval");
  void executionQueue.enqueue(runId, () => runSuite({ suite, deps, runId, caseFilter: opts?.caseFilter, onProgress: opts?.onProgress, signal: opts?.signal }), opts?.signal)
    .catch((err) => log.warn(`eval run failed: ${err instanceof Error ? err.message : String(err)}`))
    .finally(() => {
      busy = false;
    });
  return { runId };
}
