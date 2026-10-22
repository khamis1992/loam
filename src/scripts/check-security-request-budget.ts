import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startAssessment,readAssessment,retestAssessment} from '../security/assessments.js';
import {normalizeScope,scopedTransport} from '../security/scope.js';
import {executionDiagnostics} from '../security/diagnostics.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-request-budget-'));
let received=0;
const server=http.createServer((req,res)=>{
  received++;
  if(req.url?.startsWith('/module/')){res.setHeader('content-type','text/plain');res.end('fixture');return;}
  res.setHeader('content-type','text/html');
  res.end(`<div id="app">Loading</div><script>
  (async()=>{for(let batch=0;batch<101;batch++)await Promise.all(Array.from({length:10},(_,i)=>fetch('/module/'+(batch*10+i)).then(r=>{if(!r.ok)throw Error('failed');return r.text()})));document.querySelector('#app').dataset.ready='yes';})().catch(()=>{});
  </script>`);
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const target='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;
async function finish(id:string){for(let n=0;n<1200;n++){const r=readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,100));}throw Error('Assessment timeout');}
const input={target,authorized:true,profile:'quick',checks:['server_banner'],scope:{maxRequests:1000,delayMs:0},browser:{enabled:true,maxPages:1,screenshots:false,settleMs:250,readySelector:'#app[data-ready]',readinessTimeoutMs:10000}};
try{
  assert.equal(normalizeScope(target,{}).maxRequests,200);
  assert.equal(normalizeScope(target,{maxRequests:10000}).maxRequests,10000);
  assert.throws(()=>normalizeScope(target,{maxRequests:10001}),/maxRequests/);
  // Concurrent reservations must never overrun the exact bound.
  const transport=scopedTransport(normalizeScope(target,{maxRequests:10,delayMs:0}),new AbortController().signal,{},[]);
  const reservations=await Promise.allSettled(Array.from({length:40},()=>transport.reserve()));
  assert.equal(reservations.filter(r=>r.status==='fulfilled').length,10);
  assert.equal(transport.count,10);
  const before=received,limited=await finish(startAssessment(root,input).id);
  assert.equal(limited.status,'partial');assert.equal(limited.evidence.length,1000);
  assert.equal(received-before,1000,'No request reaches server after budget exhaustion');
  assert.ok(executionDiagnostics(limited).reasons.some(r=>r.includes('ميزانية الطلبات')));
  const raised=await finish(startAssessment(root,{...input,scope:{maxRequests:2000,delayMs:0}}).id);
  assert.equal(raised.status,'completed',JSON.stringify(raised.browser?.proofs.map(p=>p.observations)));
  assert.ok(raised.evidence.length>1000);assert.ok(raised.evidence.length<2000);
  assert.equal(raised.browser!.proofs.find(p=>p.kind==='render')!.observations.documentComplete,true);
  const repeated=await finish(retestAssessment(root,raised.id,{authorized:true}).id);
  assert.equal(repeated.scope.maxRequests,2000);assert.equal(repeated.status,'completed');
  console.log('PASS: exact concurrent cap, 1000-request cutoff at target, explicit larger budget completes 1010-resource SPA, preserved retest budget');
}finally{server.closeAllConnections();server.close();}
