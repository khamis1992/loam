import assert from 'node:assert/strict';import http from 'node:http';import {once} from 'node:events';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {startAssessment,readAssessment,retestAssessment} from '../security/assessments.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-resource-budgets-'));
const server=http.createServer((req,res)=>{
  const u=req.url??'/';
  if(u.startsWith('/data')){res.setHeader('content-type','application/octet-stream');res.end('x'.repeat(600000));return;}
  res.setHeader('content-type','text/html');
  if(u==='/slow'){res.end('<div id="app">Loading</div><script>setTimeout(()=>document.querySelector("#app").dataset.ready="yes",1800)</script>');return;}
  res.end('<div id="app">Loading</div><script>(async()=>{for(let i=0;i<3;i++){const r=await fetch("/data?part="+i);await r.text();}document.querySelector("#app").dataset.ready="yes";})().catch(()=>{})</script>');
});server.listen(0,'127.0.0.1');await once(server,'listening');const target='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;
const browser={enabled:true,screenshots:false,maxPages:1,settleMs:250,readySelector:'#app[data-ready]',readinessTimeoutMs:1000,responseLimitBytes:700000,totalLimitBytes:1000000};
const input={target,authorized:true,profile:'quick',checks:['server_banner'],scope:{delayMs:0},browser};
async function finish(id:string){for(let i=0;i<600;i++){const r=readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout');}
try{
  assert.throws(()=>startAssessment(root,{...input,browser:{...browser,totalLimitBytes:201000000}}),/Invalid browser limit/);
  assert.throws(()=>startAssessment(root,{...input,browser:{...browser,responseLimitBytes:2000000}}),/cannot exceed/);
  const limited=await finish(startAssessment(root,input).id);assert.equal(limited.status,'partial');
  assert.ok(limited.evidence.some(e=>e.error==='Browser campaign response budget exceeded 1000000 bytes'));
  assert.ok(limited.browser!.resources!.receivedBytes>1000000);
  assert.equal(limited.browser!.proofs.find(p=>p.kind==='render')!.observations.stage,'readiness');
  const raised=await finish(startAssessment(root,{...input,browser:{...browser,totalLimitBytes:3000000}}).id);assert.equal(raised.status,'completed',JSON.stringify(raised.browser));assert.ok(raised.browser!.resources!.receivedBytes>1800000);
  const same=await finish(retestAssessment(root,raised.id,{authorized:true}).id);assert.equal(same.browserOptions.totalLimitBytes,3000000);assert.equal(same.status,'completed');
  const slow=await finish(startAssessment(root,{...input,target:target+'/slow'}).id);assert.equal(slow.status,'partial');assert.equal(slow.browser!.proofs[0]!.observations.stage,'readiness');
  const patient=await finish(startAssessment(root,{...input,target:target+'/slow',browser:{...browser,readinessTimeoutMs:4000}}).id);assert.equal(patient.status,'completed',JSON.stringify(patient.browser));
  console.log('PASS: cumulative decoded byte limits, failed-resource accounting, bounded normalization, readiness stage, increased budget/loading success, longer readiness and retest preservation');
}finally{server.closeAllConnections();server.close();}
