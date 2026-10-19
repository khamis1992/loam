import assert from 'node:assert/strict';
import http from 'node:http';import {once} from 'node:events';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {startAssessment,readAssessment,retestAssessment,type Assessment,type AssessmentInput} from '../security/assessments.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-account-routes-'));
let mode='open';let visits:Record<string,number>={};
const server=http.createServer((req,res)=>{
  res.setHeader('content-type','text/html');
  const id=req.headers.authorization==='Bearer account-a-token'?'alice':req.headers.authorization==='Bearer account-b-token'?'bob':'guest';
  let content='Fixture',destination='';
  if(req.url==='/who'){
    visits[id]=(visits[id]??0)+1;content='<div data-identity>'+id+'</div>';
    if(mode==='identity-move'||mode==='identity-after'&&visits[id]!>=4)destination='/login';
  }
  if(req.url==='/record'){
    content=id==='bob'&&['fixed','denial-move'].includes(mode)?'<div data-denied>Denied</div>':'<div data-private>Synthetic protected record</div>';
    if(mode==='allowed-move'&&id==='alice'||['denied-move','denial-move'].includes(mode)&&id==='bob')destination='/other';
    if(mode==='query')destination='?state=private-query';
    if(mode==='hash')destination='#private-fragment';
  }
  res.end('<body>'+content+(destination?'<script>history.replaceState({},"",'+JSON.stringify(destination)+')</script>':'')+'</body>');
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const target='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port+'/';
const browserSecrets={aliceIdentity:'alice',bobIdentity:'bob',aliceToken:'account-a-token',bobToken:'account-b-token'};
const accounts=['alice','bob'].map(id=>({id,bearerRef:id+'Token',login:[{action:'navigate',path:'/who'},{action:'assertVisible',selector:'[data-identity]'}],witness:{path:'/who',selector:'[data-identity]',textRef:id+'Identity'}}));
const input={target,authorized:true,checks:['server_banner'],scope:{delayMs:0},browserSecrets,browser:{enabled:true,screenshots:false,maxPages:1,settleMs:250,accounts,authorization:[{id:'record',kind:'ui',path:'/record',selector:'[data-private]',deniedSelector:'[data-denied]',allowed:['alice'],denied:['bob']}]}};
const base=process.env.LOAM_SECURITY_TEST_BASE;let taskId='';
if(base&&!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw Error('Installed test requires loopback');
async function post(route:string,body:unknown){const r=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json() as Promise<any>;}
async function launch(value:AssessmentInput,id?:string):Promise<Assessment>{if(!base)return id?retestAssessment(root,id,value):startAssessment(root,value);return (await post('/api/security/assessments'+(id?'/'+id+'/retest':'')+'?taskId='+taskId,value)).run;}
async function finish(id:string){for(let n=0;n<900;n++){const run:Assessment=base?(await(await fetch(base+'/api/security/assessments/'+id+'?taskId='+taskId)).json() as any).run:readAssessment(root,id);if(run.status!=='running')return run;await new Promise(r=>setTimeout(r,100));}throw Error('Assessment observation timeout');}
try{
  if(base)taskId=(await post('/api/tasks/draft',{mode:'build',title:'Multi-account route regression'})).task.id;
  const first=await finish((await launch(input)).id),finding=first.findings.find(f=>f.check.startsWith('authorization_'));assert.ok(finding,'Baseline must reproduce cross-account exposure');
  for(mode of ['allowed-move','denied-move','denial-move','query','hash','identity-move','identity-after','fixed']){
    visits={};const run=await finish((await launch({authorized:true,browserSecrets},first.id)).id);
    const proof=run.browser!.proofs.find(p=>p.kind==='authorization'&&p.observations.account==='bob')!;assert.ok(proof,mode);
    assert.equal(proof.outcome,mode==='fixed'?'not_observed':'inconclusive',mode);
    assert.ok((mode==='fixed'?run.comparison!.notObserved:run.comparison!.unverified).includes(finding.fingerprint),mode);
    if(mode==='identity-move')assert.ok(run.browser!.proofs.filter(p=>p.kind==='session').every(p=>p.outcome==='inconclusive'));
    for(const secret of ['account-a-token','account-b-token','private-query','private-fragment'])assert.ok(!JSON.stringify(run).includes(secret),mode);
  }
  console.log('PASS: two-account controls, moved identity witnesses before/after, allowed/denied target changes, query/hash movement and direct-denial retest; secrets omitted');
}finally{server.closeAllConnections();server.close();}
