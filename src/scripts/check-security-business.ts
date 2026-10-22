import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {startAssessment,readAssessment,retestAssessment} from '../security/assessments.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-security-business-'));
let orders=0,payments=0,fixed=false,lastOrderBody='',lastOrderAt=0,lastPaymentBody='',lastPaymentAt=0;
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url!,'http://localhost');
  const body=await new Promise<string>(resolve=>{let data='';req.on('data',chunk=>data+=chunk);req.on('end',()=>resolve(data));});
  const duplicate=(last:string,at:number)=>body===last&&Date.now()-at<1000;
  if(url.pathname==='/api/orders'&&req.method==='POST'){
    if(fixed&&duplicate(lastOrderBody,lastOrderAt)){res.writeHead(409,{'content-type':'application/json'}).end('{"error":"duplicate order"}');return;}
    lastOrderBody=body;lastOrderAt=Date.now();orders++;
    res.writeHead(201,{'content-type':'application/json'}).end(JSON.stringify({ok:true,orders}));return;
  }
  if(url.pathname==='/api/payments'&&req.method==='POST'){
    if(duplicate(lastPaymentBody,lastPaymentAt)){res.writeHead(409,{'content-type':'application/json'}).end('{"error":"duplicate payment"}');return;}
    lastPaymentBody=body;lastPaymentAt=Date.now();payments++;
    res.writeHead(201,{'content-type':'application/json'}).end(JSON.stringify({ok:true,payments}));return;
  }
  if(url.pathname==='/api/noop'&&req.method==='POST'){res.writeHead(200,{'content-type':'application/json'}).end('{}');return;}
  if(url.pathname==='/api/summary'&&req.method==='GET'){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({orders,payments,noop:0}));return;}
  if(url.pathname==='/'&&req.method==='GET'){res.setHeader('content-type','text/html');res.end('<!doctype html><title>fixture</title>');return;}
  res.writeHead(404).end();
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const target='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;
const finish=async(id:string)=>{const deadline=Date.now()+60000;while(Date.now()<deadline){const r=readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,50));}throw Error('business assessment timed out');};
const business=[
  {id:'orderReplay',path:'/api/orders',bodyRef:'orderBody',statePath:'/api/summary',statePointer:'/orders',stateDelta:1,replays:2},
  {id:'paymentIdempotency',path:'/api/payments',bodyRef:'paymentBody',statePath:'/api/summary',statePointer:'/payments',stateDelta:1,replays:2},
  {id:'brokenControl',path:'/api/noop',bodyRef:'noopBody',statePath:'/api/summary',statePointer:'/noop',stateDelta:1,replays:1},
];
const businessSecrets={orderBody:JSON.stringify({item:'fixture-order-secret',quantity:1}),paymentBody:JSON.stringify({amount:500,reference:'fixture-payment-secret'}),noopBody:'{}'};
const input={target,authorized:true,checks:['server_banner'],profile:'campaign' as const,scope:{delayMs:0,maxRequests:200},business,businessSecrets};
try{
  assert.throws(()=>startAssessment(root,{...input,profile:'quick' as any}),/campaign mode/);
  assert.throws(()=>startAssessment(root,{...input,scope:{...input.scope,exclusions:['/api']}}),/outside the approved scope/);
  assert.throws(()=>startAssessment(root,{...input,businessSecrets:{}}),/fresh (business )?input/);
  assert.throws(()=>startAssessment(root,{...input,businessSecrets:{...businessSecrets,orderBody:'not json'}}),/valid JSON/);
  assert.throws(()=>startAssessment(root,{...input,business:[{...business[0]!,replays:4}]}),/1–3/);
  assert.throws(()=>startAssessment(root,{...input,business:[{...business[0]!,path:'/api/orders?x=1'}]}),/exact POST path/);
  const first=await finish(startAssessment(root,input).id);
  assert.equal(first.status,'partial',JSON.stringify({business:first.business,findings:first.findings.map(f=>f.check+':'+f.verdict)}));
  assert.equal(first.completed,first.total,'progress accounting must include business cases');
  const proofs=first.business?.proofs??[];
  const order=proofs.find(p=>p.caseId==='orderReplay'),payment=proofs.find(p=>p.caseId==='paymentIdempotency'),noop=proofs.find(p=>p.caseId==='brokenControl');
  assert.equal(order?.outcome,'observed',JSON.stringify(order));
  assert.equal(order?.observations.appliedAdditional,2);
  assert.equal(payment?.outcome,'not_observed',JSON.stringify(payment));
  assert.equal(payment?.observations.rejectedReplays,2);
  assert.equal(payment?.observations.appliedAdditional,0);
  assert.equal(noop?.outcome,'inconclusive');
  assert.match(String(noop?.summary),/Positive control failed/);
  const finding=first.findings.find(f=>f.check.startsWith('business_replay_')&&f.verdict==='finding');
  assert.ok(finding,JSON.stringify(first.findings));
  assert.ok(finding.target.includes('/api/orders'));
  assert.ok(first.findings.some(f=>f.check==='business_coverage'&&f.verdict==='error'));
  const orderPosts=first.evidence.filter(e=>e.method==='POST'&&e.url.endsWith('/api/orders'));
  assert.equal(orderPosts.length,3);
  assert.ok(orderPosts.every(e=>e.postPolicy==='/api/orders'&&e.requestBytes!==undefined&&e.requestBytes!>0&&!e.error));
  assert.equal(orders,3);assert.equal(payments,1);
  const stateGets=first.evidence.filter(e=>e.method==='GET'&&e.url.endsWith('/api/summary'));
  assert.equal(stateGets.length,8,'control-failure cases stop before the replay phase');
  assert.ok(first.covered.some(k=>k.includes('/api/orders')&&k.includes('business_replay_')));
  const module=first.diagnostics?.modules.find(m=>m.id==='business');
  assert.equal(module?.state,'incomplete','an inconclusive case keeps the module incomplete');assert.equal(module?.planned,3);assert.equal(module?.conclusive,2);assert.equal(module?.inconclusive,1);
  assert.ok(first.diagnostics?.reasons.some(r=>r.includes('منطق الأعمال')));
  for(const secret of ['fixture-order-secret','fixture-payment-secret'])assert.ok(!JSON.stringify(first).includes(secret),'business body values must be redacted');
  assert.throws(()=>retestAssessment(root,first.id,{authorized:true}),/fresh (business )?input/);
  fixed=true;lastOrderAt=0; // expire the fixture dedup window so the retest positive control can apply once
  const beforeOrders=orders;
  const second=await finish(retestAssessment(root,first.id,{authorized:true,businessSecrets}).id);
  assert.ok(second.comparison?.notObserved.includes(finding.fingerprint),JSON.stringify(second.comparison));
  assert.equal(orders,beforeOrders+1,'a repaired operation applies once and rejects replays');
  assert.equal(second.business?.proofs.find(p=>p.caseId==='orderReplay')?.outcome,'not_observed');
  console.log('PASS business logic: replay duplication observed with positive state control, idempotent duplicate rejection, inconclusive control failure surfaced, scoped POST policy evidence, redaction, budget accounting, diagnostics module and repaired retest');
}finally{server.closeAllConnections();server.close();}
