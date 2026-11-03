/** BUILD_SPEC §6.10 regression: after a deploy-gate repair, deploy must not start before the
 * re-run implementation AND delivery complete. Uses only pre-existing service options, so it
 * runs unchanged against the baseline (expected to FAIL there) and the patched copy. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunOptions, RunResult } from "../agent/loop.js";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "loam-repair-order-"));
process.env.LOAM_DATA_DIR = temporary;
const { loadConfig } = await import("../config.js");
const { SwarmService } = await import("../swarm/service.js");
const { ToolRegistry } = await import("../tools/registry.js");
const { fileTools } = await import("../tools/files.js");
const { shellTools } = await import("../tools/shell.js");
const { OllamaClient } = await import("../ollama.js");
const db = await import("../server/db.js");
const cfg = loadConfig(); cfg.workspace = path.join(temporary, "workspace"); fs.mkdirSync(cfg.workspace);
const tools = new ToolRegistry(); tools.registerAll(fileTools); tools.registerAll(shellTools);
let implRuns = 0;
const ok = (text: string): RunResult => ({ text, messages: [], steps: 1, model: "fixture", usage: { promptTokens: 100, completionTokens: 10, durationMs: 1000 } });
const executor = async (o: RunOptions): Promise<RunResult> => {
  const stage = /Stage: ([\w-]+)\./.exec(o.systemOverride ?? "")![1]!;
  const ctx = { cfg: o.cfg, workspace: o.cfg.workspace, emit: o.emit, signal: o.signal, taskId: o.taskId };
  const exec = (name: string, args: Record<string, unknown>) => o.tools.exec(name, args, ctx);
  if (stage === "discovery") return ok("Users: developers. US-1 (AC-1). US-2 (AC-2). US-3 (AC-3). Release roadmap: V1.");
  if (stage === "ux") return ok("Information architecture: one endpoint. RTL documented. States: empty, loading, error. Keyboard accessibility notes.");
  if (stage === "implementation") {
    implRuns++;
    // Slow re-implementation widens the race window the old reset list allowed.
    if (implRuns > 1) await new Promise(r => setTimeout(r, 1500));
    const crashing = implRuns === 1;
    await exec("file_write", { path: "server.cjs", content: crashing
      ? "const http=require('node:http');\nif (require.main===module){ const server=http.createServer((q,r)=>r.end('x')); server.listen(process.env.PORT||3000); process.exit(3); }\nmodule.exports={broken:true};\n"
      : "const http=require('node:http');\nconst app=http.createServer((q,r)=>{r.writeHead(200,{'content-type':'application/json'});r.end('{\"ok\":true}');});\nif (require.main===module) app.listen(process.env.PORT||3000);\nmodule.exports=app;\n" });
    await exec("file_write", { path: "server.test.cjs", content: "const test=require('node:test');const assert=require('node:assert/strict');test('exports',()=>assert.ok(require('./server.cjs')));\n" });
    return ok(`implementation run ${implRuns}`);
  }
  if (stage === "testgen") { await exec("file_write", { path: "acceptance.test.cjs", content: "const test=require('node:test');const assert=require('node:assert/strict');test('acceptance',()=>assert.ok(require('./server.cjs')));\n" }); return ok("acceptance authored"); }
  if (stage === "qa") { await exec("shell_run", { command: "node --test", timeoutSeconds: 60 }); return ok("pass"); }
  if (stage === "review") return ok("REVIEW_PASS");
  return ok(`${stage} done`);
};
const service = new SwarmService({ cfg, ollama: new OllamaClient(cfg.ollamaUrl), tools, executor, dataDir: path.join(temporary, "swarm") });
const run = service.create({ brief: "A JSON health endpoint service with node:test tests.", track: "api" });
let s = service.get(run.id);
for (let n = 0; n < 9000 && ["queued", "running"].includes(s.status); n++) { await new Promise(r => setTimeout(r, 10)); s = service.get(run.id); }
const ev = s.events.map((e, i) => ({ i, type: e.type, node: e.nodeId ?? "", msg: e.message }));
const failAt = ev.find(e => e.type === "deploy_failed")?.i ?? -1;
const after = ev.filter(e => e.i > failAt);
const deployStart = after.find(e => e.type === "node_started" && e.node === "deploy")?.i ?? -1;
const implDone = after.find(e => e.type === "node_completed" && e.node === "implementation")?.i ?? -1;
const deliveryDone = after.find(e => e.type === "node_completed" && e.node === "delivery")?.i ?? -1;
const summary = { status: s.status, repairs: s.repairs, implRuns, failAt, deployStartAfterRepair: deployStart, implementationCompletedAfterRepair: implDone, deliveryCompletedAfterRepair: deliveryDone };
console.log(JSON.stringify(summary));
service.close(); db.closeDb();
assert.ok(failAt >= 0, "fixture must trip the deploy gate once");
assert.ok(deployStart > implDone && implDone > 0, "deploy must start only after the re-run implementation completed");
assert.ok(deployStart > deliveryDone && deliveryDone > 0, "delivery must re-run before deploy");
assert.equal(s.status, "completed");
console.log("PASS swarm repair order");
process.exit(0);
