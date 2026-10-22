import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {startAssessment,readAssessment,retestAssessment} from '../security/assessments.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-security-ssrf-'));
let fixed=false,fetchCount=0;
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url!,'http://localhost');
  let raw='';for await(const part of req)raw+=part;
  const json=(status:number,payload:unknown)=>{res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(payload));};
  const fetchUrl=async(value:string,mode:'await'|'fire')=>{
    fetchCount++;
    if(fixed){try{const u=new URL(value);if(u.hostname!=='example.invalid')return json(400,{error:'host not allowed'});}catch{return json(400,{error:'invalid url'});}}
    try{
      if(mode==='await'){const r=await fetch(value,{signal:AbortSignal.timeout(5000)});await r.body?.cancel();return json(200,{fetched:true,status:r.status});}
      void fetch(value,{signal:AbortSignal.timeout(5000)}).catch(()=>{});return json(202,{fetched:'accepted'});
    }catch{return json(400,{error:'invalid url'});}
  };
  const value=()=>url.searchParams.get('url')??'';
  if(url.pathname==='/'&&req.method==='GET'){res.setHeader('content-type','text/html').end('<!doctype html><title>fixture</title>');return;}
  if(url.pathname==='/fetch'&&req.method==='GET')return fetchUrl(value(),'await');
  if(url.pathname==='/fetch-safe'&&req.method==='GET'){
    try{const u=new URL(value());if(u.hostname!=='example.invalid')return json(400,{error:'host not allowed'});}catch{return json(400,{error:'invalid url'});}
    return fetchUrl(value(),'await');
  }
  if(url.pathname==='/fetch-async'&&req.method==='GET')return fetchUrl(value(),'fire');
  if(url.pathname==='/fetch-broken'&&req.method==='GET')return json(500,{error:'unavailable'});
  res.writeHead(404).end();
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const target='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;
const finish=async(id:string)=>{const deadline=Date.now()+90000;while(Date.now()<deadline){const r=readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,100));}throw Error('ssrf assessment timed out');};
const ssrf=[
  {id:'unguardedFetch',kind:'get' as const,path:'/fetch',field:'url',benignRef:'benignValue'},
  {id:'guardedFetch',kind:'get' as const,path:'/fetch-safe',field:'url',benignRef:'benignValue'},
  {id:'asyncFetch',kind:'get' as const,path:'/fetch-async',field:'url',benignRef:'benignValue'},
  {id:'brokenEndpoint',kind:'get' as const,path:'/fetch-broken',field:'url',benignRef:'benignValue'},
];
const input={target,authorized:true,checks:['server_banner'],profile:'campaign' as const,scope:{delayMs:0,maxRequests:200},ssrf,businessSecrets:{benignValue:'homepage'}};
try{
  assert.throws(()=>startAssessment(root,{...input,profile:'quick' as any}),/campaign mode/);
  assert.throws(()=>startAssessment(root,{...input,ssrf:[{...ssrf[0]!,kind:'post' as any}]}),/allowlisted in postPaths/);
  assert.throws(()=>startAssessment(root,{...input,ssrf:[{...ssrf[0]!,path:'/fetch?x=1'}]}),/exact path/);
  assert.throws(()=>startAssessment(root,{...input,ssrf:[{...ssrf[0]!,field:'action'}]}),/safe field or parameter name/);
  assert.throws(()=>startAssessment(root,{...input,businessSecrets:{}}),/fresh (business )?input/);
  const first=await finish(startAssessment(root,input).id);
  assert.equal(first.status,'partial',JSON.stringify({proofs:first.ssrf?.proofs.map(p=>[p.caseId,p.outcome,p.summary]),findings:first.findings.map(f=>f.check+':'+f.verdict)}));
  assert.equal(first.completed,first.total,'progress accounting must include SSRF cases');
  const proofs=first.ssrf?.proofs??[];
  assert.equal(proofs.length,4,'four SSRF proofs');
  const unguarded=proofs.find(p=>p.target.endsWith('/fetch'))!,guarded=proofs.find(p=>p.target.endsWith('/fetch-safe'))!,asyncProbe=proofs.find(p=>p.target.endsWith('/fetch-async'))!,broken=proofs.find(p=>p.target.endsWith('/fetch-broken'))!;
  assert.ok(unguarded&&guarded&&asyncProbe&&broken,JSON.stringify(proofs.map(p=>p.target)));
  assert.equal(unguarded.kind,'ssrf');
  assert.equal(unguarded.outcome,'observed',JSON.stringify(unguarded));
  assert.equal(unguarded.observations.baselineClean,true);
  assert.equal(unguarded.observations.callbackReceived,true);
  assert.equal(guarded.outcome,'not_observed',JSON.stringify(guarded));
  assert.equal(guarded.observations.callbackReceived,false);
  assert.equal(guarded.observations.probeStatus,400);
  assert.equal(asyncProbe.outcome,'observed',JSON.stringify(asyncProbe));
  assert.equal(asyncProbe.observations.callbackReceived,true,'a fire-and-forget fetch must still arrive within the polling window');
  assert.equal(broken.outcome,'inconclusive');
  assert.match(String(broken.summary),/Baseline request (did not complete|failed with a server error)/);
  const findings=first.findings.filter(f=>f.check.startsWith('ssrf_')&&f.verdict==='finding');
  assert.equal(findings.length,2,JSON.stringify(first.findings));
  assert.ok(findings.every(f=>f.severity==='high'));
  assert.ok(findings.some(f=>f.target.endsWith('/fetch')));
  const fetchGets=first.evidence.filter(e=>e.method==='GET'&&e.url.endsWith('/fetch'));
  assert.equal(fetchGets.length,2,'baseline plus probe');
  assert.ok(first.covered.some(k=>k.includes('/fetch-safe')&&k.includes('ssrf_')));
  assert.ok(!JSON.stringify(first).includes('homepage'),'the benign baseline value must be redacted');
  const module=first.diagnostics?.modules.find(m=>m.id==='ssrf');
  assert.equal(module?.state,'incomplete');assert.equal(module?.planned,4);assert.equal(module?.conclusive,3);assert.equal(module?.inconclusive,1);
  assert.throws(()=>retestAssessment(root,first.id,{authorized:true}),/fresh (business )?input/);
  fixed=true;
  const second=await finish(retestAssessment(root,first.id,{authorized:true,businessSecrets:input.businessSecrets}).id);
  for(const f of findings)assert.ok(second.comparison?.notObserved.includes(f.fingerprint),JSON.stringify(second.comparison));
  assert.equal(second.ssrf?.proofs.find(p=>p.target.endsWith('/fetch'))?.outcome,'not_observed','a host-allowlist repair must block the probe');
  console.log('PASS ssrf: local callback listener received tokenized probes from awaited and fire-and-forget server-side fetches, host-allowlist guard blocked without callbacks, broken baseline inconclusive, negative baseline redacted, diagnostics module and repaired retest');
}finally{server.closeAllConnections();server.close();}
