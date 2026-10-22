import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startAssessment,readAssessment,retestAssessment,type Assessment,type AssessmentInput} from '../security/assessments.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-canary-route-'));
let mode='vulnerable';
const server=http.createServer((req,res)=>{
  res.setHeader('content-type','text/html');
  const program=mode==='vulnerable'?'app.innerHTML=decodeURIComponent(location.hash.slice(1))':
    mode==='fixed'?'app.textContent=decodeURIComponent(location.hash.slice(1))':
    mode==='move'?'if(location.hash)history.replaceState({},"","/login?token=private-query#private-fragment")':
    mode==='query'?'if(location.hash)history.replaceState({},"","?login=private-query")':
    'if(location.hash){app.innerHTML=decodeURIComponent(location.hash.slice(1));history.replaceState({},"","/login")}';
  res.end('<div id="app"></div><script>'+program+'</script>');
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const target='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port+'/app';
const base=process.env.LOAM_SECURITY_TEST_BASE;
if(base&&!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw Error('Installed verification requires loopback HTTP');
let taskId='';
async function post(url:string,body:unknown){const response=await fetch(base+url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(response.ok,await response.clone().text());return response.json() as Promise<any>;}
async function launch(input:AssessmentInput,baseline?:string):Promise<Assessment>{
  if(!base)return baseline?retestAssessment(root,baseline,input):startAssessment(root,input);
  return (await post('/api/security/assessments'+(baseline?'/'+baseline+'/retest':'')+'?taskId='+taskId,input)).run;
}
async function finish(id:string){for(let n=0;n<600;n++){const r:Assessment=base?(await (await fetch(base+'/api/security/assessments/'+id+'?taskId='+taskId)).json() as any).run:readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout');}
try{
  if(base)taskId=(await post('/api/tasks/draft',{mode:'build',title:'DOM canary route regression'})).task.id;
  const baseline=await finish((await launch({target,authorized:true,checks:['server_banner'],scope:{seeds:[new URL(target).origin],delayMs:0},browser:{enabled:true,maxPages:1,screenshots:false,domCanary:true,settleMs:250}})).id);
  const finding=baseline.findings.find(f=>f.check==='browser_dom_canary');assert.ok(finding,'Vulnerable positive control must execute');
  for(mode of ['move','query','execute-and-move']){
    const run=await finish((await launch({authorized:true},baseline.id)).id);
    const p=run.browser!.proofs.find(p=>p.kind==='dom_canary')!;
    assert.equal(p.outcome,'inconclusive',mode);assert.equal(p.observations.targetReached,false);
    assert.equal(p.observations.queryChanged,mode!=='execute-and-move');
    assert.equal(p.observations.routeChanged,mode!=='query');
    if(mode==='execute-and-move')assert.equal(p.observations.executed,true,'Execution evidence survives changed-route attribution refusal');
    assert.ok(run.comparison!.unverified.includes(finding.fingerprint));
    assert.ok(!run.comparison!.notObserved.includes(finding.fingerprint));
    assert.ok(!JSON.stringify(run).includes('private-query'));assert.ok(!JSON.stringify(run).includes('private-fragment'));
    assert.equal(run.status,'partial');
  }
  mode='fixed';const fixed=await finish((await launch({authorized:true},baseline.id)).id);
  const proof=fixed.browser!.proofs.find(p=>p.kind==='dom_canary')!;
  assert.equal(proof.outcome,'not_observed');assert.equal(proof.observations.targetReached,true);
  assert.ok(fixed.comparison!.notObserved.includes(finding.fingerprint));
  console.log('PASS: real canary baseline, path/query navigation and relocated execution stay unverified; text-rendering fix remains not observed; final URL secrets omitted');
}finally{server.closeAllConnections();server.close();fs.rmSync(root,{recursive:true,force:true});}
