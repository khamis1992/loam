/** Opt-in real model/tool smoke; isolated from user tasks. No protocol fixtures. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";

const exec = async (cmd: string, args: string[], opts: { cwd: string }): Promise<string> => {
  const result = await promisify(execFile)(cmd,args,opts);
  return String(result.stdout);
};

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-swarm-live-"));
const source = JSON.parse(fs.readFileSync("config.json", "utf8"));
const model = process.env.LOAM_SWARM_MODEL || source.model;
const probe = http.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
const port = (probe.address() as import("node:net").AddressInfo).port;
await new Promise<void>(resolve => probe.close(() => resolve()));
const appProbe = http.createServer(); appProbe.listen(0, "127.0.0.1"); await once(appProbe, "listening");
const appPort = (appProbe.address() as import("node:net").AddressInfo).port;
await new Promise<void>(resolve => appProbe.close(() => resolve()));
const config = path.join(temp, "config.json");
fs.writeFileSync(config, JSON.stringify({ model, fallbackModel: model, ollamaUrl: source.ollamaUrl,
  workspace: path.join(temp, "workspace"), agent: { requestTimeoutMs: 120000 },
  computerUse: { enabled: false }, memory: { enabled: false }, screen: { enabled: false },
  selfImprove: { enabled: false }, mcpServers: {}, policy: { networkEnabled: false, allowOutsideWorkspaceRead: false },
}));
const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
  cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, LOAM_CONFIG: config, LOAM_PORT: String(port), LOAM_DATA_DIR: path.join(temp,"data"), LOAM_EVALS_DIR: path.join(temp,"evals"), LOAM_SKILLS_DIR: path.join(temp,"skills") },
});
let logs = ""; child.stdout.on("data", c => logs += c); child.stderr.on("data", c => logs += c);
const base = `http://127.0.0.1:${port}`;
const post = (url: string, body: unknown) => fetch(base+url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
let runId = "";
let seededId = "";
let app: import("node:child_process").ChildProcess | undefined;
try {
  const until = Date.now()+20000;
  while (!(await fetch(base+"/api/swarm/runs").then(r=>r.ok).catch(()=>false))) {
    if (Date.now()>until || child.exitCode!==null) throw Error(logs.slice(-3000));
    await new Promise(r=>setTimeout(r,100));
  }
  const response = await post("/api/swarm/runs", { model, concurrency: 2, maxSteps: 30,
    brief: "Build a realistic multi-file Node.js task-list application with no external packages. store.cjs: a TaskStore class persisting to tasks.json atomically (temp file + rename), validating title is a non-empty string of at most 200 characters. server.cjs: exports createTaskServer() returning an http server, and only listens when run directly (require.main === module) on process.env.PORT||3000. Routes: GET /tasks, POST /tasks {title}, POST /tasks/:id/toggle, DELETE /tasks/:id with JSON bodies and correct status codes (400 invalid title, 404 unknown id), plus GET / serving public/index.html with Content-Type text/html; charset=utf-8. public/index.html: Arabic RTL page (dir=rtl lang=ar) with <input id=new-task-title>, <button id=add-task>, and <ul id=tasks>; on load it fetches GET /tasks and renders each task as <li data-task-id=...> containing its title, a toggle button with class task-toggle and a delete button with class task-delete; toggled tasks get class done on their li; adding posts POST /tasks then refreshes the list; toggling and deleting call their endpoints then refresh. tasks.test.cjs using node:test: cover empty list, create+list, toggle, delete, 400 invalid title, persistence via a new TaskStore on the same file, and that requiring server.cjs does not start listening. README.md: run instructions (node server.cjs) and a short API table. Run node --test tasks.test.cjs as the verification command. Keep every stage report under 200 words. No npm packages, no network."
  });
  assert.equal(response.status,201,await response.clone().text());
  runId = ((await response.json()) as any).run.id;
  console.log(JSON.stringify({phase:"started",model,runId,base,evidence:temp}));
  const fetchRetry = async (url: string, attempts = 8): Promise<Response> => {
    for (let i=0;i<attempts;i++) {
      try { return await fetch(url); }
      catch (error) { if (i === attempts-1) throw error; await new Promise(r=>setTimeout(r,1000)); }
    }
    throw new Error("unreachable");
  };
  const waitForRun = async (id: string, minutes = 15): Promise<any> => {
    const deadline = Date.now()+minutes*60000; let previous=""; let current: any;
    do {
      current = ((await (await fetchRetry(base+"/api/swarm/runs/"+id)).json()) as any).run;
      const progress = current.nodes.map((n:any)=>`${n.id}:${n.status}`).join(" ");
      if (progress!==previous) { console.log(progress); previous=progress; }
      if (!["queued","running"].includes(current.status)) break;
      if (Date.now()>deadline) throw Error(`Live swarm ${id} exceeded ${minutes}-minute deadline`);
      await new Promise(r=>setTimeout(r,1500));
    } while(true);
    return current;
  };
  const run = await waitForRun(runId, 25);
  fs.writeFileSync(path.join(temp,"live-result.json"),JSON.stringify(run,null,2));
  assert.equal(run.status,"completed",JSON.stringify({error:run.error,nodes:run.nodes.map((n:any)=>({id:n.id,error:n.error}))}));
  assert.ok(run.verification?.command,"actual QA command required");
  assert.ok((run.events??[]).some((e:any)=>e.type==="git_checkpoint"),"every stage must leave a git checkpoint");
  assert.ok((run.independentTests??[]).length>0,"independent acceptance tests are required");
  assert.equal(run.independentVerification?.ok,true,`engine-executed independent suite must pass: ${String(run.independentVerification?.summary).slice(0,400)}`);
  const artifacts = ((await (await fetchRetry(base+`/api/swarm/runs/${runId}/artifacts`)).json()) as any).artifacts;
  assert.ok(artifacts.some((a:any)=>a.path==="server.cjs"));
  assert.ok(artifacts.some((a:any)=>a.path==="store.cjs"));
  assert.ok(artifacts.some((a:any)=>a.path==="public/index.html"));
  assert.ok(artifacts.some((a:any)=>a.path==="README.md"));
  assert.ok(artifacts.some((a:any)=>a.path==="tasks.test.cjs"));
  const gitLog = await exec("git",["log","--oneline"],{cwd:run.workspace}).catch(()=>null);
  assert.ok(gitLog&&gitLog.trim().split("\n").length>=5,`stage checkpoints committed in ${run.workspace}`);
  // User journey: run the delivered product and drive it from a real browser.
  app = spawn(process.execPath,["server.cjs"],{cwd:run.workspace,windowsHide:true,env:{...process.env,PORT:String(appPort)},stdio:["ignore","pipe","pipe"]});
  let appLogs=""; app.stdout?.on("data",(chunk:string)=>appLogs+=chunk); app.stderr?.on("data",(chunk:string)=>appLogs+=chunk);
  const appUrl = `http://127.0.0.1:${appPort}/`;
  const ready = Date.now()+20000;
  while(!(await fetch(`http://127.0.0.1:${appPort}/tasks`).then(r=>r.ok).catch(()=>false))) {
    if (Date.now()>ready || app.exitCode!==null) throw Error(`delivered server did not start\n${appLogs.slice(-2000)}`);
    await new Promise(r=>setTimeout(r,200));
  }
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true, channel: (process.env.LOAM_TEST_BROWSER_CHANNEL as "chrome") || "chrome" });
  try {
    const page = await browser.newPage();
    const title = "مهمة رحلة المستخدم الحية";
    await page.goto(appUrl);
    await page.locator("#new-task-title").waitFor({ timeout: 10000 });
    await page.locator("#new-task-title").fill(title);
    await page.locator("#add-task").click();
    const item = page.locator("#tasks li[data-task-id]").filter({ hasText: title }).first();
    await item.waitFor({ timeout: 10000 });
    await page.reload();
    await page.locator("#tasks li[data-task-id]").filter({ hasText: title }).first().waitFor({ timeout: 10000 });
    await page.locator("#tasks li[data-task-id]").filter({ hasText: title }).first().locator(".task-toggle").click();
    await page.locator("#tasks li.done").filter({ hasText: title }).first().waitFor({ timeout: 10000 });
    await page.locator("#tasks li[data-task-id]").filter({ hasText: title }).first().locator(".task-delete").click();
    await page.locator("#tasks li[data-task-id]").filter({ hasText: title }).first().waitFor({ state: "detached", timeout: 10000 });
    assert.equal(await page.locator("#tasks li[data-task-id]").count(), 0, "deleted task must leave the list; an empty-state notice without data-task-id is fine");
    await page.screenshot({ path: path.join(temp,"journey.png"), fullPage: true });
    fs.writeFileSync(path.join(temp,"journey.json"), JSON.stringify({ url: appUrl, steps: ["open","add","reload-persistence","toggle-done","delete-gone"], ok: true, at: new Date().toISOString(), title }, null, 2));
  } finally { await browser.close(); }
  // Existing-repository scenario: seed a real (buggy) repo into a second run; the swarm must
  // analyze it through the repo stage, fix it minimally, and prove the fix with real tests.
  const seedDir = path.join(temp,"seed-repo"); fs.mkdirSync(seedDir,{recursive:true});
  fs.writeFileSync(path.join(seedDir,"util.cjs"),"module.exports = (a,b) => a-b;\n");
  fs.writeFileSync(path.join(seedDir,"calculator.cjs"),"module.exports = { add: (a,b) => a+b, divide: (a,b) => { if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('finite numbers required'); return a / b; } };\n");
  fs.writeFileSync(path.join(seedDir,"calculator.test.cjs"),"const { test } = require('node:test'); const assert = require('node:assert/strict'); const calc = require('./calculator.cjs');\ntest('add', () => assert.equal(calc.add(2,3),5));\ntest('divide normal', () => assert.equal(calc.divide(6,3),2));\ntest('divide rejects zero divisor', () => assert.throws(() => calc.divide(1,0), /zero divisor/));\n");
  const seededResponse = await post("/api/swarm/runs", { model, concurrency: 2, maxSteps: 30, repoSeed: seedDir,
    brief: "The workspace already contains an existing Node.js repository (a small calculator). Its test suite currently FAILS because divide() does not reject a zero divisor. Analyze the existing code, fix calculator.cjs minimally so node --test calculator.test.cjs passes with every existing test unchanged and unweakened, then deliver. Keep every stage report under 150 words. No npm packages, no network." });
  assert.equal(seededResponse.status,201,await seededResponse.clone().text());
  seededId = ((await seededResponse.json()) as any).run.id;
  console.log(JSON.stringify({phase:"seeded",model,runId:seededId,evidence:seedDir}));
  const seeded = await waitForRun(seededId, 18);
  fs.writeFileSync(path.join(temp,"seeded-result.json"),JSON.stringify(seeded,null,2));
  assert.equal(seeded.status,"completed",JSON.stringify({error:seeded.error,nodes:seeded.nodes.map((n:any)=>({id:n.id,error:n.error,status:n.status}))}));
  const seededRepo = seeded.nodes.find((n:any)=>n.id==="repo");
  assert.equal(seededRepo?.status,"completed");
  assert.ok(seededRepo?.model,"the repo stage must make a real model call for an existing repository");
  assert.ok(!/greenfield/i.test(String(seededRepo?.output)),"repo analysis must discuss the actual repository");
  assert.ok((seeded.memory?.files ?? 0)>=4,`project memory must index the seeded repository: ${JSON.stringify(seeded.memory)}`);
  assert.ok((seeded.memory?.edges ?? 0)>=2,"local dependency edges must be indexed");
  assert.ok((seeded.verificationAttempts??[]).some((a:any)=>String(a.command).includes("calculator")),"the repository's own test suite must have been run");
  assert.equal(seeded.independentVerification?.ok,true,`independent acceptance must pass on the fixed repository: ${String(seeded.independentVerification?.summary).slice(0,300)}`);
  assert.equal(seeded.events.some((e:any)=>e.type==="repo_seeded"),true);
  const seededFiles = ((await (await fetchRetry(base+`/api/swarm/runs/${seededId}/artifacts`)).json()) as any).artifacts;
  assert.ok(seededFiles.some((a:any)=>a.path===".loam/swarm/project-index.json"),"the project index must be delivered as an artifact");
  const seededTests = await exec("git",["show",`HEAD:${"calculator.test.cjs"}`],{cwd:seeded.workspace}).catch(()=>null);
  assert.ok(seededTests&&/zero divisor/.test(seededTests),"the original test must remain intact in the delivered repo");
  console.log(JSON.stringify({phase:"seeded-pass",runId:seededId,verification:seeded.verification,memory:seeded.memory}));
  console.log(JSON.stringify({verdict:"PASS",model,runId,verification:run.verification,independent:run.independentVerification,repairs:run.repairs??0,repairDiffs:(run.repairDiffs??[]).length,journey:{url:appUrl,steps:["open","add","reload-persistence","toggle-done","delete-gone"]},artifacts:artifacts.length,seeded:{runId:seededId,memory:seeded.memory},evidence:temp}));
} catch(error) {
  console.error(error); console.error("Evidence retained:",temp); process.exitCode=1;
} finally {
  if (runId) await post(`/api/swarm/runs/${runId}/cancel`,{}).catch(()=>{});
  if (seededId) await post(`/api/swarm/runs/${seededId}/cancel`,{}).catch(()=>{});
  if (app && app.exitCode===null) { const appEnded = once(app,"exit"); app.kill(); await appEnded; }
  if(child.exitCode===null){const ended=once(child,"exit");child.kill("SIGKILL");await ended;}
}
