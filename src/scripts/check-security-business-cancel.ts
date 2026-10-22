import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {startAssessment,readAssessment,retestAssessment} from '../security/assessments.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-security-cancel-'));
let balance=100000,fixed=false;
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url!,'http://localhost');
  await new Promise<void>(resolve=>{req.on('data',()=>{});req.on('end',resolve);});
  const json=(status:number,payload:unknown)=>{res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(payload));};
  const charge=(amount:number)=>{balance-=amount;};
  const refund=(amount:number)=>{balance+=amount;};
  if(req.method==='POST'&&url.pathname==='/api/order-good'){charge(4500);return json(200,{charged:4500});}
  if(req.method==='POST'&&url.pathname==='/api/refund-good'){refund(4500);return json(200,{refunded:4500});}
  if(req.method==='POST'&&url.pathname==='/api/order-restock'){charge(5000);return json(200,{charged:5000});}
  if(req.method==='POST'&&url.pathname==='/api/refund-restock'){refund(4000);return json(200,{refunded:4000});}
  if(req.method==='POST'&&url.pathname==='/api/order-bad'){charge(4500);return json(200,{charged:4500});}
  if(req.method==='POST'&&url.pathname==='/api/refund-bad'){refund(fixed?4500:2000);return json(200,{refunded:fixed?4500:2000});}
  if(req.method==='POST'&&url.pathname==='/api/order-reject'){charge(2500);return json(200,{charged:2500});}
  if(req.method==='POST'&&url.pathname==='/api/refund-reject'){return json(403,{error:'not refundable'});}
  if(req.method==='POST'&&url.pathname==='/api/order-rba'){charge(1500);return json(200,{charged:1500});}
  if(req.method==='POST'&&url.pathname==='/api/refund-rba'){refund(fixed?1500:999);return json(409,{error:'rejected'});}
  if(req.method==='GET'&&url.pathname==='/api/wallet')return json(200,{balance,currency:'cents'});
  if(url.pathname==='/'&&req.method==='GET'){res.setHeader('content-type','text/html');res.end('<!doctype html><title>fixture</title>');return;}
  res.writeHead(404).end();
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const target='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;
const finish=async(id:string)=>{const deadline=Date.now()+60000;while(Date.now()<deadline){const r=readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,50));}throw Error('cancel assessment timed out');};
const businessCancels=[
  {id:'fullRollback',operationPath:'/api/order-good',operationBodyRef:'goodOrder',cancelPath:'/api/refund-good',cancelBodyRef:'goodRefund',statePath:'/api/wallet',statePointer:'/balance',stateDelta:-4500},
  {id:'declaredRestockingFee',operationPath:'/api/order-restock',operationBodyRef:'restockOrder',cancelPath:'/api/refund-restock',cancelBodyRef:'restockRefund',statePath:'/api/wallet',statePointer:'/balance',stateDelta:-5000,expectedCompensation:4000},
  {id:'shortRefund',operationPath:'/api/order-bad',operationBodyRef:'badOrder',cancelPath:'/api/refund-bad',cancelBodyRef:'badRefund',statePath:'/api/wallet',statePointer:'/balance',stateDelta:-4500},
  {id:'rejectedRefund',operationPath:'/api/order-reject',operationBodyRef:'rejectOrder',cancelPath:'/api/refund-reject',cancelBodyRef:'rejectRefund',statePath:'/api/wallet',statePointer:'/balance',stateDelta:-2500},
  {id:'rejectedButApplied',operationPath:'/api/order-rba',operationBodyRef:'rbaOrder',cancelPath:'/api/refund-rba',cancelBodyRef:'rbaRefund',statePath:'/api/wallet',statePointer:'/balance',stateDelta:-1500},
];
const businessSecrets={goodOrder:JSON.stringify({item:'fixture-goodorder-secret'}),goodRefund:JSON.stringify({reason:'fixture-goodrefund-secret'}),restockOrder:JSON.stringify({item:'fixture-restockorder-secret'}),restockRefund:JSON.stringify({reason:'fixture-restockrefund-secret'}),badOrder:JSON.stringify({item:'fixture-badorder-secret'}),badRefund:JSON.stringify({reason:'fixture-badrefund-secret'}),rejectOrder:JSON.stringify({item:'fixture-rejectorder-secret'}),rejectRefund:JSON.stringify({reason:'fixture-rejectrefund-secret'}),rbaOrder:JSON.stringify({item:'fixture-rbaorder-secret'}),rbaRefund:JSON.stringify({reason:'fixture-rbarefund-secret'})};
const input={target,authorized:true,checks:['server_banner'],profile:'campaign' as const,scope:{delayMs:0,maxRequests:300},businessCancels,businessSecrets};
try{
  assert.throws(()=>startAssessment(root,{...input,profile:'quick' as any}),/campaign mode/);
  assert.throws(()=>startAssessment(root,{...input,businessCancels:[{...businessCancels[0]!,expectedCompensation:0}]}),/nonzero integer/);
  assert.throws(()=>startAssessment(root,{...input,businessCancels:[{...businessCancels[0]!,stateDelta:10000000000000}]}),/nonzero integer/);
  assert.throws(()=>startAssessment(root,{...input,scope:{...input.scope,exclusions:['/api']}}),/outside the approved scope/);
  assert.throws(()=>startAssessment(root,{...input,businessCancels:[{...businessCancels[0]!,cancelPath:'/api/refund-good?x=1'}]}),/exact cancel path/);
  assert.throws(()=>startAssessment(root,{...input,businessSecrets:{}}),/fresh (business )?input/);
  const first=await finish(startAssessment(root,input).id);
  assert.equal(first.status,'partial',JSON.stringify({business:first.business,findings:first.findings.map(f=>f.check+':'+f.verdict)}));
  assert.equal(first.completed,first.total,'progress accounting must include cancel cases');
  const proofs=first.business?.proofs??[];
  const full=proofs.find(p=>p.caseId==='fullRollback'),restock=proofs.find(p=>p.caseId==='declaredRestockingFee'),short=proofs.find(p=>p.caseId==='shortRefund'),rejected=proofs.find(p=>p.caseId==='rejectedRefund'),rba=proofs.find(p=>p.caseId==='rejectedButApplied');
  assert.equal(full?.kind,'business_cancel');
  assert.equal(full?.outcome,'not_observed',JSON.stringify(full));
  assert.equal(full?.observations.stateBefore,full?.observations.stateAfterCancel);
  assert.equal(full?.observations.moved,4500);
  assert.equal(restock?.outcome,'not_observed',JSON.stringify(restock));
  assert.equal(restock?.observations.expectedCompensation,4000);
  assert.equal(short?.outcome,'observed',JSON.stringify(short));
  assert.equal(short?.observations.moved,2000);
  assert.equal(rejected?.outcome,'inconclusive');
  assert.match(String(rejected?.summary),/rejected.*did not change|review whether this operation is cancellable/);
  assert.equal(rba?.outcome,'observed',JSON.stringify(rba));
  assert.equal(rba?.observations.cancelStatus,409);
  assert.equal(rba?.observations.moved,999);
  const findings=first.findings.filter(f=>f.check.startsWith('business_cancel_')&&f.verdict==='finding');
  assert.equal(findings.length,2,JSON.stringify(first.findings));
  assert.ok(findings.some(f=>f.target.includes('/api/refund-bad')&&f.title.includes('did not restore')));
  assert.ok(findings.some(f=>f.target.includes('/api/refund-rba')&&f.title.includes('Rejected')));
  assert.ok(first.findings.some(f=>f.check==='business_coverage'&&f.verdict==='error'));
  const posts=first.evidence.filter(e=>e.method==='POST');
  assert.equal(posts.length,10,'five operations plus five cancel requests');
  assert.ok(posts.every(e=>e.postPolicy&&e.requestBytes!>0&&!e.error));
  assert.equal(balance,93499,'100000 -4500 +4500 -5000 +4000 -4500 +2000 -2500 -1500 +999');
  const module=first.diagnostics?.modules.find(m=>m.id==='business');
  assert.equal(module?.state,'incomplete');assert.equal(module?.planned,5);assert.equal(module?.conclusive,4);assert.equal(module?.inconclusive,1);
  assert.ok(first.diagnostics?.reasons.some(r=>r.includes('منطق الأعمال')));
  assert.ok(first.covered.some(k=>k.includes('/api/refund-good')&&k.includes('business_cancel_')));
  for(const secret of Object.values({a:'fixture-goodorder-secret',b:'fixture-badrefund-secret',c:'fixture-rbarefund-secret'}))assert.ok(!JSON.stringify(first).includes(secret),'cancel body values must be redacted');
  assert.throws(()=>retestAssessment(root,first.id,{authorized:true}),/fresh (business )?input/);
  fixed=true;balance=100000;
  const second=await finish(retestAssessment(root,first.id,{authorized:true,businessSecrets}).id);
  for(const f of findings)assert.ok(second.comparison?.notObserved.includes(f.fingerprint),JSON.stringify(second.comparison));
  assert.equal(second.business?.proofs.find(p=>p.caseId==='shortRefund')?.outcome,'not_observed');
  const rbaRetest=second.business?.proofs.find(p=>p.caseId==='rejectedButApplied');
  assert.equal(rbaRetest?.outcome,'not_observed');
  assert.match(String(rbaRetest?.summary),/although the cancel request returned HTTP 409/,'a correct compensation applied under rejection is not a defect');
  assert.equal(balance,96500,'100000 -4500 +4500 -5000 +4000 -4500 +4500 -2500 -1500 +1500');
  console.log('PASS business cancel: full rollback restored the witness exactly, declared partial compensation honored, short refund and rejected-but-applied refunds observed, honest inconclusive for policy-rejected refunds, POST policy evidence, redaction, diagnostics module and repaired retest');
}finally{server.closeAllConnections();server.close();}
