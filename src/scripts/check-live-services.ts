/** Opt-in live service checks. Only synthetic text and temporary app data are used. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { OllamaClient } from "../ollama.js";
import { OllamaEmbedder } from "../memory/embeddings.js";
import { MemoryStore } from "../memory/store.js";
import { browserTools, closeBrowser } from "../tools/browser.js";
import { loadConfig } from "../config.js";
import type { ToolContext } from "../tools/registry.js";
import { captureScreen } from "../screen/capture.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-live-services-"));
const original = JSON.parse(fs.readFileSync(process.env.LOAM_CONFIG || "config.json", "utf8"));
const url = original.ollamaUrl || "http://127.0.0.1:11434";
const results: Array<Record<string, unknown>> = [];
async function check(name: string, test: () => Promise<unknown>) {
  const at = Date.now();
  try { const evidence = await test(); results.push({ name, verdict: "PASS", elapsedMs: Date.now() - at, evidence }); }
  catch (error) { results.push({ name, verdict: "FAIL", error: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; }
  console.log(JSON.stringify(results.at(-1)));
}
const fixture = http.createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end('<title>Loam service fixture</title><input aria-label="Test name" id="name"><button onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#name\').value">Save</button><output id="result"></output>'); });
fixture.listen(0, "127.0.0.1"); await once(fixture, "listening");
const fixtureUrl = `http://127.0.0.1:${(fixture.address() as import("node:net").AddressInfo).port}`;
const probe = http.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
const port = (probe.address() as import("node:net").AddressInfo).port;
await new Promise<void>(resolve => probe.close(() => resolve()));
const config = path.join(tmp, "config.json");
fs.writeFileSync(config, JSON.stringify({ workspace: path.join(tmp, "workspace"), ollamaUrl: url, model: original.model, fallbackModel: original.fallbackModel,
  browser: { channel: "msedge", headless: true }, memory: { enabled: false }, computerUse: { enabled: false }, screen: { enabled: false }, selfImprove: { enabled: false }, mcpServers: {} }));
process.env.LOAM_CONFIG = config;
const cfg = loadConfig();
const child = spawn(process.execPath, process.argv.includes("--bundle") ? ["dist/server.cjs"] : ["--import", "tsx", "src/index.ts"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LOAM_CONFIG: config, LOAM_PORT: String(port), LOAM_DATA_DIR: path.join(tmp,"data"), LOAM_SKILLS_DIR: path.join(tmp,"skills"), LOAM_EVALS_DIR: path.join(tmp,"evals") } });
let logs = ""; child.stdout.on("data", d => { logs += d; }); child.stderr.on("data", d => { logs += d; });
const base = `http://127.0.0.1:${port}`;
const request = (p: string, body?: unknown) => fetch(base + p, { ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
try {
  await check("real HTTP PTY and cross-task isolation", async () => {
    const deadline = Date.now() + 20_000;
    while (!(await request("/api/tasks").then(r => r.ok).catch(() => false))) { assert.ok(Date.now() < deadline, logs.slice(-1000)); await new Promise(r => setTimeout(r,100)); }
    const draft = async () => ((await (await request("/api/tasks/draft", { mode: "build" })).json()) as {task:{id:string}}).task.id;
    const a = await draft(), b = await draft();
    const started = await request("/api/pty", { taskId:a, shell:"cmd" }); assert.equal(started.status,200);
    const session = await started.json() as {id:string;cwd:string};
    const endpoint = `/api/pty/${session.id}`;
    assert.equal((await request(`${endpoint}/input?taskId=${a}`, {data:"echo LOAM_LIVE_PTY>loam-pty-proof.txt\r"})).status,200);
    const proof = path.join(session.cwd,"loam-pty-proof.txt");
    const until = Date.now()+10_000;
    while (!fs.existsSync(proof)) { assert.ok(Date.now()<until,"PTY did not execute command"); await new Promise(r=>setTimeout(r,100)); }
    assert.equal(fs.readFileSync(proof,"utf8").trim(),"LOAM_LIVE_PTY");
    assert.equal((await request(`${endpoint}/output?taskId=${b}`)).status,404);
    assert.equal((await request(`${endpoint}/input?taskId=${b}`,{data:"echo forbidden\r"})).status,404);
    const listed = await (await request(`/api/pty?taskId=${b}`)).json() as {sessions:unknown[]}; assert.equal(listed.sessions.length,0);
    assert.equal((await request(`${endpoint}/resize?taskId=${a}`,{cols:90,rows:24})).status,200);
    // Exit only our own session; the server and all files are temporary.
    await request(`${endpoint}/input?taskId=${a}`,{data:"exit\r"});
    return "Real command wrote expected bytes inside task A; task B cannot list/read/write session";
  });
  await check("real browser tool session",async()=>{
    const ctx: ToolContext = {cfg,workspace:cfg.workspace,emit:()=>{},taskId:"synthetic-browser"};
    const call = async (name:string,args:Record<string,unknown>)=>{const result=await browserTools.find(t=>t.name===name)!.run(args,ctx);assert.equal(result.ok,true,result.content);return result.content;};
    const opened=await call("browser_open",{url:fixtureUrl}); const pageId=/pageId=(\S+)/.exec(opened)![1];
    assert.match(opened,/Loam service fixture/);
    await call("browser_type",{pageId,selector:"#name",text:"Loam browser verified"});
    await call("browser_click",{pageId,selector:"button"});
    assert.match(await call("browser_eval",{pageId,expression:"document.querySelector('#result').textContent"}),/Loam browser verified/);
    await call("browser_close",{pageId});
    return "Actual Edge: open, snapshot, type, click, observe result, close";
  });
  await check("real semantic memory embedding and reload",async()=>{
    const model=original.memory?.model || "nomic-embed-text:latest";
    const embedder=new OllamaEmbedder(url,model);const file=path.join(tmp,"memory.json");const store=new MemoryStore(file,embedder,model);
    const entry=await store.add("Loam grows a garden of useful work.",{kind:"test"});assert.ok(entry.dim>0);
    const hits=await store.search("Loam grows a garden of useful work.",1,0.9);assert.equal(hits[0]?.entry.id,entry.id);
    await new Promise(r=>setTimeout(r,350));const reloaded=new MemoryStore(file,embedder,model);assert.equal(reloaded.count,1);assert.equal((await reloaded.search(entry.text,1,0.9))[0]?.entry.id,entry.id);
    reloaded.remove(entry.id);await new Promise(r=>setTimeout(r,350));assert.equal(new MemoryStore(file,embedder,model).count,0);
    return {model,dimensions:entry.dim,score:hits[0]?.score,persistence:"stored/reloaded/deleted"};
  });
  const client=new OllamaClient(url);
  if (process.argv.includes("--screen-once")) await check("one real screen capture and image encoding",async()=>{
    const frame=await captureScreen({dir:path.join(tmp,"screen"),name:"verification",maxWidth:320,format:"jpg"});
    assert.ok(frame.width>0 && frame.width<=320 && frame.height>0 && frame.bytes>0);
    const evidence={width:frame.width,height:frame.height,bytes:frame.bytes,mediaType:frame.mediaType,retained:false};
    fs.rmSync(frame.path,{force:true});
    return evidence;
  });
  for (const model of [...new Set<string>([original.model,original.fallbackModel].filter(Boolean))]) {
    await check(`configured model ${model}`,async()=>{const reply=await client.chat({model,messages:[{role:"user",content:"What is 2 + 2? Reply with only 4. This is a connectivity test."}],timeoutMs:45_000,temperature:0});assert.match(reply.content,/4|٤/);return {answer:reply.content,model:reply.model};});
  }
} finally {
  await closeBrowser(); await new Promise<void>(resolve=>fixture.close(()=>resolve()));
  if(child.exitCode===null){const exited=once(child,"exit");child.kill();await exited;}
  fs.rmSync(tmp,{recursive:true,force:true});
}
console.log(JSON.stringify({suite:"Loam real services",results,isolated:true}));
