import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import type { CaseResult, EvalRun, EvalRunSummary } from "./types.js";

const runsDir = (): string => path.join(DATA_DIR, "evals", "runs");
const indexFile = (): string => path.join(DATA_DIR, "evals", "index.jsonl");

let active: EvalRun | null = null;

export function computeSummary(cases: CaseResult[]): EvalRunSummary["summary"] {
  const pass = cases.filter((c) => c.status === "pass").length;
  const fail = cases.filter((c) => c.status === "fail").length;
  const error = cases.filter((c) => c.status === "error").length;
  const skipped = cases.filter((c) => c.status === "skipped").length;
  const attempted = pass + fail + error;
  return { pass, fail, error, skipped, passRate: attempted > 0 ? pass / attempted : 0, cases: cases.length };
}

export function beginRun(run: EvalRun): void {
  active = run;
}

export function activeRun(): EvalRun | null {
  return active;
}

export function activeSummary(): EvalRunSummary | null {
  if (!active) return null;
  return {
    id: active.id,
    suiteId: active.suiteId,
    suiteName: active.suiteName,
    model: active.model,
    startedAt: active.startedAt,
    finishedAt: active.finishedAt,
    status: "running",
    summary: computeSummary(active.cases),
  };
}

export function pushCaseResult(result: CaseResult): void {
  if (active) active.cases.push(result);
}

export function finishRun(run: EvalRun): EvalRunSummary {
  const summary: EvalRunSummary = {
    id: run.id,
    suiteId: run.suiteId,
    suiteName: run.suiteName,
    model: run.model,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    summary: run.summary,
  };
  try {
    fs.mkdirSync(runsDir(), { recursive: true });
    fs.writeFileSync(path.join(runsDir(), `${run.id}.json`), JSON.stringify(run), "utf8");
    fs.appendFileSync(indexFile(), `${JSON.stringify(summary)}\n`, "utf8");
  } catch {
    /* persistence is best-effort */
  }
  active = null;
  return summary;
}

export function listRuns(limit = 20): EvalRunSummary[] {
  const out: EvalRunSummary[] = [];
  const running = activeSummary();
  if (running) out.push(running);
  try {
    if (fs.existsSync(indexFile())) {
      const lines = fs.readFileSync(indexFile(), "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0);
      for (const line of lines.slice(-limit).reverse()) {
        try {
          out.push(JSON.parse(line) as EvalRunSummary);
        } catch {
          /* skip malformed */
        }
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

export function getRun(id: string): EvalRun | null {
  if (active && active.id === id) return active;
  try {
    const file = path.join(runsDir(), `${id}.json`);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as EvalRun;
  } catch {
    return null;
  }
}

export function lastRunForSuite(suiteId: string): EvalRunSummary | undefined {
  return listRuns(50).find((r) => r.suiteId === suiteId && r.status !== "running");
}

export function pruneRuns(keep: number): void {
  if (keep <= 0) return;
  try {
    if (!fs.existsSync(indexFile())) return;
    const lines = fs.readFileSync(indexFile(), "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length <= keep) return;
    const dropped = lines.slice(0, lines.length - keep);
    for (const line of dropped) {
      try {
        const parsed = JSON.parse(line) as { id?: string };
        if (parsed.id) fs.rmSync(path.join(runsDir(), `${parsed.id}.json`), { force: true });
      } catch {
        /* ignore */
      }
    }
    fs.writeFileSync(indexFile(), `${lines.slice(-keep).join("\n")}\n`, "utf8");
  } catch {
    /* best-effort */
  }
}
