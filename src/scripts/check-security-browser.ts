import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { once } from "node:events";
import { startAssessment, readAssessment, retestAssessment, cancelAssessment } from "../security/assessments.js";
import { readBrowserArtifact } from "../security/browser.js";

const root=fs.mkdtempSync(path.join(os.tmpdir(),"loam-browser-security-"));
let outsideHits=0,writes=0,fixed=false,unavailable=false;
const outside=http.createServer((_req,res)=>{outsideHits++;res.end("outside");});outside.on("upgrade",(_req,socket)=>{outsideHits++;socket.destroy();});
outside.listen(0,"127.0.0.1");await once(outside,"listening");
const external="http://127.0.0.1:"+(outside.address() as import("node:net").AddressInfo).port;
const traffic:Array<{url:string;auth:string}>=[];
const server=http.createServer((req,res)=>{
  const url=new URL(req.url??"/","http://localhost");traffic.push({url:req.url??"/",auth:req.headers.authorization??""});
  if(req.method!=="GET"){writes++;res.end();return;}
  if(unavailable){res.writeHead(503).end("Unavailable");return;}
  if(fixed)res.setHeader("content-security-policy","frame-ancestors 'none'");
  if(url.pathname==="/app.js"){
    res.setHeader("content-type","application/javascript");
    res.end(`setTimeout(async()=>{await fetch('/api/data?cache=1');const app=document.getElementById('app');app.innerHTML='<a href="/dynamic">JavaScript route</a><input value="session-secret"><div id="fragment"></div>';document.getElementById('fragment').${fixed?"textContent":"innerHTML"}=decodeURIComponent(location.hash.slice(1));app.dataset.ready='yes';},50);`);return;
  }
  if(url.pathname==="/api/data"){res.setHeader("content-type","application/json");res.end('{"ready":true}');return;}
  if(url.pathname==="/api/private"){
    res.setHeader("content-type","application/json");
    if(fixed&&req.headers.authorization!=="Bearer browser-fixture-token"){res.writeHead(403).end('{}');return;}
    res.end('{"account":"fixture"}');return;
  }
  res.setHeader("content-type","text/html");
  if(url.pathname==="/"){res.end('<!doctype html><html><body><h1>Browser fixture</h1><div id="app"></div><script src="/app.js?v=1"></script></body></html>');return;}
  if(url.pathname==="/dynamic"){res.end('<!doctype html><html><body><div id="app" data-ready="yes"><form method="get"><input type="password"></form></div></body></html>');return;}
  if(url.pathname==="/protected"){res.end('<!doctype html><html><body><div id="app"></div><script>fetch("/api/private").then(r=>{document.getElementById("app").innerHTML=r.ok?"<section data-private>Account details</section>":"<section data-denied>Sign in required</section>";document.getElementById("app").dataset.ready="yes";});</script></body></html>');return;}
  if(url.pathname==="/blocked"){
    res.end(`<html><body><div id="app" data-ready="yes">Blocked egress test</div><script>fetch('${external}/outside?token=secret').catch(()=>{});fetch('/blocked/write',{method:'POST',body:'no'}).catch(()=>{});new WebSocket('${external.replace('http:','ws:')}/socket');fetch('/blocked/redirect').catch(()=>{});</script></body></html>`);return;
  }
  if(url.pathname==="/blocked/redirect"){res.writeHead(302,{location:external+"/redirect-target"}).end();return;}
  if(url.pathname==="/budget"){res.end('<html><body><div id="app" data-ready="yes"></div><script>for(let i=0;i<25;i++)fetch("/budget/resource?n="+i).catch(()=>{});</script></body></html>');return;}
  if(url.pathname==="/budget/resource"){res.end("resource");return;}
  if(url.pathname==="/large-resource"){res.end('<html><div id="app" data-ready="yes"></div><script>fetch("/large-resource/data").catch(()=>{})</script></html>');return;}
  if(url.pathname==="/large-resource/data"){res.end('x'.repeat(2_100_000));return;}
  if(url.pathname==="/slow"){res.end('<html><script>fetch("/slow/hang")</script></html>');return;}
  if(url.pathname==="/slow/hang")return;
  res.writeHead(404).end();
});
server.listen(0,"127.0.0.1");await once(server,"listening");
const target="http://127.0.0.1:"+(server.address() as import("node:net").AddressInfo).port;
async function finish(id:string){const end=Date.now()+90000;while(Date.now()<end){const run=readAssessment(root,id);if(run.status!=="running")return run;await new Promise(r=>setTimeout(r,100));}throw Error("Browser campaign timeout");}
try{
  const oversized=await finish(startAssessment(root,{target:target+'/large-resource',authorized:true,profile:'quick',checks:['server_banner'],scope:{delayMs:0},browser:{enabled:true,screenshots:false,maxPages:1,settleMs:250,readySelector:'#app[data-ready]'}}).id);
  assert.equal(oversized.status,'partial');
  assert.ok(oversized.evidence.some(e=>e.error==='Browser response exceeded 2000000 bytes'),'Response limit must have actionable evidence without exposing raw exceptions');
  const options={enabled:true,domCanary:true,framing:true,screenshots:true,maxPages:2,settleMs:250,readySelector:'#app[data-ready]',accessAssertions:[{path:'/protected',selector:'[data-private]',deniedSelector:'[data-denied]'}]};
  const input={target,authorized:true,profile:"quick",checks:["server_banner"],scope:{delayMs:0,maxRequests:150},auth:{bearer:"browser-fixture-token",cookie:"session=session-secret"},browser:options};
  const first=await finish(startAssessment(root,input).id);
  assert.ok(first.browser?.version,JSON.stringify(first));
  assert.ok(first.browser.pages.some(p=>p.url===target+"/dynamic"),JSON.stringify(first.browser));
  const canary=first.findings.find(f=>f.check==="browser_dom_canary")!;assert.ok(canary,JSON.stringify(first.browser));
  assert.ok(first.findings.some(f=>f.check==="browser_framing"),JSON.stringify(first.browser));
  assert.ok(first.findings.some(f=>f.check.startsWith("browser_access_")),JSON.stringify(first.browser));
  assert.ok(first.findings.some(f=>f.check==="browser_credential_form"));
  assert.ok(traffic.some(r=>r.url==="/api/private"&&r.auth===""));assert.ok(traffic.some(r=>r.url==="/api/private"&&r.auth==="Bearer browser-fixture-token"));
  assert.ok(!JSON.stringify(first).includes("browser-fixture-token"));assert.ok(!JSON.stringify(first).includes("session-secret"));
  const artifact=first.browser.proofs.find(p=>p.artifact)!;assert.ok(artifact);assert.equal(readBrowserArtifact(root,artifact).subarray(1,4).toString(),"PNG");
  fixed=true;
  const retest=await finish(retestAssessment(root,first.id,{authorized:true,auth:input.auth}).id);
  assert.ok(retest.comparison?.notObserved.includes(canary.fingerprint),JSON.stringify(retest.browser));
  for(const f of first.findings.filter(f=>f.check==="browser_framing"||f.check.startsWith("browser_access_")))assert.ok(retest.comparison?.notObserved.includes(f.fingerprint),JSON.stringify(retest.browser));
  unavailable=true;
  const failed=await finish(retestAssessment(root,first.id,{authorized:true,auth:input.auth}).id);
  assert.equal(failed.status,"partial");assert.ok(failed.comparison?.unverified.includes(canary.fingerprint));assert.equal(failed.comparison?.notObserved.length,0);unavailable=false;
  const blocked=await finish(startAssessment(root,{target:target+"/blocked",authorized:true,checks:["server_banner"],scope:{delayMs:0},browser:{enabled:true,maxPages:1,settleMs:250,screenshots:false}}).id);
  assert.equal(blocked.status,"partial");assert.ok(blocked.browser?.blocked.length);assert.equal(outsideHits,0);assert.equal(writes,0);
  const budget=await finish(startAssessment(root,{target:target+"/budget",authorized:true,checks:["server_banner"],scope:{delayMs:0,maxRequests:10},browser:{enabled:true,maxPages:1,settleMs:250,screenshots:false}}).id);
  assert.equal(budget.status,"partial");assert.equal(budget.evidence.length,10);assert.equal(new Set(budget.evidence.map(e=>e.id)).size,10);
  const slow=startAssessment(root,{target:target+"/slow",authorized:true,checks:["server_banner"],scope:{delayMs:0},browser:{enabled:true,screenshots:false,maxPages:1,settleMs:250}});
  await new Promise(r=>setTimeout(r,1000));cancelAssessment(root,slow.id);assert.equal((await finish(slow.id)).status,"cancelled");
  fs.appendFileSync(path.join(root,artifact.artifact!.path),"tamper");assert.throws(()=>readBrowserArtifact(root,artifact),/integrity/);
  console.log("PASS: real JavaScript rendering/discovery, harmless DOM canary, enforced frame protection, authenticated/anonymous UI witnesses, fixed/unavailable retests, masked PNG integrity, egress/write blocking, shared concurrent budget and cancellation");
  console.log("Browser fixture artifacts: "+root);
}finally{server.closeAllConnections();server.close();outside.closeAllConnections();outside.close();}
