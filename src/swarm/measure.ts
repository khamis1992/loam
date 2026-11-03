/**
 * BUILD_SPEC §12.3: pass/fail thresholds for the before/after measurement plan. Pure functions,
 * fed by check-swarm-compare.ts samples. Arms: "swarm" = before (effort full), "auto" = after
 * (effort auto + recommended profile), "solo" = single agent reference.
 */
export type TaskSize = "small" | "medium" | "large";
export type MeasureArm = "swarm" | "auto" | "solo";
export interface MeasureSample {
  task: string; size: TaskSize; arm: MeasureArm; round: number;
  status: string; tokens: number; modelMs: number; wallMs: number; modelCalls: number; productWorks: boolean;
}
export interface ThresholdCheck { name: string; pass: boolean; detail: string }

export function median(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

const pick = (samples: readonly MeasureSample[], arm: MeasureArm, sizes: readonly TaskSize[]) => samples.filter(s => s.arm === arm && sizes.includes(s.size));
const count = (xs: readonly MeasureSample[], f: (s: MeasureSample) => boolean) => xs.filter(f).length;
const done = (s: MeasureSample) => s.status === "completed";

/** Small tasks: "after" must match solo; medium/large: "after" must not regress against "before". */
export function evaluateThresholds(samples: readonly MeasureSample[]): { pass: boolean; checks: ThresholdCheck[] } {
  const checks: ThresholdCheck[] = [];
  const add = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });
  const smallAfter = pick(samples, "auto", ["small"]), smallSolo = pick(samples, "solo", ["small"]);
  if (smallAfter.length && smallSolo.length) {
    add("small: completed(after) >= completed(solo)", count(smallAfter, done) >= count(smallSolo, done), `${count(smallAfter, done)}/${smallAfter.length} vs ${count(smallSolo, done)}/${smallSolo.length}`);
    const ta = median(smallAfter.map(s => s.tokens)), ts = median(smallSolo.map(s => s.tokens));
    add("small: median tokens(after) <= 1.5 x solo", ta <= 1.5 * ts, `${ta} vs ${ts}`);
    const wa = median(smallAfter.map(s => s.wallMs)), ws = median(smallSolo.map(s => s.wallMs));
    add("small: median wall time(after) <= 2 x solo", wa <= 2 * ws, `${wa} ms vs ${ws} ms`);
    add("small: productWorks(after) >= solo", count(smallAfter, s => s.productWorks) >= count(smallSolo, s => s.productWorks), `${count(smallAfter, s => s.productWorks)} vs ${count(smallSolo, s => s.productWorks)}`);
  }
  const bigAfter = pick(samples, "auto", ["medium", "large"]), bigBefore = pick(samples, "swarm", ["medium", "large"]);
  if (bigAfter.length && bigBefore.length) {
    add("medium/large: completed(after) >= before", count(bigAfter, done) >= count(bigBefore, done), `${count(bigAfter, done)}/${bigAfter.length} vs ${count(bigBefore, done)}/${bigBefore.length}`);
    add("medium/large: productWorks(after) >= before", count(bigAfter, s => s.productWorks) >= count(bigBefore, s => s.productWorks), `${count(bigAfter, s => s.productWorks)} vs ${count(bigBefore, s => s.productWorks)}`);
    const ta = median(bigAfter.map(s => s.tokens)), tb = median(bigBefore.map(s => s.tokens));
    add("medium/large: median tokens(after) <= 1.1 x before", ta <= 1.1 * tb, `${ta} vs ${tb}`);
  }
  if (!checks.length) add("samples present", false, "need auto+solo small samples or auto+swarm medium/large samples");
  return { pass: checks.every(c => c.pass), checks };
}

/** Gate for moving a light stage to the local model (qwen3.6:35b-a3b): per-stage stats over >= 9 runs each. */
export interface StageStats { runs: number; completed: number; gateFailures: number; medianStageMs: number }
export function evaluateLocalStage(cloud: StageStats, local: StageStats): { pass: boolean; checks: ThresholdCheck[] } {
  const rate = (x: StageStats, n: number) => (x.runs ? n / x.runs : 0);
  const checks: ThresholdCheck[] = [
    { name: ">= 9 runs per arm", pass: cloud.runs >= 9 && local.runs >= 9, detail: `${cloud.runs} cloud / ${local.runs} local` },
    { name: "completion(local) >= cloud", pass: rate(local, local.completed) >= rate(cloud, cloud.completed), detail: `${local.completed}/${local.runs} vs ${cloud.completed}/${cloud.runs}` },
    { name: "gate failure rate(local) <= cloud + 10pp", pass: rate(local, local.gateFailures) <= rate(cloud, cloud.gateFailures) + 0.10, detail: `${local.gateFailures}/${local.runs} vs ${cloud.gateFailures}/${cloud.runs}` },
    { name: "median stage time(local) <= 2 x cloud", pass: local.medianStageMs <= 2 * cloud.medianStageMs, detail: `${local.medianStageMs} ms vs ${cloud.medianStageMs} ms` },
  ];
  return { pass: checks.every(c => c.pass), checks };
}
