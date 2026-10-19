import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startAssessment,readAssessment,retestAssessment} from '../security/assessments.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-route-readiness-'));
let login=false;
const server=http.createServer((req,res)=>{
  res.setHeader('content-type','text/html');
  if(req.url==='/dashboard')res.end(login?'<div id="login">Sign in</div><script>history.replaceState({},"","/login")</script>':'<div id="dashboard">Loading</div><script>setTimeout(()=>document.querySelector("#dashboard").dataset.ready="yes",400)</script>');
  else res.end('<div id="login">Sign in</div>');
});server.listen(0,'127.0.0.1');await once(server,'listening');
const origin='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;
const rules=[{path:'/dashboard',selector:'#dashboard[data-ready]'},{path:'/login',selector:'#login'}];
const input={target:origin+'/dashboard',authorized:true,profile:'quick',checks:['server_banner'],scope:{seeds:[origin+'/login'],delayMs:0},browser:{enabled:true,maxPages:2,screenshots:false,settleMs:250,readinessTimeoutMs:1000,readySelector:'#login',readyRoutes:rules}};
async function finish(id:string){for(let n=0;n<600;n++){const r=readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout');}
try{
  for(const readyRoutes of [[...rules,rules[0]], [{path:'/outside',selector:'#x'}], [{path:'/dashboard?q=secret',selector:'#x'}], [{path:'/dashboard',selector:''}], [{path:'/dashboard/../dashboard',selector:'#x'}]]){
    assert.throws(()=>startAssessment(root,{...input,browser:{...input.browser,readyRoutes}}),/readiness/i);
  }
  const first=await finish(startAssessment(root,input).id);
  assert.equal(first.status,'completed');assert.equal(first.browser!.pages.length,2);
  const proofs=first.browser!.proofs.filter(p=>p.kind==='render');
  assert.deepEqual(proofs.map(p=>p.observations.readySelector),rules.map(r=>r.selector));
  assert.ok(proofs.every(p=>p.outcome==='observed'));
  login=true;
  const changed=await finish(retestAssessment(root,first.id,{authorized:true}).id);
  assert.deepEqual(changed.browserOptions.readyRoutes,rules);
  const failed=changed.browser!.proofs.find(p=>p.target===origin+'/dashboard')!;
  assert.equal(failed.outcome,'inconclusive');assert.equal(failed.observations.stage,'readiness');
  assert.equal(failed.observations.readySelector,'#dashboard[data-ready]');
  assert.equal(failed.observations.finalUrl,origin+'/login');
  assert.equal(changed.browser!.proofs.find(p=>p.target===origin+'/login')!.outcome,'observed');
  console.log('PASS: different page readiness, exact scoped rules, duplicate/invalid rejection, original rule survives login redirect, retest preservation');
}finally{server.closeAllConnections();server.close();}
