import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {startAssessment,readAssessment,retestAssessment} from '../security/assessments.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-security-csrf-'));
let balance=100000,tokenBalance=50000,fixed=false;
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url!,'http://localhost');
  let raw='';for await(const part of req)raw+=part;
  const json=(status:number,payload:unknown)=>{res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(payload));};
  const victim=!!req.headers.cookie?.includes('session=victim-session');
  const amount=()=>{try{return Number(JSON.parse(raw).amount);}catch{return 0;}};
  if(url.pathname==='/'&&req.method==='GET'){res.setHeader('content-type','text/html').end('<!doctype html><title>fixture</title>');return;}
  if(url.pathname==='/api/wallet'&&req.method==='GET')return json(200,{balance,tokenBalance});
  if(url.pathname==='/api/transfer'&&req.method==='POST'){
    if(!victim)return json(401,{error:'authentication required'});
    // The repair validates the Origin of state-changing requests.
    const origin=req.headers.origin;
    if(fixed&&origin&&origin!==target)return json(403,{error:'cross-origin request rejected'});
    balance-=amount();return json(200,{balance});
  }
  if(url.pathname==='/api/transfer-token'&&req.method==='POST'){
    if(!victim)return json(401,{error:'authentication required'});
    // The guard rejects cross-site requests (Fetch Metadata, with Origin as fallback).
    const crossSite=req.headers['sec-fetch-site']==='cross-site'||(!!req.headers.origin&&req.headers.origin!==target);
    if(crossSite)return json(403,{error:'cross-site request rejected'});
    tokenBalance-=amount();return json(200,{tokenBalance});
  }
  if(url.pathname==='/api/transfer-broken'&&req.method==='POST')return json(403,{error:'always rejected'});
  res.writeHead(404).end();
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const target='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;
const finish=async(id:string)=>{const deadline=Date.now()+90000;while(Date.now()<deadline){const r=readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,100));}throw Error('csrf assessment timed out');};
const browser={enabled:true,screenshots:false,maxPages:1,settleMs:250,networkIdleTimeoutMs:2000,postPaths:['/api/transfer','/api/transfer-token','/api/transfer-broken'],csrfCookieSameSite:'None' as const,csrf:[
  {id:'unguardedTransfer',path:'/api/transfer',bodyRef:'transferBody',statePath:'/api/wallet',statePointer:'/balance',stateDelta:-500},
  {id:'tokenGuardedTransfer',path:'/api/transfer-token',bodyRef:'tokenBody',statePath:'/api/wallet',statePointer:'/tokenBalance',stateDelta:-300},
  {id:'brokenControl',path:'/api/transfer-broken',bodyRef:'brokenBody',statePath:'/api/wallet',statePointer:'/balance',stateDelta:-100},
]};
const input={target,authorized:true,checks:['server_banner'],scope:{delayMs:0,maxRequests:300},auth:{cookie:'session=victim-session'},browser,browserSecrets:{transferBody:JSON.stringify({amount:500}),tokenBody:JSON.stringify({amount:300}),brokenBody:JSON.stringify({amount:100})}};
try{
  assert.throws(()=>startAssessment(root,{...input,browser:{...browser,enabled:false}}),/CSRF checks require the browser engine/);
  assert.throws(()=>startAssessment(root,{...input,browser:{...browser,csrf:[{...browser.csrf[0]!,path:'/api/unknown'}]}}),/allowlisted in postPaths/);
  assert.throws(()=>startAssessment(root,{...input,browser:{...browser,csrfCookieSameSite:'None; Evil' as any}}),/SameSite must be/);
  assert.throws(()=>startAssessment(root,{...input,browserSecrets:{}}),/fresh browser input: transferBody|CSRF probe body/);
  const first=await finish(startAssessment(root,input).id);
  assert.equal(first.status,'partial',JSON.stringify({proofs:first.browser?.proofs.filter(p=>p.kind==='csrf').map(p=>[p.target,p.outcome,p.summary]),findings:first.findings.map(f=>f.check+':'+f.verdict)}));
  const proofs=(first.browser?.proofs??[]).filter(p=>p.kind==='csrf');
  assert.equal(proofs.length,3,'three CSRF proofs');
  const unguarded=proofs.find(p=>p.target.endsWith('/api/transfer'))!;
  const guarded=proofs.find(p=>p.target.endsWith('/api/transfer-token'))!;
  const broken=proofs.find(p=>p.target.endsWith('/api/transfer-broken'))!;
  assert.ok(unguarded&&guarded&&broken,JSON.stringify(proofs.map(p=>p.target)));
  assert.equal(unguarded.outcome,'observed',JSON.stringify(unguarded));
  assert.equal(unguarded.observations.appliedCrossOrigin,true);
  assert.equal(unguarded.observations.controlStatus,200);
  assert.equal(unguarded.observations.probeSent,true);
  assert.equal(unguarded.observations.sessionCookieSameSite,'None');
  assert.equal(guarded.outcome,'not_observed',JSON.stringify(guarded));
  assert.equal(guarded.observations.probeStatus,403);
  assert.equal(guarded.observations.appliedCrossOrigin,false);
  assert.equal(broken.outcome,'inconclusive');
  assert.match(String(broken.summary),/control submission was not accepted/);
  const finding=first.findings.find(f=>f.check.startsWith('csrf_')&&f.verdict==='finding');
  assert.ok(finding,JSON.stringify(first.findings));
  assert.equal(finding.severity,'high');
  const transferPosts=first.evidence.filter(e=>e.method==='POST'&&e.url.endsWith('/api/transfer'));
  assert.equal(transferPosts.length,2,'one same-origin control plus one cross-origin probe');
  assert.ok(transferPosts.every(e=>e.postPolicy==='/api/transfer'));
  assert.equal(balance,99000,'100000 - 500 (same-origin control) - 500 (cross-origin probe)');
  assert.equal(tokenBalance,49700,'50000 - 300 (same-origin control only; the token guard rejected the probe)');
  const module=first.diagnostics?.modules.find(m=>m.id==='csrf');
  assert.equal(module?.state,'incomplete');assert.equal(module?.planned,3);assert.equal(module?.conclusive,2);assert.equal(module?.inconclusive,1);
  assert.ok(first.covered.some(k=>k.includes('/api/transfer')&&k.includes('csrf_')));
  for(const secret of ['victim-session'])assert.ok(!JSON.stringify(first).includes(secret),'session values must be redacted');
  fixed=true;balance=100000;tokenBalance=50000;
  const second=await finish(retestAssessment(root,first.id,{authorized:true,auth:input.auth,browserSecrets:input.browserSecrets}).id);
  assert.ok(second.comparison?.notObserved.includes(finding.fingerprint),JSON.stringify(second.comparison));
  const secondUnguarded=(second.browser?.proofs??[]).filter(p=>p.kind==='csrf').find(p=>p.target.endsWith('/api/transfer'))!;
  assert.equal(secondUnguarded.outcome,'not_observed');
  assert.equal(balance,99500,'only the same-origin control applies once the session cookie is Lax');
  console.log('PASS csrf: same-origin control under the victim session, cross-origin probe applied through a SameSite=None session cookie, token guard rejecting the probe, broken control inconclusive, POST policy evidence, redaction, diagnostics module and repaired retest');
}finally{server.closeAllConnections();server.close();}
