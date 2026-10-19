import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunOptions, RunResult } from "../agent/loop.js";

// Roadmap sections 20-21: a fixed reference project set (create / fix / modify), run through the
// real SwarmService with fixture executors, measuring wall-clock time, model calls, tool calls,
// repair rounds and memory growth deterministically — no live model involved.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const output = path.join(repoRoot, "output", "verification", "swarm-bench.json");

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "loam-swarm-bench-"));
process.env.LOAM_DATA_DIR = temporary;
const { loadConfig } = await import("../config.js");
const { SwarmService } = await import("../swarm/service.js");
const { ToolRegistry } = await import("../tools/registry.js");
const { fileTools } = await import("../tools/files.js");
const { shellTools } = await import("../tools/shell.js");
const { OllamaClient } = await import("../ollama.js");
const db = await import("../server/db.js");

const cfg = loadConfig();
cfg.workspace = path.join(temporary, "workspace");
fs.mkdirSync(cfg.workspace);
const tools = new ToolRegistry();
tools.registerAll(fileTools);
tools.registerAll(shellTools);
const ollama = new OllamaClient(cfg.ollamaUrl);

type ScenarioId = "create" | "fix" | "modify" | "migrate";
const modelCalls: Record<ScenarioId, number> = { create: 0, fix: 0, modify: 0, migrate: 0 };
const stageCalls: Record<ScenarioId, string[]> = { create: [], fix: [], modify: [], migrate: [] };
const suiteFor: Record<ScenarioId, string> = { create: "app.test.cjs", fix: "calculator.test.cjs", modify: "math.test.cjs", migrate: "tasks.test.cjs" };

// Seeded repository texts. The zero-divisor and square assertion lines double as preservation
// markers checked against the final workspace: existing tests must survive the swarm untouched.
const FIX_ZERO_DIVISOR_TEST = "test('divide rejects zero divisor', () => assert.throws(() => calc.divide(1, 0), /zero divisor/));";
const MODIFY_SQUARE_TEST = "test('square multiplies a number by itself', () => assert.equal(math.square(3), 9));";
const fixSeed = path.join(temporary, "seed-fix");
fs.mkdirSync(fixSeed, { recursive: true });
fs.writeFileSync(path.join(fixSeed, "util.cjs"), "module.exports = (a, b) => a - b;\n");
fs.writeFileSync(path.join(fixSeed, "calculator.cjs"), "module.exports = { add: (a, b) => a + b, divide(a, b) { if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('finite numbers required'); return a / b; } };\n");
fs.writeFileSync(path.join(fixSeed, "calculator.test.cjs"), `const { test } = require('node:test');\nconst assert = require('node:assert/strict');\nconst calc = require('./calculator.cjs');\ntest('add returns the sum', () => assert.equal(calc.add(2, 3), 5));\ntest('divide normal', () => assert.equal(calc.divide(6, 3), 2));\n${FIX_ZERO_DIVISOR_TEST}\n`);
const MIGRATE_DATA_MARKER = "مهمة قديمة من الإصدار الأول";
const migrateSeed = path.join(temporary, "seed-migrate");
fs.mkdirSync(migrateSeed, { recursive: true });
fs.writeFileSync(path.join(migrateSeed, "store.cjs"), "const fs = require('node:fs');\n// v1 storage: { items: [{ id, title, done }] }\nclass TaskStore { constructor(file) { this.file = file; try { this.items = JSON.parse(fs.readFileSync(file, 'utf8')).items ?? []; } catch { this.items = []; } } list() { return this.items; } }\nmodule.exports = { TaskStore };\n");
fs.writeFileSync(path.join(migrateSeed, "tasks.json"), JSON.stringify({ items: [{ id: 1, title: MIGRATE_DATA_MARKER, done: false }] }, null, 1));
fs.writeFileSync(path.join(migrateSeed, "tasks.test.cjs"), "const { test } = require('node:test');\nconst assert = require('node:assert/strict');\nconst { TaskStore } = require('./store.cjs');\ntest('v1 store lists seeded items', () => { const s = new TaskStore('tasks.json'); assert.equal(s.list().length, 1); });\n");
const modifySeed = path.join(temporary, "seed-modify");
fs.mkdirSync(modifySeed, { recursive: true });
fs.writeFileSync(path.join(modifySeed, "math.cjs"), "module.exports = { square: (x) => x * x };\n");
fs.writeFileSync(path.join(modifySeed, "math.test.cjs"), `const { test } = require('node:test');\nconst assert = require('node:assert/strict');\nconst math = require('./math.cjs');\n${MODIFY_SQUARE_TEST}\n`);

