import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startAssessment,readAssessment,retestAssessment,type Assessment,type AssessmentInput} from '../security/assessments.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-framing-evidence-'));
let mode='open';
const server=http.createServer((req,res)=>{
  res.setHeader('content-type','text/html');
  if(mode==='xfo'||req.url==='/denied')res.setHeader('x-frame-options','DENY');
  if(mode==='csp')res.setHeader('content-security-policy',"frame-ancestors 'none'");
  if(mode==='override'){res.setHeader('x-frame-options','DENY');res.setHeader('content-security-policy','frame-ancestors *');}
  if(mode==='report-only')res.setHeader('content-security-policy-report-only',"frame-ancestors 'none'");
  if(mode==='duplicate')res.setHeader('content-security-policy',"frame-ancestors *; frame-ancestors 'none'");
  const script=mode==='redirect'&&req.url!=='/denied'?'if(self!==top)location.replace("/denied")':
    mode==='spoof'?'console.error("Refused to frame: X-Frame-Options DENY")':'';
  res.end('<body>Public fixture<script>'+script+'</script></body>');
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const origin='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;
const base=process.env.LOAM_SECURITY_TEST_BASE;let taskId='';
if(base&&!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw Error('Installed test requires loopback');
async function post(route:string,body:unknown){const r=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json() as Promise<any>;}
async function launch(input:AssessmentInput,id?:string):Promise<Assessment>{if(!base)return id?retestAssessment(root,id,input):startAssessment(root,input);return (await post('/api/security/assessments'+(id?'/'+id+'/retest':'')+'?taskId='+taskId,input)).run;}
async function finish(id:string){for(let n=0;n<600;n++){const run:Assessment=base?(await(await fetch(base+'/api/security/assessments/'+id+'?taskId='+taskId)).json() as any).run:readAssessment(root,id);if(run.status!=='running')return run;await new Promise(r=>setTimeout(r,100));}throw Error('Assessment observation timeout');}
try{
  if(base)taskId=(await post('/api/tasks/draft',{mode:'build',title:'Framing evidence regression'})).task.id;
  const baseline=await finish((await launch({target:origin+'/app',authorized:true,checks:['server_banner'],scope:{seeds:[origin+'/'],delayMs:0},browser:{enabled:true,maxPages:1,screenshots:false,framing:true,followRedirects:true,settleMs:250}})).id);
  const finding=baseline.findings.find(f=>f.check==='browser_framing');assert.ok(finding,'Frameable positive control required');
  for(mode of ['spoof','redirect','xfo','csp','override','report-only','duplicate']){
    const run=await finish((await launch({authorized:true},baseline.id)).id);
    const proof=run.browser!.proofs.find(p=>p.kind==='framing')!;assert.ok(proof,mode);
    if(mode==='xfo'||mode==='csp'){
      assert.equal(proof.outcome,'not_observed',mode);assert.equal(proof.observations.policyResponse,true);
      assert.ok(run.comparison!.notObserved.includes(finding.fingerprint),mode);
    }else if(mode==='redirect'){
      assert.equal(proof.outcome,'inconclusive');assert.equal(proof.observations.policyResponse,false);
      assert.ok(run.comparison!.unverified.includes(finding.fingerprint));
    }else{
      assert.equal(proof.outcome,'observed',mode);assert.ok(run.comparison!.persistent.includes(finding.fingerprint),mode);
    }
  }
  console.log('PASS: frameable control, forged console, redirected denial, enforced XFO/CSP, CSP override and report-only policy; retest attribution verified');
}finally{server.closeAllConnections();server.close();}
