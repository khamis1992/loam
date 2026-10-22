import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {startAssessment,readAssessment,retestAssessment} from '../security/assessments.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-security-pricing-'));
let balance=100000,fixed=false;
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url!,'http://localhost');
  await new Promise<void>(resolve=>{req.on('data',()=>{});req.on('end',resolve);});
  const json=(status:number,payload:unknown)=>{res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(payload));};
  if(req.method==='POST'&&url.pathname==='/api/checkout-good'){balance-=4500;return json(200,{charged:4500});}
  if(req.method==='POST'&&url.pathname==='/api/checkout-bad'){balance-=fixed?4500:5000;return json(200,{charged:fixed?4500:5000});}
  if(req.method==='POST'&&url.pathname==='/api/purchase-credit'){balance+=fixed?-300:300;return json(200,{applied:fixed?-300:300});}
  if(req.method==='POST'&&url.pathname==='/api/checkout-zero'){return json(200,{charged:0});}
  if(req.method==='GET'&&url.pathname==='/api/wallet')return json(200,{balance,currency:'cents'});
  if(url.pathname==='/'&&req.method==='GET'){res.setHeader('content-type','text/html');res.end('<!doctype html><title>fixture</title>');return;}
  res.writeHead(404).end();
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const target='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;
const finish=async(id:string)=>{const deadline=Date.now()+60000;while(Date.now()<deadline){const r=readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,50));}throw Error('pricing assessment timed out');};
const businessPricing=[
  {id:'pricedCheckout',path:'/api/checkout-good',bodyRef:'goodBody',statePath:'/api/wallet',statePointer:'/balance',stateDelta:-4500},
  {id:'overchargedCheckout',path:'/api/checkout-bad',bodyRef:'badBody',statePath:'/api/wallet',statePointer:'/balance',stateDelta:-4500},
  {id:'invertedCredit',path:'/api/purchase-credit',bodyRef:'creditBody',statePath:'/api/wallet',statePointer:'/balance',stateDelta:-300},
  {id:'unresponsiveWitness',path:'/api/checkout-zero',bodyRef:'zeroBody',statePath:'/api/wallet',statePointer:'/balance',stateDelta:-1200},
];
const businessSecrets={goodBody:JSON.stringify({item:'fixture-good-secret',quantity:2,coupon:'fixture-coupon-secret'}),badBody:JSON.stringify({item:'fixture-bad-secret',quantity:2,coupon:'fixture-coupon-secret'}),creditBody:JSON.stringify({item:'fixture-credit-secret'}),zeroBody:JSON.stringify({item:'fixture-zero-secret'})};
const input={target,authorized:true,checks:['server_banner'],profile:'campaign' as const,scope:{delayMs:0,maxRequests:300},businessPricing,businessSecrets};
try{
  assert.throws(()=>startAssessment(root,{...input,profile:'quick' as any}),/campaign mode/);
  assert.throws(()=>startAssessment(root,{...input,businessPricing:[{...businessPricing[0]!,stateDelta:0}]}),/nonzero integer/);
  assert.throws(()=>startAssessment(root,{...input,businessPricing:[{...businessPricing[0]!,stateDelta:10000000000000}]}),/nonzero integer/);
  assert.throws(()=>startAssessment(root,{...input,scope:{...input.scope,exclusions:['/api']}}),/outside the approved scope/);
  assert.throws(()=>startAssessment(root,{...input,businessSecrets:{}}),/fresh (business )?input/);
  const first=await finish(startAssessment(root,input).id);
  assert.equal(first.status,'partial',JSON.stringify({business:first.business,findings:first.findings.map(f=>f.check+':'+f.verdict)}));
  assert.equal(first.completed,first.total,'progress accounting must include pricing cases');
  const proofs=first.business?.proofs??[];
  const good=proofs.find(p=>p.caseId==='pricedCheckout'),over=proofs.find(p=>p.caseId==='overchargedCheckout'),credit=proofs.find(p=>p.caseId==='invertedCredit'),zero=proofs.find(p=>p.caseId==='unresponsiveWitness');
  assert.equal(good?.kind,'business_pricing');
  assert.equal(good?.outcome,'not_observed',JSON.stringify(good));
  assert.equal(good?.observations.moved,-4500);
  assert.equal(over?.outcome,'observed',JSON.stringify(over));
  assert.equal(over?.observations.moved,-5000);
  assert.equal(over?.observations.directionReversed,false);
  assert.equal(credit?.outcome,'observed',JSON.stringify(credit));
  assert.equal(credit?.observations.moved,300);
  assert.equal(credit?.observations.directionReversed,true);
  assert.equal(zero?.outcome,'inconclusive');
  assert.match(String(zero?.summary),/did not move/);
  const findings=first.findings.filter(f=>f.check.startsWith('business_pricing_')&&f.verdict==='finding');
  assert.equal(findings.length,2,JSON.stringify(first.findings));
  assert.ok(findings.some(f=>f.target.includes('/api/checkout-bad')));
  assert.ok(findings.some(f=>f.target.includes('/api/purchase-credit')&&f.title.includes('opposite direction')));
  assert.ok(first.findings.some(f=>f.check==='business_coverage'&&f.verdict==='error'));
  const posts=first.evidence.filter(e=>e.method==='POST');
  assert.equal(posts.length,4);
  assert.ok(posts.every(e=>e.postPolicy&&e.requestBytes!>0&&!e.error));
  assert.equal(balance,90800,'100000 - 4500 - 5000 + 300 with one untouched witness');
  const module=first.diagnostics?.modules.find(m=>m.id==='business');
  assert.equal(module?.state,'incomplete');assert.equal(module?.planned,4);assert.equal(module?.conclusive,3);assert.equal(module?.inconclusive,1);
  assert.ok(first.diagnostics?.reasons.some(r=>r.includes('منطق الأعمال')));
  assert.ok(first.covered.some(k=>k.includes('/api/checkout-good')&&k.includes('business_pricing_')));
  for(const secret of ['fixture-good-secret','fixture-bad-secret','fixture-credit-secret','fixture-zero-secret','fixture-coupon-secret'])assert.ok(!JSON.stringify(first).includes(secret),'pricing body values must be redacted');
  assert.throws(()=>retestAssessment(root,first.id,{authorized:true}),/fresh (business )?input/);
  fixed=true;balance=100000;
  const second=await finish(retestAssessment(root,first.id,{authorized:true,businessSecrets}).id);
  for(const f of findings)assert.ok(second.comparison?.notObserved.includes(f.fingerprint),JSON.stringify(second.comparison));
  assert.equal(second.business?.proofs.find(p=>p.caseId==='overchargedCheckout')?.outcome,'not_observed');
  assert.equal(second.business?.proofs.find(p=>p.caseId==='invertedCredit')?.outcome,'not_observed');
  assert.equal(balance,90700,'100000 - 4500 - 4500 - 300 with the zero-witness case still untouched');
  console.log('PASS business pricing: declared amounts matched exactly, overcharge and inverted credit observed with direction evidence, unresponsive witness inconclusive, POST policy evidence, redaction, diagnostics module and repaired retest');
}finally{server.closeAllConnections();server.close();}
