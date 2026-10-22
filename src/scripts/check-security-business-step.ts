import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {startAssessment,readAssessment,retestAssessment} from '../security/assessments.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-security-step-'));
let shipped=0,shipped2=0,approvedV=false,approvedP=false,fixed=false;
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url!,'http://localhost');
  await new Promise<void>(resolve=>{req.on('data',()=>{});req.on('end',resolve);});
  const json=(status:number,payload:unknown)=>{res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(payload));};
  if(req.method==='POST'&&url.pathname==='/api/create-v')return json(201,{ok:true});
  if(req.method==='POST'&&url.pathname==='/api/approve-v'){approvedV=true;return json(201,{ok:true});}
  if(req.method==='POST'&&url.pathname==='/api/ship-v'){
    if(fixed&&!approvedV)return json(403,{error:'approval required'});
    approvedV=false;shipped++;return json(201,{ok:true,shipped});
  }
  if(req.method==='GET'&&url.pathname==='/api/review')return json(200,{ready:true});
  if(req.method==='POST'&&url.pathname==='/api/create-p')return json(201,{ok:true});
  if(req.method==='POST'&&url.pathname==='/api/approve-p'){approvedP=true;return json(201,{ok:true});}
  if(req.method==='POST'&&url.pathname==='/api/ship-p'){
    if(!approvedP)return json(403,{error:'approval required'});
    approvedP=false;shipped2++;return json(201,{ok:true,shipped2});
  }
  if(req.method==='POST'&&url.pathname==='/api/create-b')return json(201,{ok:true});
  if(req.method==='POST'&&url.pathname==='/api/ship-b')return json(403,{error:'approval required'});
  if(req.method==='GET'&&url.pathname==='/api/summary')return json(200,{shipped,shipped2,broken:0});
  if(url.pathname==='/'&&req.method==='GET'){res.setHeader('content-type','text/html');res.end('<!doctype html><title>fixture</title>');return;}
  res.writeHead(404).end();
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const target='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;
const finish=async(id:string)=>{const deadline=Date.now()+60000;while(Date.now()<deadline){const r=readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,50));}throw Error('step assessment timed out');};
const businessSteps=[
  {id:'vulnerableOrder',steps:[{path:'/api/create-v',bodyRef:'createVBody'},{path:'/api/approve-v',bodyRef:'approveVBody'},{path:'/api/ship-v',bodyRef:'shipVBody'}],statePath:'/api/summary',statePointer:'/shipped',stateDelta:1},
  {id:'protectedOrder',steps:[{path:'/api/review'},{path:'/api/create-p',bodyRef:'createPBody'},{path:'/api/approve-p',bodyRef:'approvePBody'},{path:'/api/ship-p',bodyRef:'shipPBody'}],statePath:'/api/summary',statePointer:'/shipped2',stateDelta:1},
  {id:'brokenControl',steps:[{path:'/api/create-b',bodyRef:'createBBody'},{path:'/api/ship-b',bodyRef:'shipBBody'}],statePath:'/api/summary',statePointer:'/broken',stateDelta:1},
];
const businessSecrets={createVBody:JSON.stringify({item:'fixture-createv-secret'}),approveVBody:JSON.stringify({by:'fixture-approvev-secret'}),shipVBody:JSON.stringify({carrier:'fixture-shipv-secret'}),createPBody:JSON.stringify({item:'fixture-createp-secret'}),approvePBody:JSON.stringify({by:'fixture-approvep-secret'}),shipPBody:JSON.stringify({carrier:'fixture-shipp-secret'}),createBBody:JSON.stringify({item:'fixture-createb-secret'}),shipBBody:JSON.stringify({carrier:'fixture-shipb-secret'})};
const input={target,authorized:true,checks:['server_banner'],profile:'campaign' as const,scope:{delayMs:0,maxRequests:300},businessSteps,businessSecrets};
try{
  assert.throws(()=>startAssessment(root,{...input,profile:'quick' as any}),/campaign mode/);
  assert.throws(()=>startAssessment(root,{...input,businessSteps:[{...businessSteps[0]!,steps:[{path:'/api/ship-v',bodyRef:'shipVBody'}]}]}),/2–6 ordered steps/);
  assert.throws(()=>startAssessment(root,{...input,businessSteps:[{...businessSteps[0]!,steps:[{path:'/api/ship-v?x=1',bodyRef:'shipVBody'},{path:'/api/ship-v',bodyRef:'shipVBody'}]}]}),/exact scoped path/);
  assert.throws(()=>startAssessment(root,{...input,businessSecrets:{}}),/fresh (business )?input/);
  assert.throws(()=>startAssessment(root,{...input,businessSecrets:{...businessSecrets,shipVBody:'not json'}}),/valid JSON/);
  const first=await finish(startAssessment(root,input).id);
  assert.equal(first.status,'partial',JSON.stringify({business:first.business,findings:first.findings.map(f=>f.check+':'+f.verdict)}));
  assert.equal(first.completed,first.total,'progress accounting must include step cases');
  const proofs=first.business?.proofs??[];
  const vulnerable=proofs.find(p=>p.caseId==='vulnerableOrder'),protectedCase=proofs.find(p=>p.caseId==='protectedOrder'),broken=proofs.find(p=>p.caseId==='brokenControl');
  assert.equal(vulnerable?.kind,'business_step');
  assert.equal(vulnerable?.outcome,'observed',JSON.stringify(vulnerable));
  assert.equal(vulnerable?.observations.bypassStatus,201);
  assert.equal(vulnerable?.observations.controlSkipped,true);
  assert.equal(protectedCase?.outcome,'not_observed',JSON.stringify(protectedCase));
  assert.equal(protectedCase?.observations.bypassStatus,403);
  assert.equal(protectedCase?.observations.controlApplied,true);
  assert.equal(broken?.outcome,'inconclusive');
  assert.match(String(broken?.summary),/rejected at step 2/);
  const finding=first.findings.find(f=>f.check.startsWith('business_step_')&&f.verdict==='finding');
  assert.ok(finding,JSON.stringify(first.findings));
  assert.ok(finding.target.includes('/api/ship-v'));
  assert.ok(first.findings.some(f=>f.check==='business_coverage'&&f.verdict==='error'));
  const shipVPosts=first.evidence.filter(e=>e.method==='POST'&&e.url.endsWith('/api/ship-v'));
  assert.equal(shipVPosts.length,1,'the observed bypass must skip the ordered control sequence');
  assert.equal(shipVPosts[0]?.postPolicy,'/api/ship-v');
  assert.ok(first.evidence.some(e=>e.method==='GET'&&e.url.endsWith('/api/review')),'GET steps must execute through the scoped transport');
  assert.equal(shipped,1);assert.equal(shipped2,1);
  const module=first.diagnostics?.modules.find(m=>m.id==='business');
  assert.equal(module?.state,'incomplete');assert.equal(module?.planned,3);assert.equal(module?.conclusive,2);assert.equal(module?.inconclusive,1);
  assert.ok(first.diagnostics?.reasons.some(r=>r.includes('منطق الأعمال')));
  assert.ok(first.covered.some(k=>k.includes('/api/ship-v')&&k.includes('business_step_')));
  for(const secret of Object.values({a:'fixture-createv-secret',b:'fixture-shipv-secret',c:'fixture-shipp-secret',d:'fixture-shipb-secret'}))assert.ok(!JSON.stringify(first).includes(secret),'step body values must be redacted');
  assert.throws(()=>retestAssessment(root,first.id,{authorized:true}),/fresh (business )?input/);
  fixed=true;
  const second=await finish(retestAssessment(root,first.id,{authorized:true,businessSecrets}).id);
  assert.ok(second.comparison?.notObserved.includes(finding.fingerprint),JSON.stringify(second.comparison));
  assert.equal(shipped,2,'a repaired workflow applies the final step only inside the ordered sequence');
  assert.equal(second.business?.proofs.find(p=>p.caseId==='vulnerableOrder')?.outcome,'not_observed');
  console.log('PASS business steps: prerequisite bypass observed on a fresh state with the ordered control skipped, protected final step rejected alone and applied in sequence, broken control sequence inconclusive, GET and POST step evidence, redaction, diagnostics module and repaired retest');
}finally{server.closeAllConnections();server.close();}
