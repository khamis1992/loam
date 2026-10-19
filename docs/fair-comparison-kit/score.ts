/**
 * Fair-comparison scorer (section 24): merges Loam's own live-bench evidence
 * with a reference assistant's results CSV (same fixed task set) into one
 * report — correctness, completion, user interventions, wall time — and writes
 * docs/evidence/fair-comparison.json.
 *
 * Usage: npx tsx docs/fair-comparison-kit/score.ts --loam <loam-live-bench.json> --reference <reference.csv>
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : undefined;
};
const loamPath = flag("loam") ?? "docs/evidence/companions-bench-live.json";
const refPath = flag("reference");

if (!fs.existsSync(loamPath)) {
  console.error(`Loam evidence missing: ${loamPath} — run npm run check:companions-live-bench first.`);
  process.exit(2);
}
const loam = JSON.parse(fs.readFileSync(loamPath, "utf8")) as {
  suite: string;
  model: string;
  results: Array<{ id: string; lang: string; pass: boolean; ms: number; interventions: number }>;
};

const byTask = new Map(loam.results.map((r) => [r.id, r]));
const allTasks = new Set([...byTask.keys()]);

interface RefRow { task: string; lang: string; pass: string; completion_percent: string; user_interventions: string; wall_seconds: string; notes: string }
const refRows: RefRow[] = [];
if (refPath) {
  if (!fs.existsSync(refPath)) {
    console.error(`Reference CSV missing: ${refPath}`);
    process.exit(2);
  }
  const lines = fs.readFileSync(refPath, "utf8").split(/\r?\n/).filter((l) => l.trim());
  const header = (lines.shift() ?? "").split(",");
  for (const line of lines) {
    const cells = line.split(",");
    const row = {} as Record<string, string>;
    header.forEach((h, i) => (row[h] = cells[i] ?? ""));
    refRows.push(row as unknown as RefRow);
    allTasks.add(row.task ?? "");
  }
}

const num = (v: string | undefined): number | null => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : null;
};

const comparison = [...allTasks].sort().map((task) => {
  const l = byTask.get(task);
  const r = refRows.find((x) => x.task === task);
  return {
    task,
    loam: l ? { pass: l.pass, interventions: l.interventions, seconds: Number((l.ms / 1000).toFixed(1)) } : null,
    reference: r ? { pass: r.pass?.toLowerCase() === "true" || r.pass === "1", completionPercent: num(r.completion_percent), interventions: num(r.user_interventions), seconds: num(r.wall_seconds), notes: r.notes ?? "" } : null,
  };
});

const rate = (xs: Array<{ pass: boolean } | null | undefined>) => {
  const valid = xs.filter((x): x is { pass: boolean } => x != null);
  return valid.length === 0 ? null : Number((valid.filter((x) => x.pass).length / valid.length).toFixed(3));
};

const report = {
  suite: "loam-fair-comparison v1",
  at: new Date().toISOString(),
  loam: { evidence: loamPath, model: loam.model, passRate: rate(loam.results.map((r) => (r.pass ? { pass: true } : { pass: false }))), totalInterventions: loam.results.reduce((a, r) => a + r.interventions, 0) },
  reference: refPath ? { results: refPath, passRate: rate(refRows.map((r) => ({ pass: r.pass?.toLowerCase() === "true" || r.pass === "1" }))), totalInterventions: refRows.reduce((a, r) => a + (num(r.user_interventions) ?? 0), 0) } : { results: null, note: "لم تُوفَّر نتائج مرجعية بعد — املأ reference-results-template.csv وأعد التشغيل" },
  perTask: comparison,
  fairnessContract: "نفس الأوامر حرفيًا، صلاحيات مكافئة، 10 دقائق/مهمة، صحة ضد الآثار الجانبية لا الادعاءات، وتسجيل حالات فشل كل طرف.",
};

const outDir = path.resolve(import.meta.dirname, "../../docs/evidence");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "fair-comparison.json");
fs.writeFileSync(outFile, JSON.stringify(report, null, 1));

const fmt = (x: number | null): string => (x === null ? "—" : `${(x * 100).toFixed(0)}%`);
console.log(`Loam (${report.loam.model}): pass=${fmt(report.loam.passRate)} interventions=${report.loam.totalInterventions}`);
console.log(refPath ? `Reference: pass=${fmt(report.reference.passRate)} interventions=${report.reference.totalInterventions}` : "Reference: لا نتائج بعد");
console.table(comparison.map((c) => ({ task: c.task, loamPass: c.loam?.pass ?? "—", loamSec: c.loam?.seconds ?? "—", refPass: c.reference?.pass ?? "—", refSec: c.reference?.seconds ?? "—" })));
console.log(`report → ${outFile}`);
