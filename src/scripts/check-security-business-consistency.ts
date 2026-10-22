import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {startAssessment,readAssessment,retestAssessment} from '../security/assessments.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-security-consistency-'));
const tier='fixture-tier-secret-value',staleTier='fixture-stale-tier-value';
let fixed=false;
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url!,'http://localhost');
  await new Promise<void>(resolve=>{req.on('data',()=>{});req.on('end',resolve);});
  const json=(status:number,payload:unknown)=>{res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(payload));};
  if(url.pathname==='/api/view-profile')return json(200,{profile:{tier},cachedAt:1});
  if(url.pathname==='/api/record-profile')return json(200,{profile:{tier},source:'record'});
  if(url.pathname==='/api/view-stale')return json(200,{profile:{tier:fixed?tier:staleTier}});
  if(url.pathname==='/api/view-outage')return json(503,{error:'unavailable'});
  if(url.pathname==='/api/view-balance')return json(200,{balance:90800,currency:'cents'});
  if(url.pathname==='/api/record-balance')return json(200,{balance:90800,currency:'cents'});
  if(url.pathname==='/'&&req.method==='GET'){res.setHeader('content-type','text/html');res.end('<!doctype html><title>fixture</title>');return;}
  res.writeHead(404).end();
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const target='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;
const finish=async(id:string)=>{const deadline=Date.now()+60000;while(Date.now()<deadline){const r=readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,50));}throw Error('consistency assessment timed out');};
const businessConsistency=[
  {id:'consistentTiers',layers:[{path:'/api/view-profile',pointer:'/profile/tier'},{path:'/api/record-profile',pointer:'/profile/tier'}],valueRef:'tierValue'},
  {id:'staleCache',layers:[{path:'/api/view-stale',pointer:'/profile/tier'},{path:'/api/record-profile',pointer:'/profile/tier'}],valueRef:'tierValue'},
  {id:'outageLayer',layers:[{path:'/api/view-outage',pointer:'/profile/tier'},{path:'/api/record-profile',pointer:'/profile/tier'}],valueRef:'tierValue'},
  {id:'wrongDeclaredValue',layers:[{path:'/api/view-profile',pointer:'/profile/tier'},{path:'/api/record-profile',pointer:'/profile/tier'}],valueRef:'wrongValue'},
  {id:'numericBalances',layers:[{path:'/api/view-balance',pointer:'/balance'},{path:'/api/record-balance',pointer:'/balance'}],valueRef:'balanceValue'},
];
const businessSecrets={tierValue:tier,wrongValue:'fixture-never-issued-value',balanceValue:'90800'};
const input={target,authorized:true,checks:['server_banner'],profile:'campaign' as const,scope:{delayMs:0,maxRequests:300},businessConsistency,businessSecrets};
try{
  assert.throws(()=>startAssessment(root,{...input,profile:'quick' as any}),/campaign mode/);
  assert.throws(()=>startAssessment(root,{...input,businessConsistency:[{...businessConsistency[0]!,layers:[{path:'/api/view-profile',pointer:'/profile/tier'}]}]}),/2–3 layer definitions/);
  assert.throws(()=>startAssessment(root,{...input,businessConsistency:[{...businessConsistency[0]!,layers:[{path:'/api/view-profile?x=1',pointer:'/profile/tier'},{path:'/api/record-profile',pointer:'/profile/tier'}]}]}),/exact scoped GET path/);
  assert.throws(()=>startAssessment(root,{...input,businessConsistency:[{...businessConsistency[0]!,layers:[{path:'/api/view-profile',pointer:'profile'},{path:'/api/record-profile',pointer:'/profile/tier'}]}]}),/JSON Pointer/);
  assert.throws(()=>startAssessment(root,{...input,scope:{...input.scope,exclusions:['/api']}}),/outside the approved scope/);
  assert.throws(()=>startAssessment(root,{...input,businessSecrets:{}}),/fresh (business )?input/);
  const first=await finish(startAssessment(root,input).id);
  assert.equal(first.status,'partial',JSON.stringify({business:first.business,findings:first.findings.map(f=>f.check+':'+f.verdict)}));
  assert.equal(first.completed,first.total,'progress accounting must include consistency cases');
  const proofs=first.business?.proofs??[];
  const consistent=proofs.find(p=>p.caseId==='consistentTiers'),stale=proofs.find(p=>p.caseId==='staleCache'),outage=proofs.find(p=>p.caseId==='outageLayer'),wrong=proofs.find(p=>p.caseId==='wrongDeclaredValue'),numeric=proofs.find(p=>p.caseId==='numericBalances');
  assert.equal(consistent?.kind,'business_consistency');
  assert.equal(consistent?.outcome,'not_observed',JSON.stringify(consistent));
  assert.equal(consistent?.observations.matchedLayers,2);
  assert.equal(stale?.outcome,'observed',JSON.stringify(stale));
  assert.equal(stale?.observations.divergentLayers,1);
  assert.equal(stale?.observations.matchedLayers,1);
  assert.equal(outage?.outcome,'inconclusive');
  assert.match(String(outage?.summary),/could not be compared/);
  assert.equal(wrong?.outcome,'inconclusive');
  assert.match(String(wrong?.summary),/No layer reproduced the declared value/);
  assert.equal(numeric?.outcome,'not_observed',JSON.stringify(numeric));
  assert.equal(numeric?.observations.matchedLayers,2);
  const finding=first.findings.find(f=>f.check.startsWith('business_consistency_')&&f.verdict==='finding');
  assert.ok(finding,JSON.stringify(first.findings));
  assert.ok(finding.target.includes('/api/view-stale'));
  assert.ok(first.findings.some(f=>f.check==='business_coverage'&&f.verdict==='error'));
  const layerGets=first.evidence.filter(e=>e.method==='GET'&&/\/api\/(view|record)-/.test(e.url));
  assert.equal(layerGets.length,10,'two GETs per case across five cases');
  const module=first.diagnostics?.modules.find(m=>m.id==='business');
  assert.equal(module?.state,'incomplete');assert.equal(module?.planned,5);assert.equal(module?.conclusive,3);assert.equal(module?.inconclusive,2);
  assert.ok(first.diagnostics?.reasons.some(r=>r.includes('منطق الأعمال')));
  assert.ok(first.covered.some(k=>k.includes('/api/view-profile')&&k.includes('business_consistency_')));
  for(const secret of ['fixture-tier-secret-value','fixture-stale-tier-value','fixture-never-issued-value'])assert.ok(!JSON.stringify(first).includes(secret),'declared and divergent values must never be recorded');
  assert.throws(()=>retestAssessment(root,first.id,{authorized:true}),/fresh (business )?input/);
  fixed=true;
  const second=await finish(retestAssessment(root,first.id,{authorized:true,businessSecrets}).id);
  assert.ok(second.comparison?.notObserved.includes(finding.fingerprint),JSON.stringify(second.comparison));
  assert.equal(second.business?.proofs.find(p=>p.caseId==='staleCache')?.outcome,'not_observed');
  console.log('PASS business consistency: matched layers across UI and record views, stale cache divergence observed with the record-layer positive control, outage and wrong-declared-value cases honestly inconclusive, numeric pointer matching, no value leakage, diagnostics module and repaired retest');
}finally{server.closeAllConnections();server.close();}
