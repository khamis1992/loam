import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startAssessment,readAssessment,retestAssessment,type Assessment,type AssessmentInput} from '../security/assessments.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-access-route-'));
let mode='open';const auth={bearer:'local-access-fixture-token'};
const server=http.createServer((req,res)=>{
  res.setHeader('content-type','text/html');
  if(req.url==='/'){res.end('<body>Fixture</body>');return;}
  const authenticated=req.headers.authorization==='Bearer '+auth.bearer;
  if(mode==='http-redirect'&&req.url==='/protected'&&!authenticated){res.writeHead(302,{location:'/login'}).end();return;}
  const denial=!authenticated&&(mode==='fixed'||mode==='auth-move'||mode==='http-redirect');
  const move=mode==='auth-move'&&authenticated||mode==='anon-move'&&!authenticated;
  const destination=move?'/login':mode==='query'?'?route=private-query':mode==='hash'?'#private-fragment':'';
  if(mode==='fixed'&&!authenticated)res.statusCode=403;
  res.end('<body><div '+(denial?'data-denied':'data-private')+'>Fixture element</div>'+(destination?'<script>history.replaceState({},"",'+JSON.stringify(destination)+')</script>':'')+'</body>');
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const target='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port+'/';
const base=process.env.LOAM_SECURITY_TEST_BASE;let taskId='';
if(base&&!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw Error('Installed test requires loopback');
async function post(route:string,body:unknown){const r=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json() as Promise<any>;}
async function launch(input:AssessmentInput,id?:string):Promise<Assessment>{if(!base)return id?retestAssessment(root,id,input):startAssessment(root,input);return (await post('/api/security/assessments'+(id?'/'+id+'/retest':'')+'?taskId='+taskId,input)).run;}
async function finish(id:string){for(let n=0;n<600;n++){const run:Assessment=base?(await(await fetch(base+'/api/security/assessments/'+id+'?taskId='+taskId)).json() as any).run:readAssessment(root,id);if(run.status!=='running')return run;await new Promise(r=>setTimeout(r,100));}throw Error('Assessment observation timeout');}
try{
  if(base)taskId=(await post('/api/tasks/draft',{mode:'build',title:'Access route evidence regression'})).task.id;
  const input={target,auth,authorized:true,checks:['server_banner'],scope:{delayMs:0},browser:{enabled:true,maxPages:1,screenshots:false,followRedirects:true,settleMs:250,accessAssertions:[{path:'/protected',selector:'[data-private]',deniedSelector:'[data-denied]'}]}};
  const baseline=await finish((await launch(input)).id);
  const finding=baseline.findings.find(f=>f.check.startsWith('browser_access_'));assert.ok(finding,'Anonymous exposure must reproduce before retesting');
  for(mode of ['auth-move','anon-move','query','hash','http-redirect','fixed']){
    const run=await finish((await launch({authorized:true,auth},baseline.id)).id);
    const proof=run.browser!.proofs.find(p=>p.kind==='access')!;assert.ok(proof,mode);
    assert.equal(proof.outcome,mode==='fixed'?'not_observed':'inconclusive',mode);
    assert.ok((mode==='fixed'?run.comparison!.notObserved:run.comparison!.unverified).includes(finding.fingerprint),mode);
    assert.ok(!JSON.stringify(run).includes(auth.bearer));
    assert.ok(!JSON.stringify(run).includes('private-query'));assert.ok(!JSON.stringify(run).includes('private-fragment'));
    if(mode==='fixed'){assert.equal(proof.observations.authenticatedTargetReached,true);assert.equal(proof.observations.anonymousTargetReached,true);}
  }
  // A changed-route baseline must not create a false exposure finding either.
  mode='anon-move';const moved=await finish((await launch(input)).id);
  assert.ok(!moved.findings.some(f=>f.check.startsWith('browser_access_')&&f.verdict==='finding'));
  console.log('PASS: authenticated/anonymous path changes, query/hash transitions and HTTP redirect remain unverified; direct denial resolves observation; moved baseline creates no false finding; secrets omitted');
}finally{server.closeAllConnections();server.close();}
