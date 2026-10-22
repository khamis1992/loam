import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {startAssessment,readAssessment,retestAssessment} from '../security/assessments.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-security-quota-'));
let freebies=0,votes=0,tight=0,fixedFreebies=false;
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url!,'http://localhost');
  await new Promise<void>(resolve=>{req.on('data',()=>{});req.on('end',resolve);});
  const json=(status:number,payload:unknown)=>{res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(payload));};
  if(url.pathname==='/api/freebies'&&req.method==='POST'){
    if(fixedFreebies&&freebies>=3)return json(403,{error:'quota exhausted'});
    freebies++;return json(201,{ok:true,freebies});
  }
  if(url.pathname==='/api/votes'&&req.method==='POST'){
    if(votes>=3)return json(429,{error:'vote quota exhausted'});
    votes++;return json(201,{ok:true,votes});
  }
  if(url.pathname==='/api/tight'&&req.method==='POST'){
    if(tight>=2)return json(403,{error:'quota exhausted'});
    tight++;return json(201,{ok:true,tight});
  }
  if(url.pathname==='/api/summary'&&req.method==='GET')return json(200,{freebies,votes,tight});
  if(url.pathname==='/'&&req.method==='GET'){res.setHeader('content-type','text/html');res.end('<!doctype html><title>fixture</title>');return;}
  res.writeHead(404).end();
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const target='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;
const finish=async(id:string)=>{const deadline=Date.now()+60000;while(Date.now()<deadline){const r=readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,50));}throw Error('quota assessment timed out');};
const quotas=[
  {id:'freebieQuota',path:'/api/freebies',bodyRef:'freebieBody',statePath:'/api/summary',statePointer:'/freebies',stateDelta:1,limit:3},
  {id:'voteQuota',path:'/api/votes',bodyRef:'voteBody',statePath:'/api/summary',statePointer:'/votes',stateDelta:1,limit:3},
  {id:'tightControl',path:'/api/tight',bodyRef:'tightBody',statePath:'/api/summary',statePointer:'/tight',stateDelta:1,limit:3},
];
const businessSecrets={freebieBody:JSON.stringify({claim:'fixture-freebie-secret'}),voteBody:JSON.stringify({choice:'fixture-vote-secret'}),tightBody:JSON.stringify({use:'fixture-tight-secret'})};
const input={target,authorized:true,checks:['server_banner'],profile:'campaign' as const,scope:{delayMs:0,maxRequests:300},businessQuotas:quotas,businessSecrets};
try{
  assert.throws(()=>startAssessment(root,{...input,profile:'quick' as any}),/campaign mode/);
  assert.throws(()=>startAssessment(root,{...input,scope:{...input.scope,exclusions:['/api']}}),/outside the approved scope/);
  assert.throws(()=>startAssessment(root,{...input,businessSecrets:{}}),/fresh (business )?input/);
  assert.throws(()=>startAssessment(root,{...input,businessQuotas:[{...quotas[0]!,limit:0}]}),/1–20/);
  assert.throws(()=>startAssessment(root,{...input,businessQuotas:[{...quotas[0]!,limit:21}]}),/1–20/);
  assert.throws(()=>startAssessment(root,{...input,businessQuotas:[{...quotas[0]!,path:'/api/freebies?x=1'}]}),/exact POST path/);
  const first=await finish(startAssessment(root,input).id);
  assert.equal(first.status,'partial',JSON.stringify({business:first.business,findings:first.findings.map(f=>f.check+':'+f.verdict)}));
  assert.equal(first.completed,first.total,'progress accounting must include quota cases');
  const proofs=first.business?.proofs??[];
  const freebie=proofs.find(p=>p.caseId==='freebieQuota'),vote=proofs.find(p=>p.caseId==='voteQuota'),tightProof=proofs.find(p=>p.caseId==='tightControl');
  assert.equal(freebie?.kind,'business_quota');
  assert.equal(freebie?.outcome,'observed',JSON.stringify(freebie));
  assert.equal(freebie?.observations.appliedBeyondLimit,1);
  assert.equal(freebie?.observations.excessStatus,201);
  assert.equal(vote?.outcome,'not_observed',JSON.stringify(vote));
  assert.equal(vote?.observations.excessStatus,429);
  assert.equal(vote?.observations.appliedBeyondLimit,0);
  assert.equal(tightProof?.outcome,'inconclusive');
  assert.match(String(tightProof?.summary),/enforced limit may be lower/);
  const finding=first.findings.find(f=>f.check.startsWith('business_quota_')&&f.verdict==='finding');
  assert.ok(finding,JSON.stringify(first.findings));
  assert.ok(finding.target.includes('/api/freebies'));
  assert.ok(first.findings.some(f=>f.check==='business_coverage'&&f.verdict==='error'));
  const freebiePosts=first.evidence.filter(e=>e.method==='POST'&&e.url.endsWith('/api/freebies'));
  assert.equal(freebiePosts.length,4,'limit plus one excess submission');
  assert.ok(freebiePosts.every(e=>e.postPolicy==='/api/freebies'&&e.requestBytes!==undefined&&e.requestBytes!>0&&!e.error));
  assert.equal(freebies,4);assert.equal(votes,3);assert.equal(tight,2);
  const module=first.diagnostics?.modules.find(m=>m.id==='business');
  assert.equal(module?.state,'incomplete');assert.equal(module?.planned,3);assert.equal(module?.conclusive,2);assert.equal(module?.inconclusive,1);
  assert.ok(first.diagnostics?.reasons.some(r=>r.includes('منطق الأعمال')));
  assert.ok(first.covered.some(k=>k.includes('/api/freebies')&&k.includes('business_quota_')));
  for(const secret of ['fixture-freebie-secret','fixture-vote-secret','fixture-tight-secret'])assert.ok(!JSON.stringify(first).includes(secret),'quota body values must be redacted');
  assert.throws(()=>retestAssessment(root,first.id,{authorized:true}),/fresh (business )?input/);
  freebies=0;votes=0;tight=0;fixedFreebies=true;
  const second=await finish(retestAssessment(root,first.id,{authorized:true,businessSecrets}).id);
  assert.ok(second.comparison?.notObserved.includes(finding.fingerprint),JSON.stringify(second.comparison));
  assert.equal(freebies,3,'a repaired quota applies exactly the declared limit');
  assert.equal(second.business?.proofs.find(p=>p.caseId==='freebieQuota')?.outcome,'not_observed');
  votes=0;fixedFreebies=false;
  const budget=await finish(startAssessment(root,{...input,businessQuotas:[quotas[1]!],scope:{delayMs:0,maxRequests:10}}).id);
  assert.equal(budget.status,'partial');
  const budgetProof=budget.business?.proofs.find(p=>p.caseId==='voteQuota');
  assert.equal(budgetProof?.outcome,'inconclusive','request budget exhaustion must stay inconclusive');
  assert.ok(!budget.findings.some(f=>f.id==='business-error'),'engine must survive budget exhaustion without crashing');
  assert.ok(budget.findings.some(f=>f.check==='business_coverage'&&f.verdict==='error'));
  console.log('PASS business quotas: declared-limit positive controls, excess submission observed beyond an unenforced quota, enforced rejection at 429, lower enforced limit surfaced as inconclusive, POST policy evidence, redaction, budget-exhaustion resilience, diagnostics module and repaired retest');
}finally{server.closeAllConnections();server.close();}
