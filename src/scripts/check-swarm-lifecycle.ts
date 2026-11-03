/** BUILD_SPEC §12: fixture-driven end-to-end check of the lifecycle features (no model, no network).
 * Scenario A: effort auto routes a small brief to the single-agent path.
 * Scenario B: intake → clarify, EARS gate repair, task graph + test-first guard, plan revision then
 * approval, two-stage review, living spec, AGENTS.md, CI workflow, checkpoints, rollback, launch refusal. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunOptions, RunResult } from "../agent/loop.js";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "loam-lifecycle-"));
process.env.LOAM_DATA_DIR = temporary;
const { loadConfig } = await import("../config.js");
const { SwarmService } = await import("../swarm/service.js");
const { ToolRegistry } = await import("../tools/registry.js");
const { fileTools } = await import("../tools/files.js");
const { shellTools } = await import("../tools/shell.js");
const { OllamaClient } = await import("../ollama.js");
const db = await import("../server/db.js");
const cfg = loadConfig(); cfg.workspace = path.join(temporary, "workspace"); fs.mkdirSync(cfg.workspace);
cfg.vision = { ...cfg.vision, enabled: false };
const tools = new ToolRegistry(); tools.registerAll(fileTools); tools.registerAll(shellTools);
const ollama = new OllamaClient(cfg.ollamaUrl);

const calls: string[] = [];
const prompts = new Map<string, string[]>();
const attempts = new Map<string, number>();
const ok = (text: string, i: number): RunResult => ({ text, messages: [], steps: 1, model: "fixture", usage: { promptTokens: 100 + i, completionTokens: 10 + i, durationMs: 1000 + i } });
const VALID_SPEC = "REQ-1: The library shall export add(a, b) returning the sum.\nVerify: test/lib.test.js add\nREQ-2: The library shall export format(n) returning the number with two decimals.\nVerify: test/format.test.js format\nREQ-3: If add receives a non-number, then the library shall throw a TypeError.\nVerify: test/lib.test.js rejects";
const ARCH = "Two modules: lib.js and format.js.\nDECISION: use node:test because it needs no dependencies.\nVerification command: `node --test`\nTASKS_JSON\n```json\n" + JSON.stringify({ tasks: [
  { id: "T1", title: "add()", files: ["lib.js"], tests: ["test/lib.test.js"], dependsOn: [], requirements: ["REQ-1", "REQ-3"], tdd: true },
  { id: "T2", title: "format()", files: ["format.js"], tests: ["test/format.test.js"], dependsOn: [], requirements: ["REQ-2"], tdd: true },
] }) + "\n```";
let planFeedbackSeen = false;

const executor = async (o: RunOptions): Promise<RunResult> => {
  const stage = /Stage: ([\w-]+)\./.exec(o.systemOverride ?? "")![1]!;
  calls.push(stage); const i = calls.length;
  const attempt = (attempts.get(stage) ?? 0) + 1; attempts.set(stage, attempt);
  prompts.set(stage, [...(prompts.get(stage) ?? []), `${o.systemOverride}\n---\n${o.prompt}`]);
  const ctx = { cfg: o.cfg, workspace: o.cfg.workspace, emit: o.emit, signal: o.signal, taskId: o.taskId };
  const exec = (name: string, args: Record<string, unknown>) => o.tools.exec(name, args, ctx);
  assert.ok(!(o.systemOverride ?? "").includes("undefined"), `${stage}: stage instruction must exist`);
  switch (stage) {
    case "solo": {
      await exec("file_write", { path: "slug.js", content: "module.exports = s => s.toLowerCase().trim().replace(/\\s+/g, '-');\n" });
      await exec("file_write", { path: "slug.test.js", content: "const test=require('node:test');const assert=require('node:assert/strict');test('slug',()=>assert.equal(require('./slug.js')(' A B '),'a-b'));\n" });
      assert.equal((await exec("shell_run", { command: "node --test slug.test.js", timeoutSeconds: 30 })).ok, true);
      return ok("Solo delivered slug.js with a passing test.", i);
    }
    case "intake": return ok('```json\n{"verdict":"clarify","summary":"A tiny number library.","questions":[{"prompt":"Which number format locale?","options":["en","ar"]}],"risks":[],"assumptions":["No dependencies"]}\n```', i);
    case "discovery":
      assert.match(o.prompt ?? "", /User clarifications from intake/); assert.match(o.prompt ?? "", /→ en/);
      return ok("Users: developers. US-1: add numbers (AC-1). US-2: format numbers (AC-2). US-3: reject bad input (AC-3). Release roadmap: V1 add+format.", i);
    case "ux": return ok("Information architecture: library API only. RTL not applicable but documented. States: empty input, loading n/a, error thrown. Keyboard/accessibility: n/a for a library.", i);
    case "requirements": {
      if (attempt === 1) return ok("REQ-1: Make it good.\nREQ-2: It should be fast.", i);
      if (/Plan revision requested by the user/.test(o.prompt ?? "")) { assert.match(o.prompt ?? "", /two decimals please/); planFeedbackSeen = true; }
      return ok(VALID_SPEC, i);
    }
    case "architecture": assert.match(o.prompt ?? "", /Living requirements spec/); assert.match(o.systemOverride ?? "", /TASKS_JSON/); return ok(ARCH, i);
    case "research": return ok("Feasible: pure Node.js, no packages.", i);
    case "task-t1": case "task-t2": {
      const [code, test, other] = stage === "task-t1" ? ["lib.js", "test/lib.test.js", "format.js"] : ["format.js", "test/format.test.js", "lib.js"];
      const codeText = stage === "task-t1" ? "module.exports = (a, b) => { if (typeof a !== 'number' || typeof b !== 'number') throw new TypeError('numbers'); return a + b; };\n" : "module.exports = n => n.toFixed(2);\n";
      const testText = stage === "task-t1"
        ? "const test=require('node:test');const assert=require('node:assert/strict');test('REQ-1 add',()=>assert.equal(require('../lib.js')(2,3),5));test('REQ-3 rejects',()=>assert.throws(()=>require('../lib.js')('x',1),TypeError));\n"
        : "const test=require('node:test');const assert=require('node:assert/strict');test('REQ-2 format',()=>assert.equal(require('../format.js')(1),'1.00'));\n";
      assert.match(o.systemOverride ?? "", new RegExp(`You implement ONE planned task: ${stage === "task-t1" ? "T1" : "T2"}`));
      assert.match(o.prompt ?? "", /Shared decision log/); assert.match(o.prompt ?? "", /use node:test/);
      assert.ok(!(o.prompt ?? "").includes("${decisionLog}"), "template-literal bug must be fixed");
      const foreign = await exec("file_write", { path: other, content: "x" });
      assert.equal(foreign.ok, false); assert.match(foreign.content, /may only write its own paths/);
      const testExists = fs.existsSync(path.join(o.cfg.workspace ?? "", test));
      if (!testExists) {
        const early = await exec("file_write", { path: code, content: codeText });
        assert.equal(early.ok, false); assert.match(early.content, /TEST FIRST/);
        assert.equal((await exec("file_write", { path: test, content: testText })).ok, true);
      } else {
        const early = await exec("file_write", { path: code, content: codeText });
        assert.equal(early.ok, false); assert.match(early.content, /RUN THE TEST FIRST/);
      }
      await exec("shell_run", { command: `node --test ${test}`, timeoutSeconds: 30 });
      assert.equal((await exec("file_write", { path: code, content: codeText })).ok, true);
      // Fixture fault: the first T2 attempt "forgets" the final green run, so the TDD gate must fire.
      if (stage === "task-t2" && attempt === 1) return ok("T2 done (without the final run).", i);
      assert.equal((await exec("shell_run", { command: `node --test ${test}`, timeoutSeconds: 30 })).ok, true);
      return ok(`${stage} delivered ${code} test-first.`, i);
    }
    case "review-spec": assert.match(o.prompt ?? "", /Living requirements spec/); return ok("REQ-1 lib.js test/lib.test.js; REQ-2 format.js; REQ-3 lib.js.\nREVIEW_PASS", i);
    case "review-quality": return ok("No blocking issues.\nREVIEW_PASS", i);
    case "testgen":
      assert.equal((await exec("file_write", { path: "acceptance.test.cjs", content: "const test=require('node:test');const assert=require('node:assert/strict');test('independent acceptance',()=>{assert.equal(require('./lib.js')(1,1),2);assert.equal(require('./format.js')(2),'2.00');});\n" })).ok, true);
      return ok("Independent acceptance authored.", i);
    case "qa": assert.equal((await exec("shell_run", { command: "node --test", timeoutSeconds: 60 })).ok, true); return ok("All tests pass.", i);
    case "delivery": return ok("Delivered lib.js and format.js with tests.", i);
    default: throw new Error(`unexpected stage ${stage}`);
  }
};

const service = new SwarmService({ cfg, ollama, tools, executor, dataDir: path.join(temporary, "swarm") });
const settle = async (id: string, until: (s: ReturnType<typeof service.get>) => boolean) => {
  for (let n = 0; n < 6000; n++) { const s = service.get(id); if (until(s)) return s; await new Promise(r => setTimeout(r, 10)); }
  throw new Error(`timed out: ${JSON.stringify(service.get(id).nodes.map(x => [x.id, x.status]))}`);
};
const idle = (s: ReturnType<typeof service.get>) => !["queued", "running"].includes(s.status);

// Scenario A — effort routing.
const small = service.create({ brief: "Write slug.js exporting slug(text) with a node:test test; verify with node --test slug.test.js.", effort: "auto" });
assert.equal(small.effort?.effort, "solo");
assert.deepEqual(small.nodes.map(x => x.id), ["solo", "deploy", "merge"]);
const smallDone = await settle(small.id, idle);
assert.equal(smallDone.status, "completed", smallDone.error);
assert.equal(smallDone.usage?.modelCalls, 1, "a small brief costs one model call");

// Scenario B — the full lifecycle.
const run = service.create({ brief: "A tiny number library: add(a,b) and format(n) with node:test tests.", track: "library", effort: "full", intake: "on", approval: "required", review: "two-stage", taskGraph: true, spec: "ears", projectGuide: true });
assert.deepEqual(run.nodes.map(x => x.id), ["intake", "discovery", "ux", "requirements", "architecture", "research", "repo", "approval", "implementation", "review-spec", "review-quality", "testgen", "qa", "delivery", "deploy", "merge"]);
let s = await settle(run.id, idle);
assert.equal(s.status, "interrupted"); assert.equal(s.pendingGate, "intake");
assert.throws(() => service.resume(run.id), /waiting for the user/);
assert.throws(() => service.approve(run.id, { decision: "approve" }), /no plan waiting/);
assert.throws(() => service.clarify(run.id, { answers: {} }), /Answer at least one/);
service.clarify(run.id, { answers: { q1: "en" } });
s = await settle(run.id, idle);
assert.equal(s.status, "interrupted", s.error); assert.equal(s.pendingGate, "approval");
assert.ok(s.events.some(e => e.message.includes("Requirements gate (EARS)")), "invalid requirements must be rejected and repaired");
assert.ok(s.nodes.some(x => x.id === "task-t1") && s.nodes.some(x => x.id === "task-t2") && !s.nodes.some(x => x.id === "implementation"));
assert.equal(s.approval?.summary.tasks.length, 2);
assert.equal(s.approval?.summary.verificationCommand, "node --test");
service.approve(run.id, { decision: "revise", feedback: "two decimals please" });
s = await settle(run.id, idle);
assert.equal(s.pendingGate, "approval"); assert.equal(s.approval?.round, 2); assert.ok(planFeedbackSeen, "the plan feedback must reach requirements");
service.approve(run.id, { decision: "approve" });
s = await settle(run.id, idle);
assert.equal(s.status, "completed", `${s.error} ${JSON.stringify(s.nodes.map(x => [x.id, x.status]))}`);
assert.ok(s.events.some(e => e.message.includes("Test-first gate for task T2")), "the TDD gate must fire for the forgotten green run");
assert.equal(calls.filter(c => c === "task-t1").length, 1, "a task-local gate re-runs only the failed task");
assert.equal(calls.filter(c => c === "task-t2").length, 2);
assert.ok((s.tdd?.["task-t1"]?.blockedWrites ?? 0) >= 1);
assert.equal(s.tdd?.["task-t2"]?.greenAfterLastCode, true);
const ws = s.workspace;
assert.ok(fs.existsSync(path.join(ws, ".loam/specs/requirements.json")));
assert.equal(s.spec?.requirements, 3);
assert.deepEqual(s.spec?.coverage?.uncovered, [], "every REQ is referenced by a test");
const agents = fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8");
assert.match(agents, /loam:project-guide:begin/); assert.match(agents, /node --test/);
assert.ok(fs.existsSync(path.join(ws, ".github/workflows/ci.yml")));
assert.match(fs.readFileSync(path.join(ws, ".github/workflows/ci.yml"), "utf8"), /on: \[push, pull_request\]/);
assert.ok((s.checkpoints?.length ?? 0) >= 10, `checkpoints: ${s.checkpoints?.length}`);
assert.ok(s.events.filter(e => e.type === "approval_required").length === 2);
const cps = service.checkpointsOf(run.id);
assert.ok(cps.checkpoints.some(c => c.stage === "architecture"));
let rollbackNote: string;
try { const r = await service.rollback(run.id, { stage: "architecture" }); rollbackNote = `branch ${r.branch}`; assert.match(r.branch, /^rollback\//); }
catch (error) { rollbackNote = `refused: ${(error as Error).message}`; assert.match((error as Error).message, /uncommitted changes/); }
await assert.rejects(service.launchCloud(run.id, { target: "vercel", confirm: true }, () => "token"), /No static output/);
await assert.rejects(service.launchCloud(run.id, { target: "vercel" }, () => "token"), /confirm:true/);
const order = calls.join(" ");
service.close(); db.closeDb();
console.log(JSON.stringify({ scenarioA: { nodes: smallDone.nodes.map(x => x.id), modelCalls: smallDone.usage?.modelCalls }, scenarioB: { modelCalls: s.usage?.modelCalls, repairs: s.repairs, checkpoints: s.checkpoints?.length, rollback: rollbackNote, tdd: s.tdd }, calls: order }, null, 1));
console.log("PASS swarm lifecycle: effort routing, intake pause/clarify, EARS gate repair, task graph with owned files, test-first guard + TDD gate repair, plan revision + approval, two-stage review, living spec + coverage, AGENTS.md, CI workflow, checkpoints, rollback, launch refusal");
process.exit(0);