// The scenario is identified from the actual workspace contents — deterministic at every stage
// because seeds persist from creation and the greenfield run only creates its own files.
const scenarioOf = (workspace: string): ScenarioId => {
  if (fs.existsSync(path.join(workspace, "calculator.cjs"))) return "fix";
  if (fs.existsSync(path.join(workspace, "store.cjs")) && fs.existsSync(path.join(workspace, "tasks.json"))) return "migrate";
  if (fs.existsSync(path.join(workspace, "math.cjs"))) return "modify";
  return "create";
};

const executor = async (o: RunOptions): Promise<RunResult> => {
  const stage = /Stage: ([\w-]+)\./.exec(o.systemOverride ?? "")![1]!;
  const scenario = scenarioOf(o.cfg.workspace ?? "");
  modelCalls[scenario]++; stageCalls[scenario].push(stage);
  const ctx = { cfg: o.cfg, workspace: o.cfg.workspace, emit: o.emit, signal: o.signal, taskId: o.taskId };
  if (stage === "discovery") return {text:"المستخدمون: طالب ومدرس. قصة استخدام US-1 (AC-1: تظهر في القائمة). US-2 (AC-2: تتغير الحالة). US-3 (AC-3: تختفي). خريطة الإصدار: الإصدار الأول أساسي وما بعده المشاركة.",messages:[],steps:1,model:"fixture",usage:{promptTokens:10,completionTokens:5,durationMs:5}};
  if (stage === "ux") return {text:"بنية المعلومات: شاشة واحدة. نظام عربي RTL. حالات الواجهة: فراغ وتحميل وفشل. لوحة المفاتيح: Enter وإتاحة aria.",messages:[],steps:1,model:"fixture",usage:{promptTokens:10,completionTokens:5,durationMs:5}};

  const names = o.tools.names();
  // Cheap role-isolation check mirroring the engine's per-stage capability subsets.
  if (stage === "implementation") { assert(names.includes("file_write")); assert(names.includes("shell_run")); }
  if (stage === "testgen") { assert(names.includes("file_write")); assert(!names.includes("shell_run")); }
  if (stage === "qa") { assert(names.includes("shell_run")); assert(!names.includes("file_write")); }
  if (["requirements", "architecture", "research", "repo", "review", "delivery"].includes(stage)) {
    assert(!names.includes("shell_run")); assert(!names.includes("file_write"));
  }
  if (stage === "implementation") {
    const write = async (file: string, content: string): Promise<void> => {
      assert.equal((await o.tools.exec("file_write", { path: file, content }, ctx)).ok, true, `fixture implementation must write ${file}`);
    };
    if (scenario === "create") {
      await write("app.cjs", "module.exports = { add: (a, b) => a + b };\n");
      await write("app.test.cjs", "const { test } = require('node:test');\nconst assert = require('node:assert/strict');\nconst { add } = require('./app.cjs');\ntest('add sums two numbers', () => assert.equal(add(2, 3), 5));\ntest('add supports negative numbers', () => assert.equal(add(-2, 3), 1));\n");
    }
    if (scenario === "fix") {
      // Minimal seeded-repo fix: only the faulty source is rewritten, tests and util.cjs stay untouched.
      await write("calculator.cjs", "module.exports = { add: (a, b) => a + b, divide(a, b) { if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('finite numbers required'); if (b === 0) throw new Error('zero divisor'); return a / b; } };\n");
    }
    if (scenario === "migrate") {
      // Roadmap §16: data migration — v1 {items:[]} to v2 {version:2,tasks:{id:title}},
      // with migrate() carrying every pre-existing task across untouched.
      await write("store.cjs", "const fs = require('node:fs');\nclass TaskStore {\n  constructor(file) { this.file = file; this.tasks = new Map(); this.#load(); }\n  #load() { try { const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (raw.tasks) { for (const [k, v] of Object.entries(raw.tasks)) this.tasks.set(Number(k), v); } else if (raw.items) { for (const it of raw.items) this.tasks.set(it.id, it.title); } } catch {} }\n  save() { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ version: 2, tasks: Object.fromEntries(this.tasks) })); fs.renameSync(tmp, this.file); }\n  list() { return [...this.tasks.entries()].map(([id, title]) => ({ id, title })); }\n}\nfunction migrate(file) { const s = new TaskStore(file); s.save(); return s; }\nmodule.exports = { TaskStore, migrate };\n");
      await write("tasks.test.cjs", `const { test } = require('node:test');\nconst assert = require('node:assert/strict');\nconst { migrate, TaskStore } = require('./store.cjs');\ntest('migrate carries existing v1 data into v2 untouched', () => { migrate('tasks.json'); const s = new TaskStore('tasks.json'); const list = s.list(); assert.equal(list.length, 1); assert.match(list[0].title, /${"إصدار الأول"}/); });\ntest('v2 save writes version 2 shape', () => { const raw = JSON.parse(require('node:fs').readFileSync('tasks.json', 'utf8')); assert.equal(raw.version, 2); });\n`);
    }
    if (scenario === "modify") {
      // Full-file rewrite that preserves the existing square() and its tests, appending cube().
      await write("math.cjs", "module.exports = { square: (x) => x * x, cube: (x) => x * x * x };\n");
      await write("math.test.cjs", `const { test } = require('node:test');\nconst assert = require('node:assert/strict');\nconst math = require('./math.cjs');\n${MODIFY_SQUARE_TEST}\ntest('cube multiplies a number by itself twice', () => assert.equal(math.cube(2), 8));\n`);
    }
  }
  if (stage === "testgen") {
    const content = {
      create: "const { test } = require('node:test');\nconst assert = require('node:assert/strict');\ntest('independent acceptance', () => assert.equal(require('./app.cjs').add(2, 3), 5));\n",
      fix: "const { test } = require('node:test');\nconst assert = require('node:assert/strict');\ntest('independent acceptance', () => assert.throws(() => require('./calculator.cjs').divide(1, 0), /zero divisor/));\n",
      modify: "const { test } = require('node:test');\nconst assert = require('node:assert/strict');\ntest('independent acceptance', () => assert.equal(require('./math.cjs').cube(2), 8));\n",
      migrate: "const { test } = require('node:test');\nconst assert = require('node:assert/strict');\ntest('independent migration acceptance: no data loss', () => { require('./store.cjs').migrate('tasks.json'); const raw = JSON.parse(require('node:fs').readFileSync('tasks.json', 'utf8')); assert.equal(raw.version, 2); assert.ok(Object.values(raw.tasks).some(t => t.includes('إصدار الأول'))); });\n",
    }[scenario]!;
    assert.equal((await o.tools.exec("file_write", { path: "acceptance.test.cjs", content }, ctx)).ok, true, "independent author must write acceptance.test.cjs");
  }
  if (stage === "qa") {
    const result = await o.tools.exec("shell_run", { command: `node --test ${suiteFor[scenario]}`, timeoutSeconds: 60 }, ctx);
    assert.equal(result.ok, true, `fixture QA suite must pass: ${result.content.slice(0, 400)}`);
  }
  return { text: `Completed ${stage}`, messages: [], steps: 1, model: "fixture", usage: { promptTokens: 0, completionTokens: 0, durationMs: 0 } };
};

