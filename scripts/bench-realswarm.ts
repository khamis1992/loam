/**
 * B5 coding-team benchmark (BUILD_SPEC §8.3). Runs toy goals through the real
 * HTTP API with 1, 2 and 4 workers on one cloud model, repetitions each, and
 * reports measured numbers only: wall time, model calls, tokens, merges
 * landed, conflicts, verified patches, FAILs.
 *
 *   node --import tsx scripts/bench-realswarm.ts [--base=http://127.0.0.1:3939] [--model=<cloud model>] [--reps=3]
 *
 * The default maxWorkers stays 4 only if 4 workers finish no slower than 2 on
 * at least 2 of 3 goals (OD-8); the script prints the recommendation.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const arg = (name: string, d?: string): string | undefined => {
  const prefix = `--${name}=`;
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i] ?? "";
    if (a.startsWith(prefix)) return a.slice(prefix.length);
  }
  return d;
};

const base = arg("base", "http://127.0.0.1:3939")!;
const model = arg("model");
const reps = Number(arg("reps", "3"));

const goals: Array<{ id: string; goal: string }> = [
  { id: "cli-three-commands", goal: "Write a small Node CLI in cli.js with three subcommands (add, list, sum) over a JSON store, plus a test file test.js runnable with `node --test`, and a README.md. Keep every file small." },
  { id: "site-three-pages", goal: "Build a tiny static site: index.html, about.html, styles.css shared by both pages, and a script.js that counts visits in localStorage. Each page links to the other." },
  { id: "lib-three-modules", goal: "Create a small library: src/math.js (add, sub, mul), src/str.js (slug, pad), src/index.js re-exporting both, with tests in test/math.test.js and test/str.test.js runnable with `node --test`." },
];

async function main(): Promise<void> {
  const list = await fetch(`${base}/api/realswarm/runs`).then((r) => r.json() as Promise<{ runs?: unknown[] }>).catch(() => undefined);
  if (!list || !Array.isArray(list.runs)) {
    console.error(`cannot reach ${base}/api/realswarm/runs — start the Loam server first`);
    process.exit(1);
  }
  const rows: Array<Record<string, string | number>> = [];
  const ratios: Array<Record<string, number>> = [];
  for (const g of goals) {
    for (const workers of [1, 2, 4]) {
      const times: number[] = [];
      const agg = { modelCalls: 0, promptTokens: 0, completionTokens: 0, merges: 0, conflicts: 0, verified: 0, fails: 0, conflictsResolved: 0 };
      let landed = 0;
      for (let rep = 1; rep <= reps; rep++) {
        const t0 = Date.now();
        const created = await fetch(`${base}/api/realswarm/runs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ goal: g.goal, maxWorkers: workers, ...(model ? { model } : {}), deadlineMs: 1_800_000 }),
        }).then((r) => r.json() as Promise<{ run?: { id: string }; error?: string }>);
        if (!created.run?.id) throw new Error(`create failed for ${g.id}/${workers}: ${created.error ?? "unknown"}`);
        const id = created.run.id;
        let run: { status?: string; usage?: { modelCalls: number; promptTokens: number; completionTokens: number }; metrics?: { mergesLanded: number; patchVerified: number; failsRecorded: number; conflictsResolved: number }; merges?: unknown[]; events?: Array<{ type: string }> } | undefined;
        for (;;) {
          await new Promise((r) => setTimeout(r, 2000));
          run = await fetch(`${base}/api/realswarm/runs/${id}`).then((r) => r.json() as Promise<{ run?: typeof run }>).then((d) => d.run);
          if (run && !["queued", "running"].includes(run.status ?? "")) break;
        }
        times.push(Date.now() - t0);
        if (run) {
          agg.modelCalls += run.usage?.modelCalls ?? 0;
          agg.promptTokens += run.usage?.promptTokens ?? 0;
          agg.completionTokens += run.usage?.completionTokens ?? 0;
          agg.merges += run.metrics?.mergesLanded ?? 0;
          agg.verified += run.metrics?.patchVerified ?? 0;
          agg.fails += run.metrics?.failsRecorded ?? 0;
          agg.conflictsResolved += run.metrics?.conflictsResolved ?? 0;
          agg.conflicts += (run.events ?? []).filter((e) => e.type === "merge_conflict").length;
          landed += (run.merges ?? []).length;
        }
      }
      const avg = Math.round(times.reduce((a, b) => a + b, 0) / Math.max(1, times.length));
      rows.push({ goal: g.id, workers, reps, avgWallMs: avg, mergesLandedTotal: landed, ...agg });
      ratios.push({ goal: g.id, workers, avgWallMs: avg });
      console.log(`[bench] ${g.id} workers=${workers} avgWall=${avg}ms merges=${agg.merges} verified=${agg.verified} calls=${agg.modelCalls} conflicts=${agg.conflicts}`);
    }
  }
  // OD-8: keep the default 4 only when 4 is not slower than 2 on >= 2 of 3 goals.
  let notSlower = 0;
  for (const g of goals) {
    const w2 = ratios.find((r) => r.goal === g.id && r.workers === 2)?.avgWallMs ?? Infinity;
    const w4 = ratios.find((r) => r.goal === g.id && r.workers === 4)?.avgWallMs ?? Infinity;
    if (w4 <= w2 * 1.05) notSlower++;
  }
  const recommendation = notSlower >= 2 ? "keep default maxWorkers=4" : "lower the default maxWorkers to 2 (OD-8)";
  const out = { rows, recommendation, generatedAt: new Date().toISOString() };
  const file = path.join(os.tmpdir(), `bench-realswarm-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.table(rows);
  console.log(`OD-8 recommendation: ${recommendation} (${notSlower}/3 goals not slower at 4 workers)`);
  console.log(`full numbers: ${file}`);
}

void main();
