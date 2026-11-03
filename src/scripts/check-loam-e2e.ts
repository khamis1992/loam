import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-e2e-"));
const workspace = path.join(tmp, "workspace"); fs.mkdirSync(workspace);
let nativeCalls = 0;
const model = http.createServer(async (req, res) => {
  if (req.url === "/api/tags") { res.end(JSON.stringify({ models: [{ name: "test-model" }] })); return; }
  let raw = ""; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const messages = body.messages as Array<{role:string; content:string}>;
  const system = messages[0]?.content ?? "";
  const prompt = messages.findLast((m) => m.role === "user")?.content ?? "";
  let content = ""; let tool_calls: unknown[] = [];
  if(system.includes("planner role")) content = JSON.stringify({goal:"Write an isolated document",trivial:false,steps:[{id:"write",title:"Create report",instruction:"Use loam_document to write report.md",success_criteria:"report.md exists"}]});
  else if(system.includes("COMPLETED task as a whole")) {
    if(!messages.some(m=>m.role==="tool")) tool_calls=[{function:{name:"file_read",arguments:{path:"report.md"}}}];
    else content=JSON.stringify({verdict:"pass",reason:"Document contents inspected in task workspace"});
  }
  else if(system.includes("ONE executed plan step")) content=JSON.stringify({verdict:"pass",reason:"Document saved in task workspace"});
  else if(messages.at(-1)?.role === "tool") content="تم إنشاء مستند Loam بنجاح داخل مساحة المهمة.";
  else if(prompt.includes("Use loam_document")) { nativeCalls++; tool_calls=[{function:{name:"loam_document",arguments:{path:"report.md",title:"Loam E2E",content:"Verified integration document",format:"markdown"}}}]; }
  else { content="No reusable skill found."; }
  res.setHeader("content-type","application/x-ndjson");res.end(JSON.stringify({model:"test-model",message:{role:"assistant",content,tool_calls},done:true})+"\n");
});
model.listen(0, "127.0.0.1"); await once(model, "listening");
const modelPort = (model.address() as import("node:net").AddressInfo).port;
const probe = http.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
const port = (probe.address() as import("node:net").AddressInfo).port;
await new Promise<void>((resolve) => probe.close(() => resolve()));
const base = `http://127.0.0.1:${port}`;
const config = path.join(tmp, "config.json");
fs.writeFileSync(config, JSON.stringify({ model: "test-model", fallbackModel: "test-model", ollamaUrl: `http://127.0.0.1:${modelPort}`,
  workspace, computerUse: { enabled: false, screenshotDir: path.join(tmp, "screenshots") }, memory: { enabled: false }, screen: { enabled: false }, selfImprove: { enabled: false }, mcpServers: {}, coding: { enabled: false }, failover: { providers: [] },
}));
let child: ChildProcess | undefined;
let logs = "";
const waitFor = async (predicate: () => Promise<boolean> | boolean): Promise<void> => {
  const until = Date.now() + 25_000;
  while (Date.now() < until) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error(`Timed out\n${logs.slice(-4000)}`);
};
const start = async (): Promise<void> => {
  logs = "";
  const serverArgs = process.argv.includes("--bundle") ? ["dist/server.cjs"] : ["--import", "tsx", "src/index.ts"];
  child = spawn(process.execPath, serverArgs, { cwd: root, windowsHide: true, env: {
    ...process.env, MANUS_LOCAL_CONFIG: config, MANUS_LOCAL_DATA_DIR: path.join(tmp, "data"), MANUS_LOCAL_PORT: String(port), LOAM_AUTH_DISABLED: "true", AGENT_STUDIO_LEGACY_UI: "1",
    MANUS_LOCAL_EVALS_DIR: path.join(tmp, "evals"), MANUS_LOCAL_SKILLS_DIR: path.join(tmp, "skills"),
    LOAM_CODER_ROUTING: "0", LOAM_CODER_CHAIN: "test-model",
  }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk) => { logs += chunk; }); child.stderr?.on("data", (chunk) => { logs += chunk; });
  await waitFor(async () => {
    if (child?.exitCode != null) throw new Error(logs);
    return fetch(`${base}/api/tasks`).then((r) => r.ok).catch(() => false);
  });
};
const stop = async (): Promise<void> => {
  if (child && child.exitCode === null) { const ended = once(child, "exit"); child.kill("SIGKILL"); await ended; }
};