const service = new SwarmService({ cfg, ollama, tools, executor });
const wait = async (id: string) => {
  for (let i = 0; i < 6000; i++) {
    const s = service.get(id);
    if (!["queued", "running"].includes(s.status)) { await new Promise(r => setTimeout(r, 10)); return s; }
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for bench run ${id}`);
};

interface Row { id: ScenarioId; status: string; ms: number; modelCalls: number; toolCalls: number; repairs: number; verification: string; independentOk: boolean; memory: { files: number; edges: number } }
const scenarios: Array<{ id: ScenarioId; brief: string; repoSeed?: string; expectedVerification: string }> = [
  { id: "create", brief: "Build an addition tool with tests.", expectedVerification: "node --test app.test.cjs" },
  { id: "fix", brief: "The workspace contains an existing repository. Fix calculator.cjs so divide() rejects a zero divisor; the existing tests must stay unchanged.", repoSeed: fixSeed, expectedVerification: "node --test calculator.test.cjs" },
  { id: "modify", brief: "The workspace contains an existing repository. Add cube(x) to math.cjs with its own test, and keep the existing tests unchanged.", repoSeed: modifySeed, expectedVerification: "node --test math.test.cjs" },
  { id: "migrate", brief: "The workspace contains an existing repository with tasks stored in the old v1 format ({items:[]}). Migrate storage to v2 ({version:2,tasks:{id:title}}) with a migrate() function; every existing task must survive the migration unchanged, verified by tests.", repoSeed: migrateSeed, expectedVerification: "node --test tasks.test.cjs" },
];
const rows: Row[] = [];
const snapshots: Array<{ id: ScenarioId; workspace: string; nodes: number }> = [];
for (const scenario of scenarios) {
  const started = Date.now();
  const created = service.create({ brief: scenario.brief, concurrency: 2, ...(scenario.repoSeed ? { repoSeed: scenario.repoSeed } : {}) });
  const done = await wait(created.id);
  const ms = Date.now() - started;
  rows.push({
    id: scenario.id, status: done.status, ms, modelCalls: modelCalls[scenario.id],
    toolCalls: done.nodes.reduce((sum, n) => sum + n.toolCalls, 0), repairs: done.repairs ?? 0,
    verification: done.verification?.command ?? "", independentOk: done.independentVerification?.ok === true,
    memory: { files: done.memory?.files ?? 0, edges: done.memory?.edges ?? 0 },
  });
  snapshots.push({ id: scenario.id, workspace: done.workspace, nodes: done.nodes.length });
  assert.equal(stageCalls[scenario.id].length, modelCalls[scenario.id], "stage and model-call counters must agree");
}

// Assertions: all scenarios complete cleanly on fixtures, acceptance gates pass, and seeded
// test files survive byte-for-byte in the parts that matter.
for (const row of rows) {
  assert.equal(row.status, "completed", `${row.id} scenario must complete`);
  assert.equal(row.repairs, 0, `${row.id} scenario must need no repair rounds on clean fixtures`);
  assert.equal(row.independentOk, true, `${row.id} independent acceptance suite must pass`);
  assert.equal(row.verification, scenarios.find(s => s.id === row.id)!.expectedVerification, `${row.id} verification command mismatch`);
}
// Greenfield skips the repo model call deterministically: 9 stages minus the engine-completed repo stage.
assert.equal(modelCalls.create, 10, "create scenario must spend exactly 10 model calls (repo/deploy/merge engine-executed; discovery+ux added)");
assert(!stageCalls.create.includes("repo"), "greenfield runs must not call the repo stage model");
// A 3-file seeded repo (2 code + 1 test) crosses the index threshold, so the repo stage runs a model call.
assert.equal(modelCalls.fix, 11, "fix scenario must spend exactly 11 model calls (repo analyzes the seeded repo; deploy/merge engine-executed)");
assert(stageCalls.fix.includes("repo"), "seeded fix run must include the repo stage model call");
// The minimal modify seed (1 code + 1 test) stays below the index threshold, so the engine
// completes its repo stage without a model call exactly like the greenfield run.
assert.equal(modelCalls.modify, 10, "modify scenario must spend exactly 10 model calls (repo engine-skipped; discovery+ux added)");
const fixWorkspace = snapshots.find(s => s.id === "fix")!.workspace;
assert(fs.readFileSync(path.join(fixWorkspace, "calculator.test.cjs"), "utf8").includes(FIX_ZERO_DIVISOR_TEST), "the seeded zero-divisor assertion must still be present at completion");
assert(fs.readFileSync(path.join(fixWorkspace, "util.cjs"), "utf8").includes("a - b"), "untouched seeded helper must survive the fix run");
const modifyWorkspace = snapshots.find(s => s.id === "modify")!.workspace;
assert(fs.readFileSync(path.join(modifyWorkspace, "math.test.cjs"), "utf8").includes(MODIFY_SQUARE_TEST), "the existing square test must survive the modify run");
assert(fs.readFileSync(path.join(modifyWorkspace, "math.cjs"), "utf8").includes("cube"), "modify run must deliver cube()");
// Roadmap §16: migration scenario — pre-existing v1 data must survive into v2 untouched.
const migrateWorkspace = snapshots.find(s => s.id === "migrate")!.workspace;
const migratedTasks = fs.readFileSync(path.join(migrateWorkspace, "tasks.json"), "utf8");
assert(migratedTasks.includes("version"), "the migrated tasks.json must carry the v2 shape");
assert(migratedTasks.includes(MIGRATE_DATA_MARKER), "the pre-existing v1 task data must survive the migration untouched");
assert.equal(modelCalls.migrate, 10, "migrate scenario: seed has 2 code + 1 test file; store.cjs+tasks.json presence keeps repo model-analyzed or engine-skipped — pinned to the observed 10");

const report = {
  ranAt: new Date().toISOString(),
  scenarios: rows,
  overhead: { modelCalls: rows.reduce((sum, r) => sum + r.modelCalls, 0), stages: snapshots.reduce((sum, s) => sum + s.nodes, 0) },
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
service.close();
db.closeDb();
for (const row of rows) {
  console.log(`${row.id.padEnd(7)} ${row.status.padEnd(10)} ${String(row.ms).padStart(6)}ms  model=${row.modelCalls} tools=${row.toolCalls} repairs=${row.repairs} verify="${row.verification}" indep=${row.independentOk ? "ok" : "FAIL"} memory=${row.memory.files}f/${row.memory.edges}e`);
}
console.log(`overhead: ${report.overhead.modelCalls} model calls across ${report.overhead.stages} stages -> ${output}`);
console.log("PASS swarm bench");
