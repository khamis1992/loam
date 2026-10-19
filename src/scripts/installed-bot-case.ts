import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseAppContract } from "../agent/appVerification.js";
import { canonicalRows } from "../agent/sqliteChecks.js";
import { canonicalApiJson } from "../agent/apiChecks.js";

/** Real installed task runner; records failed runs as well as passing evidence. */
export async function runInstalledCase(o: { title: string; prompt: string; contract: unknown; output: string; taskId?: string; observeTaskId?: string; probe: (workspace: string) => Promise<unknown> }) {
  const contract = parseAppContract(JSON.stringify(o.contract));
  const base = "http://127.0.0.1:3939";
  const queue = await (await fetch(`${base}/api/queue`)).json() as { actives: string[]; queued: unknown[] };
  if (!o.observeTaskId) assert.equal(queue.actives.length + queue.queued.length, 0, "Wait for existing tasks instead of mixing benchmark queues");
  const capabilities = await (await fetch(`${base}/api/bot/capabilities`)).json() as { revision: number; acceptanceIntegrity: {independentMandatoryForApplications:boolean}; applicationVerification:{visualReviewCoverage?:{allCapturedScreenshots:boolean}} };
  assert.ok(capabilities.acceptanceIntegrity.independentMandatoryForApplications, "Installed independent verification is required");
  assert.ok(capabilities.applicationVerification.visualReviewCoverage?.allCapturedScreenshots, "Install full screenshot review before new evaluations");
  assert.ok(capabilities.revision >= 7);
  if (contract.scenarios.some(s => s.apiChecks)) assert.ok(capabilities.revision >= 8, "Direct API acceptance requires installed capability revision 8");
  if (contract.scenarios.some(s => s.apiChecks?.some(g => g.requests.some(r => Object.hasOwn(r, "expectedJson"))))) assert.ok(capabilities.revision >= 9, "JSON response assertions require capability revision 9");
  if (contract.scenarios.some(s => s.steps.some(step => step.action === "restartBackend"))) assert.ok(capabilities.revision >= 10, "Backend process restart requires capability revision 10");
  const started = Date.now(), events: Array<Record<string, any>> = [];
  const output = fs.existsSync(o.output) ? o.output.replace(/\.json$/, `-${started}.json`) : o.output;
  assert.ok(!fs.existsSync(output), "Do not overwrite previous evaluation evidence");
  assert.ok(process.env.LOCALAPPDATA);
  const runtimePath=path.join(process.env.LOCALAPPDATA,'Programs/loam/resources/app/dist/server.cjs');
  const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
  const evidence: Record<string, any> = { startedAt: new Date().toISOString(), capabilities, request: o.prompt, contract, events, continuationOf: o.taskId, pass: false, provenance:{runtimePath,runtimeSha256:hash(fs.readFileSync(runtimePath)),promptSha256:hash(o.prompt),contractSha256:hash(JSON.stringify(contract)),costUsd:null} };
  const save = () => { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify({ ...evidence, elapsedMs: Date.now() - started }, null, 2)); };
  console.log(`Evidence: ${output}`);
  save();
  try {
    if (o.observeTaskId) {
      evidence.taskId = o.observeTaskId;
      evidence.observationMode = "reattached-to-persisted-task-events-after-interruption";
      const deadline = Date.now() + 1_800_000;
      for (;;) {
        const response = await fetch(`${base}/api/tasks/${encodeURIComponent(o.observeTaskId)}`, { signal: AbortSignal.timeout(10_000) });
        assert.ok(response.ok);
        const { task } = await response.json() as { task: { status: string; messages:Array<{role:string;content:string;at:string}>; steps: Array<{ at: string; data: Record<string, unknown> }> } };
        const turn=task.messages.findLast(m=>m.role==='user');
        assert.ok(turn&&turn.content===o.prompt,"Reattached evidence must belong to this exact latest user request");
        const turnAt=Date.parse(turn.at);assert.ok(Number.isFinite(turnAt));
        events.splice(0, events.length, ...task.steps.filter(step=>Date.parse(step.at)>=turnAt).map(step => ({ ...step.data, observedAt: step.at })));
        evidence.lastPersistedStatus = task.status;
        save();
        if (!["queued", "running"].includes(task.status)) break;
        if (Date.now() >= deadline) throw new Error("Observation deadline exceeded; task must be inspected separately, not restarted");
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    } else {
    const response = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...(o.taskId ? { taskId: o.taskId } : {}), prompt: o.prompt, title: o.title, mode: "build", workMode: "loam", model: "glm-5.3-flash:cloud" }), signal: AbortSignal.timeout(1_800_000) });
    assert.ok(response.ok && response.body);
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "";
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const line = block.split("\n").find(l => l.startsWith("data: ")); if (!line) continue;
        const e = { ...JSON.parse(line.slice(6)), observedAt: new Date().toISOString() }; events.push(e);
        if (e.type === "task") evidence.taskId = e.taskId;
        if (["task", "verify", "revise", "error", "done"].includes(e.type)) { console.log(JSON.stringify(e)); save(); }
      }
    }
    }
    assert.ok(evidence.taskId);
    if (o.taskId) assert.equal(evidence.taskId,o.taskId,"continuation must remain in the original task");
    const details = await (await fetch(`${base}/api/tasks/${encodeURIComponent(evidence.taskId)}`)).json() as { task: { status: string; workspace: string } };
    evidence.task = details.task; save(); assert.equal(details.task.status, "done");
    const verified = events.findLastIndex(e => e.type === "verify" && e.verdict === "pass");
    assert.ok(verified >= 0 && events.findIndex(e => e.type === "done") > verified && events.findIndex(e => e.type === "assistant_message") > verified);
    assert.ok(!events.slice(0, verified).some(e => e.type === "assistant_token"));
    assert.ok(events.filter(e => e.type === "tool_call").every(e => ["file_write", "file_read", "file_edit", "file_stat", "file_list", "file_search", "file_mkdir", "file_view_image"].includes(e.name)));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(details.task.workspace, "app-verification.json"), "utf8")), contract);
    const verification = events.findLast(e => e.type === "tool_result" && e.name === "application_verification" && e.ok);
    const reportPath = String(verification?.summary).match(/\nReport: (.+)$/)?.[1]?.trim(); assert.ok(reportPath);
    const relative = path.relative(path.join(details.task.workspace, ".verification"), path.resolve(reportPath));
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8")); evidence.report = report;
    assert.ok(report.pass && report.visual?.verdict?.verdict === "pass");
    const baselineIndex=events.findLastIndex(e=>e.type==='tool_result'&&e.name==='application_verification'&&e.ok);
    const independentIndex=events.findLastIndex(e=>e.type==='tool_result'&&e.name==='independent_application_verification'&&e.ok);
    assert.ok(baselineIndex>=0&&independentIndex>baselineIndex&&verified>independentIndex);
    const independentPath=String(events[independentIndex]!.summary).match(/\nReport: (.+)$/)?.[1]?.trim();assert.ok(independentPath);
    const independentRelative=path.relative(path.join(details.task.workspace,'.verification'),path.resolve(independentPath));
    assert.ok(independentRelative&&!independentRelative.startsWith('..')&&!path.isAbsolute(independentRelative));
    const independent=JSON.parse(fs.readFileSync(independentPath,'utf8'));evidence.independentReport=independent;
    assert.equal(independent.contractOrigin,'runtime-owned-independent');assert.ok(independent.executedContract.scenarios.length<=4);
    for(const r of [report,independent]){assert.ok(r.pass&&r.checks.length>=2&&r.checks.every((c:any)=>c.pass));assert.equal(r.visual?.verdict?.verdict,'pass');assert.equal(r.visual.complete,true);assert.deepEqual(r.visual.reviewedScreenshots,r.screenshots);}
    assert.ok(report.sourceHashes&&Object.keys(report.sourceHashes).length);
    for(const [file,fingerprint] of Object.entries(report.sourceHashes))assert.equal(independent.sourceHashes?.[file],fingerprint);
    assert.equal(report.checks.length, contract.scenarios.length * 2);
    for (const viewport of ["desktop", "mobile"]) for (const scenario of contract.scenarios) {
      const matched = report.checks.filter((c: any) => c.viewport === viewport && c.scenario === scenario.name);
      assert.equal(matched.length, 1); assert.equal(matched[0].pass, true);
      const restartCount = scenario.steps.filter(step => step.action === "restartBackend").length;
      if (restartCount) {
        const restarts = matched[0].restarts as Array<{ previousPid: number; currentPid: number }>;
        assert.equal(restarts?.length, restartCount, "Every requested restart must have process replacement evidence");
        for (const r of restarts) assert.ok(Number.isInteger(r.previousPid) && r.previousPid > 1 && Number.isInteger(r.currentPid) && r.currentPid > 1 && r.previousPid !== r.currentPid);
      }
      if (scenario.apiChecks) {
        const api = matched[0].api as Array<{ group: number; method: string; path: string; status?: number; error?: string; responseJson?: unknown }>;
        assert.ok(Array.isArray(api));
        assert.equal(api.length, scenario.apiChecks.reduce((sum, group) => sum + group.requests.length, 0));
        scenario.apiChecks.forEach((group, index) => {
          const responses = api.filter(r => r.group === index);
          assert.deepEqual(responses.map(r => [r.method, r.path]), group.requests.map(r => [r.method, r.path]));
          assert.ok(responses.every(r => !r.error && Number.isInteger(r.status)));
          assert.deepEqual(responses.map(r => r.status).sort(), [...group.statuses].sort());
          group.requests.forEach((request, i) => {
            if (Object.hasOwn(request, "expectedJson")) assert.equal(canonicalApiJson(responses[i]?.responseJson), canonicalApiJson(request.expectedJson));
          });
        });
      }
      for (const expected of scenario.sqliteChecks ?? []) {
        const observed = matched[0].databases?.find((d: any) => d.database === expected.database && d.table === expected.table && JSON.stringify(d.columns) === JSON.stringify(expected.columns));
        assert.ok(observed); assert.equal(canonicalRows(observed.rows), canonicalRows(expected.rows));
      }
    }
    evidence.independentProbe = await o.probe(details.task.workspace);
    evidence.provenance.runtimeSha256After=hash(fs.readFileSync(runtimePath));
    assert.equal(evidence.provenance.runtimeSha256After,evidence.provenance.runtimeSha256,"Installed build changed during trial");
    evidence.pass = true; console.log("PASS installed task, browser/vision/SQLite acceptance and independent probe");
  } catch (error) { evidence.error = String(error); process.exitCode = 1; console.error(String(error)); }
  finally { save(); }
}
