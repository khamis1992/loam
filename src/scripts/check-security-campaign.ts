import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { startAssessment, readAssessment, retestAssessment, updateFinding, type Assessment } from "../security/assessments.js";
import { normalizeScope, inScope, scopedTransport } from "../security/scope.js";
import { sarif } from "../security/findings.js";
import { inspectDependencies, queryAdvisories } from "../security/dependencies.js";

const root=fs.mkdtempSync(path.join(os.tmpdir(),"loam-campaign-"));
const requests:Array<{url:string;auth:string;cookie:string}>=[];let fixed=false,unavailable=false;
const server=http.createServer((req,res)=>{
  const url=req.url??"/";requests.push({url,auth:req.headers.authorization??"",cookie:req.headers.cookie??""});
  if(unavailable){res.writeHead(503).end("Unavailable");return;}
  res.setHeader("content-type","text/html");
  if(url==="/protected"&&fixed&&!req.headers.authorization){res.writeHead(403).end();return;}
  if(url==="/redirect"){res.writeHead(302,{location:"https://outside.invalid/"}).end();return;}
  if(url==="/"){res.end('<html><a href="/page">page</a><a href="/excluded">excluded</a><a href="/logout">logout</a><a href="/?token=private">query</a><a href="https://outside.invalid/">outside</a><a href="/protected">protected</a></html>');return;}
  if(url==="/page"){res.end(fixed?"<html>Fixed</html>":'<html><form action="/login" method="get"><input type="password"></form></html>');return;}
  if(url==="/protected"){res.end("Account response");return;}
  if(url==="/api/report"){res.end("Report");return;}
  if(url.startsWith("/many")){res.end('<html>'+Array.from({length:20},(_,i)=>'<a href="/many/'+i+'">next</a>').join('')+'</html>');return;}
  if(url==="/echo"){res.setHeader("server","session-secret-value");res.end("session-secret-value");return;}
  res.writeHead(404).end();
});
server.listen(0,"127.0.0.1");await once(server,"listening");
const target="http://127.0.0.1:"+(server.address() as import("node:net").AddressInfo).port;
async function finish(id:string):Promise<Assessment>{const end=Date.now()+12000;while(Date.now()<end){const run=readAssessment(root,id);if(run.status!=="running")return run;await new Promise(r=>setTimeout(r,10));}throw Error("Campaign timeout");}
try{
  const scope=normalizeScope(target,{exclusions:["/excluded"],delayMs:0});
  assert.ok(inScope(scope,target+"/page"));assert.ok(!inScope(scope,target+"/excluded/child"));assert.ok(!inScope(scope,target+"/logout"));assert.ok(!inScope(scope,target+"/?token=1"));assert.ok(!inScope(scope,target+"/%2e%2e/admin"));assert.ok(!inScope(scope,"https://outside.invalid/"));
  const scoped=normalizeScope(target+"/app",{});assert.ok(!inScope(scoped,target+"/application"));assert.ok(inScope(scoped,target+"/app/child"));
  const before=requests.length;assert.throws(()=>startAssessment(root,{target,profile:"campaign"}));assert.equal(requests.length,before);
  assert.throws(()=>startAssessment(root,{target,authorized:true,auth:{bearer:"secret"},scope:{seeds:["https://outside.invalid/"]}}),/one origin/);
  const input={target,authorized:true,profile:"campaign",checks:["security_headers"],scope:{exclusions:["/excluded"],delayMs:0},auth:{bearer:"fixture-token",cookie:"session=session-secret-value"},protectedPaths:["/protected"],openapi:{servers:[{url:"https://outside.invalid"}],paths:{"/api/report":{get:{}},"/delete":{post:{}},"/api/{id}":{get:{}}}}};
  const first=await finish(startAssessment(root,input).id);
  assert.equal(first.status,"completed");assert.ok(first.discovery?.pages.some(p=>p.url===target+"/api/report"));
  assert.ok(first.findings.some(f=>f.check==="credential_form"));assert.ok(first.findings.some(f=>f.check==="access_review"&&f.verdict==="finding"));
  assert.ok(!requests.some(r=>r.url==="/excluded"||r.url==="/logout"||r.url.includes("token=")));
  assert.ok(requests.some(r=>r.url==="/protected"&&!r.auth&&!r.cookie));assert.ok(requests.some(r=>r.url==="/protected"&&r.auth==="Bearer fixture-token"));
  assert.ok(!JSON.stringify(first).includes("fixture-token"));assert.ok(!JSON.stringify(first).includes("session-secret-value"));
  const finding=first.findings.find(f=>f.check==="credential_form")!;
  updateFinding(root,first.id,{fingerprint:finding.fingerprint,expectedRevision:0,state:"reviewing",owner:"Owner",note:"Fix form transport"});
  assert.throws(()=>updateFinding(root,first.id,{fingerprint:finding.fingerprint,expectedRevision:0,state:"accepted",owner:"",note:""}),/changed/);
  assert.equal(sarif(first.findings).runs[0]?.results.length,first.findings.filter(f=>f.verdict==="finding").length);
  assert.throws(()=>retestAssessment(root,first.id,{authorized:true}),/authentication|credentials/);
  fixed=true;const retest=await finish(retestAssessment(root,first.id,{authorized:true,auth:input.auth}).id);
  assert.equal(retest.status,"completed");assert.ok(retest.comparison?.notObserved.includes(finding.fingerprint));
  assert.ok(retest.comparison?.persistent.length);assert.equal(retest.comparison?.unverified.length,0);
  unavailable=true;const failed=await finish(retestAssessment(root,first.id,{authorized:true,auth:input.auth}).id);
  assert.equal(failed.status,"partial");assert.equal(failed.comparison?.notObserved.length,0);assert.ok(failed.comparison?.unverified.includes(finding.fingerprint));unavailable=false;
  const budget=await finish(startAssessment(root,{target:target+"/many",authorized:true,profile:"campaign",checks:["security_headers"],scope:{maxRequests:10,maxPages:30,delayMs:0}}).id);
  assert.equal(budget.status,"partial");assert.equal(budget.evidence.length,10);assert.match(budget.error??"",/budget/);
  const depthLimited=await finish(startAssessment(root,{target,authorized:true,profile:'campaign',checks:['security_headers'],scope:{maxDepth:0,delayMs:0,exclusions:['/excluded']}}).id);
  assert.equal(depthLimited.status,'partial');assert.equal(depthLimited.discovery!.limits!.depth,2);
  assert.ok(depthLimited.findings.some(f=>f.check==='discovery_coverage'&&f.verdict==='error'));
  assert.equal(sarif(depthLimited.findings).runs[0]!.invocations[0]!.executionSuccessful,false);
  const transport=scopedTransport(scope,new AbortController().signal,{Cookie:"session=session-secret-value"},[]);
  const echo=await transport.request(target+"/echo");assert.ok(!JSON.stringify(echo).includes("session-secret-value"));
  const redirected=await transport.request(target+"/redirect");assert.equal(redirected.status,302);
  fs.writeFileSync(path.join(root,"package-lock.json"),JSON.stringify({lockfileVersion:3,packages:{"node_modules/example":{version:"1.0.0",resolved:"http://registry.test/example.tgz"}}}));
  const inventory=inspectDependencies(root);assert.equal(inventory.findings.length,2);
  let outbound:unknown;
  await queryAdvisories(inventory,new AbortController().signal,(async(url,opts)=>{assert.equal(url,"https://api.osv.dev/v1/querybatch");outbound=JSON.parse(String(opts?.body));return new Response(JSON.stringify({results:[{vulns:[{id:"GHSA-test-fixture"}]}]}));}) as typeof fetch);
  assert.deepEqual(outbound,{queries:[{package:{name:"example",ecosystem:"npm"},version:"1.0.0"}]});assert.equal(inventory.advisories?.matches.length,1);assert.equal(inventory.findings.at(-1)?.check,"dependency_advisory");
  const outage=inspectDependencies(root);await queryAdvisories(outage,new AbortController().signal,(async()=>new Response("unavailable",{status:503})) as typeof fetch);assert.equal(outage.advisories?.complete,false);assert.equal(outage.findings.at(-1)?.verdict,"error");
  console.log("PASS: campaign discovery, exact scope, exclusions, auth containment/redaction, OpenAPI, request budgets, triage revisions, SARIF, retest coverage and OSV contract/outage handling");
}finally{server.closeAllConnections();server.close();fs.rmSync(root,{recursive:true,force:true});}