let browser: Browser | undefined;
try {
  await start();
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await page.goto(base+"/#/modes/write", { waitUntil: "domcontentloaded" });await page.locator("#modeForm").waitFor();
  await page.locator("#modeForm [data-field]").first().fill("اكتب تقرير اختبار التكامل");
  await page.locator("#uploadPicker").setInputFiles({name:"private-first.txt",mimeType:"text/plain",buffer:Buffer.from("PRIVATE-FIRST")});
  await page.locator("#modeAttachments .attachment").waitFor();
  await page.locator("#model").evaluate((element) => { const select = element as HTMLSelectElement; select.value = "test-model"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await page.locator("#modeSubmit").click();await page.waitForURL(/#\/tasks\/task_/);
  const firstId=page.url().split("/tasks/")[1]!;
  try {
    await page.locator("#chatStatus").filter({hasText:"مكتملة"}).waitFor({timeout:90000});
  } catch (error) {
    const snapshot = await (await fetch(base+"/api/tasks/"+firstId)).json();
    await page.screenshot({path:path.join(tmp,"e2e-failure.png")});
    console.error(JSON.stringify({ status: await page.locator("#chatStatus").innerText(), snapshot, nativeCalls, logs: logs.slice(-4000), screenshot: tmp }));
    throw error;
  }
  await page.locator("#taskResult").getByText("تم إنشاء مستند Loam بنجاح داخل مساحة المهمة.").waitFor();
  await page.locator('#taskFiles [data-output="report.md"]').waitFor();
  await page.locator('#taskFiles [data-output="report.md"]').click();
  await page.locator("#fileView pre").filter({hasText:"Verified integration document"}).waitFor();
  const first=await (await fetch(base+"/api/tasks/"+firstId)).json() as {task:{workspace:string;mode:string;title:string}};
  assert.equal(first.task.mode,"write");assert.match(first.task.title,/اختبار التكامل/);assert.doesNotMatch(first.task.title,/مهمة جديدة/);assert.ok(nativeCalls >= 1);
  assert.match(fs.readFileSync(path.join(first.task.workspace,"report.md"),"utf8"),/Verified integration/);
  await page.screenshot({path:path.join(tmp,"actual-server-complete.png")});
  await page.goto(base+"/#/modes/data");await page.locator("#modeForm").waitFor();
  const draftResponse=page.waitForResponse(r=>r.url().endsWith("/api/tasks/draft") && r.request().method()==="POST");
  await page.locator("#uploadPicker").setInputFiles({name:"second.csv",mimeType:"text/csv",buffer:Buffer.from("name,value\na,2")});
  const second=(await (await draftResponse).json()) as {task:{id:string;workspace:string;mode:string}};
  await page.locator("#modeAttachments .attachment").waitFor();
  assert.equal(second.task.mode,"data");assert.notEqual(second.task.workspace,first.task.workspace);
  const files=await (await fetch(base+"/api/files?taskId="+second.task.id)).json() as {entries:Array<{path:string}>};
  assert.ok(files.entries.some(e=>e.path.includes("second.csv")));
  assert.ok(files.entries.every(e=>!e.path.includes("report.md")&&!e.path.includes("private-first")));
  await page.goto(base+"/#/tasks/"+second.task.id);await page.locator("#chatTitle").waitFor();await page.locator("#taskWorkspace").click();
  await page.locator("#filesList [data-file]").waitFor();assert.doesNotMatch(await page.locator("#filesList").innerText(),/report.md|private-first/);
  assert.deepEqual(errors,[]);
  console.log("PASS real source HTTP + Edge browser: mode -> isolated upload -> native tool execution -> persisted result/output -> new mode isolated files; screenshots: "+tmp);
} finally { await browser?.close();await stop();model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve())); }
