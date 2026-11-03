/**
 * C8: trajectory evals. Scores HOW a run got its answer, not only the answer.
 * Two scorers:
 *   - scoreTrajectory: deterministic, free, used by every eval case that sets
 *     a `trajectory` verifier (new VerifierSpec kind in src/eval/types.ts);
 *   - judgeTrajectory: cloud-model judge giving per-step necessary/in-order
 *     verdicts (idea from Mastra's trajectory scorer, Apache-2.0 part of
 *     packages/evals; own prompt, own schema, no Mastra code).
 */
import { callStructured } from "../contracts/structured.js";
import type { JsonSchema } from "../contracts/schema.js";
import type { ModelPort } from "../modelPort.js";

export interface ActualStep {
  name: string;
  ok: boolean;
  args?: Record<string, unknown>;
}

export interface ExpectedStep {
  tool: string;
  /** Every listed key must deep-equal the actual arg (strings: substring match). */
  args?: Record<string, unknown>;
  optional?: boolean;
}

export interface TrajectoryExpectation {
  steps: ExpectedStep[];
  ordering: "strict" | "relaxed" | "unordered";
  forbiddenTools?: string[];
  maxSteps?: number;
}

export interface TrajectoryScore {
  score: number;
  recall: number;
  order: number;
  precision: number;
  efficiency: number;
  forbidden: string[];
  missing: string[];
  detail: string;
}

/** Weights of the four parts; forbidden tool use caps the score at 0.2. */
export const TRAJECTORY_WEIGHTS = { recall: 0.45, order: 0.25, precision: 0.15, efficiency: 0.15 } as const;

function argsMatch(want: Record<string, unknown> | undefined, got: Record<string, unknown> | undefined): boolean {
  if (!want) return true;
  if (!got) return false;
  return Object.entries(want).every(([k, v]) => {
    const g = got[k];
    if (typeof v === "string" && typeof g === "string") return g.includes(v);
    return JSON.stringify(g) === JSON.stringify(v);
  });
}

const matches = (e: ExpectedStep, a: ActualStep) => e.tool === a.name && a.ok && argsMatch(e.args, a.args);

/** Longest common subsequence length under the `matches` relation. */
function lcs(exp: ExpectedStep[], act: ActualStep[]): number {
  const dp: number[][] = Array.from({ length: exp.length + 1 }, () => new Array<number>(act.length + 1).fill(0));
  for (let i = 1; i <= exp.length; i++) {
    for (let j = 1; j <= act.length; j++) {
      const row = dp[i] as number[];
      const prev = dp[i - 1] as number[];
      row[j] = matches(exp[i - 1] as ExpectedStep, act[j - 1] as ActualStep) ? (prev[j - 1] as number) + 1 : Math.max(prev[j] as number, row[j - 1] as number);
    }
  }
  return (dp[exp.length] as number[])[act.length] as number;
}

/** Longest prefix of `exp` matched as a contiguous run anywhere in `act` (strict order). */
function contiguous(exp: ExpectedStep[], act: ActualStep[]): number {
  let best = 0;
  for (let s = 0; s < act.length; s++) {
    let k = 0;
    while (k < exp.length && s + k < act.length && matches(exp[k] as ExpectedStep, act[s + k] as ActualStep)) k++;
    best = Math.max(best, k);
  }
  return best;
}

export function scoreTrajectory(actual: ActualStep[], ex: TrajectoryExpectation): TrajectoryScore {
  const required = ex.steps.filter((s) => !s.optional);
  const missing = required.filter((e) => !actual.some((a) => matches(e, a))).map((e) => e.tool);
  const recall = required.length ? (required.length - missing.length) / required.length : 1;
  const order =
    ex.ordering === "unordered" || required.length === 0
      ? recall
      : ex.ordering === "strict"
        ? contiguous(required, actual) / required.length
        : lcs(required, actual) / required.length;
  const used = actual.filter((a) => ex.steps.some((e) => matches(e, a))).length;
  const precision = actual.length ? used / actual.length : required.length ? 0 : 1;
  const efficiency = ex.maxSteps && actual.length > ex.maxSteps ? ex.maxSteps / actual.length : 1;
  const forbidden = [...new Set(actual.filter((a) => ex.forbiddenTools?.includes(a.name)).map((a) => a.name))];
  let score = TRAJECTORY_WEIGHTS.recall * recall + TRAJECTORY_WEIGHTS.order * order + TRAJECTORY_WEIGHTS.precision * precision + TRAJECTORY_WEIGHTS.efficiency * efficiency;
  if (forbidden.length) score = Math.min(score, 0.2);
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return {
    score: r(score),
    recall: r(recall),
    order: r(order),
    precision: r(precision),
    efficiency: r(efficiency),
    forbidden,
    missing,
    detail: `recall ${r(recall)}, order ${r(order)}, precision ${r(precision)}, efficiency ${r(efficiency)}${forbidden.length ? `, forbidden: ${forbidden.join(", ")}` : ""}${missing.length ? `, missing: ${missing.join(", ")}` : ""}`,
  };
}

export const JUDGE_STEPS_SCHEMA: JsonSchema = {
  type: "object",
  required: ["steps", "overall"],
  additionalProperties: false,
  properties: {
    steps: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        required: ["index", "necessary", "inOrder"],
        additionalProperties: false,
        properties: { index: { type: "integer", minimum: 0 }, necessary: { type: "boolean" }, inOrder: { type: "boolean" }, note: { type: "string", maxLength: 200 } },
      },
    },
    overall: { type: "string", maxLength: 600 },
  },
};

export interface JudgedTrajectory {
  score: number;
  necessaryRatio: number;
  inOrderRatio: number;
  overall: string;
}

export async function judgeTrajectory(port: ModelPort, model: string, goal: string, actual: ActualStep[], repairAttempts = 1): Promise<JudgedTrajectory | undefined> {
  if (actual.length === 0) return { score: 0, necessaryRatio: 0, inOrderRatio: 0, overall: "no steps" };
  const list = actual.slice(0, 200).map((a, i) => `${i}. ${a.name}${a.ok ? "" : " (failed)"} ${JSON.stringify(a.args ?? {}).slice(0, 200)}`).join("\n");
  const r = await callStructured<{ steps: Array<{ index: number; necessary: boolean; inOrder: boolean }>; overall: string }>(port, {
    model,
    contract: "trajectory_judge",
    schema: JUDGE_STEPS_SCHEMA,
    repairAttempts,
    messages: [
      { role: "system", content: "You audit the tool calls an agent made. For each call say whether the goal needed it and whether it came at a sensible point." },
      { role: "user", content: `Goal:\n${goal}\n\nTool calls:\n${list}\n\nJudge every call by its index.` },
    ],
  });
  if (!r.ok) return undefined;
  const n = Math.min(actual.length, 200);
  const nec = r.value.steps.filter((s) => s.index < n && s.necessary).length / n;
  const ord = r.value.steps.filter((s) => s.index < n && s.inOrder).length / n;
  return { score: Math.round((0.6 * nec + 0.4 * ord) * 1000) / 1000, necessaryRatio: nec, inOrderRatio: ord, overall: r.value.overall };
}
