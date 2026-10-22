import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {startAssessment,readAssessment,retestAssessment} from '../security/assessments.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-security-race-'));
let vulnerableClaims=0,lockedClaims=0,twoClaims=0,fixed=false;
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url!,'http://localhost');
  await new Promise<void>(resolve=>{req.on('data',()=>{});req.on('end',resolve);});
  const json=(status:number,payload:unknown)=>{res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(payload));};
  if(req.method==='POST'&&url.pathname==='/api/claim-v'){
    if(fixed){if(vulnerableClaims>=1)return json(409,{error:'already claimed'});vulnerableClaims++;return json(201,{claimed:vulnerableClaims});}
    // Vulnerable check-then-act: the async gap lets every concurrent request pass the bound check.
    if(vulnerableClaims>=1)return json(409,{error:'already claimed'});
    await new Promise(r=>setTimeout(r,25));
    vulnerableClaims++;return json(201,{claimed:vulnerableClaims});
  }
  if(req.method==='POST'&&url.pathname==='/api/claim-l'){
    // Synchronous check-and-set before any await: atomic under concurrency.
    if(lockedClaims>=1)return json(409,{error:'already claimed'});
    lockedClaims++;return json(201,{claimed:lockedClaims});
  }
  if(req.method==='POST'&&url.pathname==='/api/claim-two'){
    if(twoClaims>=2)return json(409,{error:'quota reached'});
    twoClaims++;return json(201,{claimed:twoClaims});
  }
  if(req.method==='POST'&&url.pathname==='/api/claim-none')return json(403,{error:'not permitted'});
  if(req.method==='GET'&&url.pathname==='/api/summary')return json(200,{vulnerableClaims,lockedClaims,twoClaims,none:0});
  if(url.pathname==='/'&&req.method==='GET'){res.setHeader('content-type','text/html');res.end('<!doctype html><title>fixture</title>');return;}
  res.writeHead(404).end();
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const target='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;
const finish=async(id:string)=>{const deadline=Date.now()+60000;while(Date.now()<deadline){const r=readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,50));}throw Error('race assessment timed out');};
const businessRaces=[
  {id:'singleUseVulnerable',path:'/api/claim-v',bodyRef:'claimBody',statePath:'/api/summary',statePointer:'/vulnerableClaims',stateDelta:1,concurrency:4,allowed:1},
  {id:'singleUseProtected',path:'/api/claim-l',bodyRef:'claimBody',statePath:'/api/summary',statePointer:'/lockedClaims',stateDelta:1,concurrency:4,allowed:1},
  {id:'boundOfTwo',path:'/api/claim-two',bodyRef:'claimBody',statePath:'/api/summary',statePointer:'/twoClaims',stateDelta:1,concurrency:4,allowed:2},
  {id:'noValidExecution',path:'/api/claim-none',bodyRef:'claimBody',statePath:'/api/summary',statePointer:'/none',stateDelta:1,concurrency:2,allowed:1},
];
const businessSecrets={claimBody:JSON.stringify({coupon:'fixture-claim-secret'})};
const input={target,authorized:true,checks:['server_banner'],profile:'campaign' as const,scope:{delayMs:0,maxRequests:300},businessRaces,businessSecrets};
try{
  assert.throws(()=>startAssessment(root,{...input,profile:'quick' as any}),/campaign mode/);
  assert.throws(()=>startAssessment(root,{...input,businessRaces:[{...businessRaces[0]!,concurrency:1}]}),/2–4 parallel submissions/);
  assert.throws(()=>startAssessment(root,{...input,businessRaces:[{...businessRaces[0]!,concurrency:5}]}),/2–4 parallel submissions/);
  assert.throws(()=>startAssessment(root,{...input,businessRaces:[{...businessRaces[0]!,allowed:0}]}),/1–concurrency/);
  assert.throws(()=>startAssessment(root,{...input,businessRaces:[{...businessRaces[0]!,allowed:5}]}),/1–concurrency/);
  assert.throws(()=>startAssessment(root,{...input,scope:{...input.scope,exclusions:['/api']}}),/outside the approved scope/);
  assert.throws(()=>startAssessment(root,{...input,businessSecrets:{}}),/fresh (business )?input/);
  const first=await finish(startAssessment(root,input).id);
  assert.equal(first.status,'partial',JSON.stringify({business:first.business,findings:first.findings.map(f=>f.check+':'+f.verdict)}));
  assert.equal(first.completed,first.total,'progress accounting must include race cases');
  const proofs=first.business?.proofs??[];
  const vulnerable=proofs.find(p=>p.caseId==='singleUseVulnerable'),locked=proofs.find(p=>p.caseId==='singleUseProtected'),two=proofs.find(p=>p.caseId==='boundOfTwo'),none=proofs.find(p=>p.caseId==='noValidExecution');
  assert.equal(vulnerable?.kind,'business_race');
  assert.equal(vulnerable?.outcome,'observed',JSON.stringify(vulnerable));
  assert.equal(vulnerable?.observations.appliedExecutions,4,'all four concurrent submissions passed the check-then-act bound');
  assert.equal(vulnerable?.observations.acceptedSubmissions,4);
  assert.equal(locked?.outcome,'not_observed',JSON.stringify(locked));
  assert.equal(locked?.observations.appliedExecutions,1);
  assert.equal(locked?.observations.acceptedSubmissions,1);
  assert.equal(two?.outcome,'not_observed',JSON.stringify(two));
  assert.equal(two?.observations.appliedExecutions,2);
  assert.equal(two?.observations.allowed,2);
  assert.equal(none?.outcome,'inconclusive');
  assert.match(String(none?.summary),/could not establish that a valid execution is possible/);
  const finding=first.findings.find(f=>f.check.startsWith('business_race_')&&f.verdict==='finding');
  assert.ok(finding,JSON.stringify(first.findings));
  assert.ok(finding.target.includes('/api/claim-v'));
  assert.ok(first.findings.some(f=>f.check==='business_coverage'&&f.verdict==='error'));
  const claimVPosts=first.evidence.filter(e=>e.method==='POST'&&e.url.endsWith('/api/claim-v'));
  assert.equal(claimVPosts.length,4);
  assert.ok(claimVPosts.every(e=>e.postPolicy==='/api/claim-v'&&e.requestBytes!>0&&!e.error));
  const burstTimes=claimVPosts.map(e=>Date.parse(e.at));
  assert.ok(Math.max(...burstTimes)-Math.min(...burstTimes)<2000,'the burst must be released simultaneously, not paced');
  assert.equal(vulnerableClaims,4);assert.equal(lockedClaims,1);assert.equal(twoClaims,2);
  const module=first.diagnostics?.modules.find(m=>m.id==='business');
  assert.equal(module?.state,'incomplete');assert.equal(module?.planned,4);assert.equal(module?.conclusive,3);assert.equal(module?.inconclusive,1);
  assert.ok(first.diagnostics?.reasons.some(r=>r.includes('منطق الأعمال')));
  assert.ok(first.covered.some(k=>k.includes('/api/claim-l')&&k.includes('business_race_')));
  assert.ok(!JSON.stringify(first).includes('fixture-claim-secret'),'race body values must be redacted');
  assert.throws(()=>retestAssessment(root,first.id,{authorized:true}),/fresh (business )?input/);
  fixed=true;vulnerableClaims=0;lockedClaims=0;twoClaims=0;
  const second=await finish(retestAssessment(root,first.id,{authorized:true,businessSecrets}).id);
  assert.ok(second.comparison?.notObserved.includes(finding.fingerprint),JSON.stringify(second.comparison));
  assert.equal(second.business?.proofs.find(p=>p.caseId==='singleUseVulnerable')?.outcome,'not_observed');
  assert.equal(vulnerableClaims,1,'a repaired atomic bound applies the operation exactly once under concurrency');
  console.log('PASS business races: simultaneous burst exceeded a check-then-act bound, atomic bound and declared bound of two held, all-rejected control inconclusive, POST policy and burst-timing evidence, redaction, diagnostics module and repaired retest');
}finally{server.closeAllConnections();server.close();}
