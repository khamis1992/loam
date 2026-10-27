/** Opt-in live comparison (roadmap §20): one fused single agent vs the full swarm on the same brief and model. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { evaluateThresholds, median, type MeasureSample, type TaskSize } from "../swarm/measure.js";

// Shared brief — a compact version of the live check's todo service. Both arms build exactly this.
const brief = "Build a small Node.js task-list web app with no external packages: server.cjs serving GET /tasks (JSON array) and GET / (Arabic RTL HTML with <input id=new-task-title>, <button id=add-task>, <ul id=tasks>) on process.env.PORT||3000, only listening when run directly, plus POST /tasks {title} so the UI works (creates the task and refreshes the list; title validated non-empty and at most 200 characters, otherwise 400), plus tasks.test.cjs with node:test covering GET /tasks empty and the store; run node --test tasks.test.cjs as verification. Keep reports under 120 words.";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const output = path.join(repoRoot, "output", "verification", "swarm-compare.json");
const source = JSON.parse(fs.readFileSync(path.join(repoRoot, "config.json"), "utf8")) as { model?: string; ollamaUrl?: string };
const model = process.env.LOAM_SWARM_MODEL || source.model;
assert.ok(model, "config.json must define a model for the comparison arms");

// BUILD_SPEC §12.3: "swarm" is the BEFORE arm (effort full, legacy options), "auto" the AFTER arm
// (effort auto + recommended profile, approval auto so nothing pauses), "solo" the reference.
type ArmId = "swarm" | "auto" | "solo";
interface ArmPlan { arm: ArmId; create: Record<string, unknown> & { model: string; brief: string } }
const RECOMMENDED = { effort: "auto", intake: "off", approval: "auto", review: "two-stage", taskGraph: true, spec: "ears", projectGuide: true, webResearch: false, visualGate: "advisory" };
const armIds = (process.env.LOAM_SWARM_COMPARE_ARMS ?? "swarm,solo").split(",").map(a => a.trim()).filter((a): a is ArmId => a === "swarm" || a === "auto" || a === "solo");
const armPlan = (arm: ArmId, taskBrief: string): ArmPlan => arm === "swarm"
  ? { arm, create: { model, concurrency: 2, maxSteps: 30, effort: "full", brief: taskBrief } }
  : arm === "auto" ? { arm, create: { model, concurrency: 2, maxSteps: 30, ...RECOMMENDED, brief: taskBrief } }
  : { arm, create: { model, concurrency: 1, maxSteps: 30, singleAgent: true, brief: taskBrief } };
const plannedArms: ArmPlan[] = armIds.map(arm => armPlan(arm, brief));
// Optional fixed task set (LOAM_SWARM_TASKSET=bench/swarm-taskset.json); default: the single compare brief.
interface TaskDef { id: string; size: TaskSize; brief: string; seed?: string }
const tasks: TaskDef[] = process.env.LOAM_SWARM_TASKSET
  ? (JSON.parse(fs.readFileSync(path.resolve(repoRoot, process.env.LOAM_SWARM_TASKSET), "utf8")) as { tasks: TaskDef[] }).tasks.map(t => ({ ...t, brief: t.brief === "@compare" ? brief : t.brief }))
  : [{ id: "S1", size: "small", brief }];
const metricNames = ["status", "durationMs", "tokens", "modelCalls", "repairs", "verificationCommand", "deployType"];

const dryRun = process.argv.includes("--dry-run");

const runLive = async (): Promise<void> => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-swarm-compare-"));
  const probe = http.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as import("node:net").AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const config = path.join(temp, "config.json");
  fs.writeFileSync(config, JSON.stringify({ model, fallbackModel: model, ollamaUrl: source.ollamaUrl,
    workspace: path.join(temp, "workspace"), agent: { requestTimeoutMs: 300000 },
    computerUse: { enabled: false }, memory: { enabled: false }, screen: { enabled: false },
    selfImprove: { enabled: false }, mcpServers: {}, policy: { networkEnabled: false, allowOutsideWorkspaceRead: false },
  }));
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: repoRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LOAM_CONFIG: config, LOAM_PORT: String(port), LOAM_DATA_DIR: path.join(temp, "data"), LOAM_EVALS_DIR: path.join(temp, "evals"), LOAM_SKILLS_DIR: path.join(temp, "skills") },
  });
  let logs = ""; child.stdout.on("data", c => logs += c); child.stderr.on("data", c => logs += c);
  const base = `http://127.0.0.1:${port}`;
  const post = (url: string, body: unknown) => fetch(base + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const activeRuns: string[] = [];

  interface ArmReport {
    runId?: string; workspace?: string; status: string; error?: string;
    durationMs?: number; wallMs?: number; tokens: number; modelCalls?: number; repairs: number; effort?: string;
    verificationCommand?: string; deployType?: string; productWorks: boolean; productFailureTail?: string;
  }

  // Real product probe on a fresh probed port: boot the delivered server.cjs, wait for GET /tasks,
  // assert the Arabic RTL UI markup, then add a task through the API and see it listed.
  const probeProduct = async (workspace: string): Promise<{ productWorks: boolean; productFailureTail?: string }> => {
    if (!fs.existsSync(path.join(workspace, "server.cjs"))) return { productWorks: false, productFailureTail: "server.cjs missing from the delivered workspace" };
    const appProbe = http.createServer(); appProbe.listen(0, "127.0.0.1"); await once(appProbe, "listening");
    const appPort = (appProbe.address() as import("node:net").AddressInfo).port;
    await new Promise<void>(resolve => appProbe.close(() => resolve()));
    const app = spawn(process.execPath, ["server.cjs"], { cwd: workspace, windowsHide: true, env: { ...process.env, PORT: String(appPort) }, stdio: ["ignore", "pipe", "pipe"] });
    let appLogs = ""; app.stdout?.on("data", (chunk: string) => appLogs += chunk); app.stderr?.on("data", (chunk: string) => appLogs += chunk);
    const root = `http://127.0.0.1:${appPort}`;
    try {
      const ready = Date.now() + 20000;
      while (!(await fetch(`${root}/tasks`).then(r => r.ok).catch(() => false))) {
        if (Date.now() > ready || app.exitCode !== null) throw new Error(`delivered server did not start within 20s\n${appLogs.slice(-2000)}`);
        await new Promise(r => setTimeout(r, 200));
      }
      const html = await (await fetch(`${root}/`)).text();
      assert.ok(html.includes("new-task-title"), "GET / must serve HTML containing new-task-title");
      const added = await fetch(`${root}/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "مقارنة" }) });
      assert.ok(added.status === 200 || added.status === 201, `POST /tasks returned ${added.status}`);
      const list = await (await fetch(`${root}/tasks`)).text();
      assert.ok(list.includes("مقارنة"), "created task must appear in GET /tasks");
      return { productWorks: true };
    } catch (probeError) {
      const message = probeError instanceof Error ? probeError.message : String(probeError);
      return { productWorks: false, productFailureTail: `${message}\n${appLogs.slice(-1500)}`.trim() };
    } finally {
      if (app.exitCode === null) { const ended = once(app, "exit"); app.kill(); await ended; }
    }
  };

  const fetchRetry = async (url: string, attempts = 8): Promise<Response> => {
    for (let i = 0; i < attempts; i++) {
      try { return await fetch(url); }
      catch (error) { if (i === attempts - 1) throw error; await new Promise(r => setTimeout(r, 1000)); }
    }
    throw new Error("unreachable");
  };
  const waitForRun = async (id: string, minutes = 20): Promise<any> => {
    const deadline = Date.now() + minutes * 60000; let previous = ""; let current: any;
    do {
      current = ((await (await fetchRetry(base + "/api/swarm/runs/" + id)).json()) as any).run;
      const progress = (current.nodes ?? []).map((n: any) => `${n.id}:${n.status}`).join(" ");
      if (progress !== previous) { console.log(progress); previous = progress; }
      if (!["queued", "running"].includes(current.status)) break;
      if (Date.now() > deadline) throw new Error(`compare run ${id} exceeded ${minutes}-minute deadline`);
      await new Promise(r => setTimeout(r, 1500));
    } while (true);
    return current;
  };

  const runArm = async (plan: ArmPlan, probeLive = true): Promise<ArmReport> => {
    let runId = ""; const wallStart = Date.now();
    try {
      const response = await post("/api/swarm/runs", plan.create);
      assert.equal(response.status, 201, await response.clone().text());
      runId = ((await response.json()) as any).run.id;
      activeRuns.push(runId);
      console.log(JSON.stringify({ phase: "started", arm: plan.arm, model, runId, base, evidence: temp }));
      const run = await waitForRun(runId, 20);
      fs.writeFileSync(path.join(temp, `${plan.arm}-result.json`), JSON.stringify(run, null, 2));
      const wallMs = Date.now() - wallStart;
      // Non-compare tasks have no live probe: completed + recorded verification is the proxy.
      const product = probeLive ? await probeProduct(run.workspace) : { productWorks: run.status === "completed" && Boolean(run.verification?.command) };
      return {
        runId, workspace: run.workspace, status: run.status, error: run.error,
        durationMs: run.usage?.durationMs, wallMs, effort: run.effort?.effort,
        tokens: (run.usage?.promptTokens ?? 0) + (run.usage?.completionTokens ?? 0),
        modelCalls: run.usage?.modelCalls,
        repairs: run.repairs ?? 0,
        verificationCommand: run.verification?.command,
        deployType: run.deploy?.packageType,
        productWorks: product.productWorks,
        productFailureTail: product.productFailureTail,
      };
    } catch (armError) {
      return { runId, status: "error", tokens: 0, repairs: 0, productWorks: false,
        error: armError instanceof Error ? armError.message : String(armError) };
    }
  };

  const collected: Partial<Record<ArmId, ArmReport>> = {};
  try {
    const until = Date.now() + 20000;
    while (!(await fetch(base + "/api/swarm/runs").then(r => r.ok).catch(() => false))) {
      if (Date.now() > until || child.exitCode !== null) throw new Error(logs.slice(-3000));
      await new Promise(r => setTimeout(r, 100));
    }
    // Sequential arms: avoid provider contention so both see the same conditions.
    // Roadmap §20 wider samples: LOAM_SWARM_COMPARE_ROUNDS=N (default 1) repeats the pair and
    // aggregates mean/min per arm — from anecdote toward statistics.
    const rounds = Math.max(1, Math.min(5, Number(process.env.LOAM_SWARM_COMPARE_ROUNDS ?? "1")));
    const samples: Partial<Record<ArmId, ArmReport[]>> = Object.fromEntries(armIds.map(a => [a, []]));
    const measured: MeasureSample[] = [];
    for (let round = 1; round <= rounds; round++) {
      if (rounds > 1) console.log(`== round ${round}/${rounds} ==`);
      for (const task of tasks) for (const arm of armIds) {
        const plan = armPlan(arm, task.brief);
        if (task.seed) plan.create.repoSeed = path.resolve(repoRoot, task.seed);
        const report = await runArm(plan, task.brief === brief);
        if (task.brief === brief) samples[arm]!.push(report);
        measured.push({ task: task.id, size: task.size, arm, round, status: report.status, tokens: report.tokens, modelMs: report.durationMs ?? 0, wallMs: report.wallMs ?? 0, modelCalls: report.modelCalls ?? 0, productWorks: report.productWorks });
      }
    }
    for (const arm of armIds) collected[arm] = samples[arm]![0];
    const armsReport = Object.fromEntries(armIds.map(a => [a, collected[a]!])) as Record<ArmId, ArmReport>;
    const thresholds = evaluateThresholds(measured);
    const report = {
      ranAt: new Date().toISOString(),
      model,
      brief,
      arms: armsReport,
      rounds,
      // Every sample (the old report kept only round 1 in arms; aggregate covered the compare brief only).
      samples: measured,
      thresholds,
      medians: Object.fromEntries(armIds.map(a => { const xs = measured.filter(m => m.arm === a); return [a, { tokens: median(xs.map(m => m.tokens)), wallMs: median(xs.map(m => m.wallMs)), modelMs: median(xs.map(m => m.modelMs)) }]; })),
      aggregate: (Object.fromEntries(armIds.map(arm => {
        const list = samples[arm as ArmId]!;
        const mean = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
        return [arm, {
          n: list.length,
          completed: list.filter(r => r.status === "completed").length,
          productWorks: list.filter(r => r.productWorks).length,
          meanDurationMs: mean(list.map(r => r.durationMs ?? 0)),
          meanTokens: mean(list.map(r => r.tokens)),
          minDurationMs: Math.min(...list.map(r => r.durationMs ?? 0)),
        }];
      })) as Record<ArmId, { n: number; completed: number; productWorks: number; meanDurationMs: number; meanTokens: number; minDurationMs: number }>),
      notes: [rounds > 1 ? `${rounds} sequential rounds per arm` : "single sequential execution", "same model", "same budget"],
    };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
    console.log("arm    status       ms   tokens  modelCalls  repairs  productWorks");
    for (const id of armIds) {
      const r = armsReport[id];
      console.log(`${id.padEnd(6)} ${r.status.padEnd(10)} ${String(r.durationMs ?? "?").padStart(7)} ${String(r.tokens).padStart(7)} ${String(r.modelCalls ?? "?").padStart(10)} ${String(r.repairs).padStart(8)}  ${r.productWorks}`);
    }
    console.log(`report -> ${output}`);
    const failures: string[] = [];
    for (const c of thresholds.checks) console.log(`${c.pass ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
    for (const id of armIds) {
      const r = armsReport[id];
      if (r.status !== "completed") failures.push(`${id}: status=${r.status}${r.error ? ` error=${String(r.error).slice(0, 300)}` : ""}`);
      if (!r.productWorks) failures.push(`${id}: productWorks=false${r.productFailureTail ? ` — ${r.productFailureTail.slice(0, 400)}` : ""}`);
      if (!r.verificationCommand) failures.push(`${id}: no verification command recorded`);
    }
    if (failures.length === 0) console.log("PASS swarm compare");
    else { console.error(`FAIL swarm compare\n  ${failures.join("\n  ")}`); process.exitCode = 1; }
  } catch (error) {
    console.error(error); console.error("Evidence retained:", temp); process.exitCode = 1;
  } finally {
    for (const id of activeRuns) await post(`/api/swarm/runs/${id}/cancel`, {}).catch(() => {});
    if (child.exitCode === null) { const ended = once(child, "exit"); child.kill("SIGKILL"); await ended; }
  }
};

if (dryRun) {
  console.log(JSON.stringify({ ranAt: new Date().toISOString(), mode: "dry-run", model, output, brief,
    arms: plannedArms.map(p => ({ arm: p.arm, create: { ...p.create, brief: `<${p.create.brief.length} chars>` } })),
    tasks: tasks.map(t => ({ id: t.id, size: t.size, chars: t.brief.length })),
    metrics: metricNames, probe: ["GET /tasks 200", "GET / contains new-task-title", "POST /tasks {title:مقارنة} 200/201", "GET /tasks contains title"] }, null, 2));
  console.log("PASS swarm compare (dry-run)");
} else {
  await runLive();
}
