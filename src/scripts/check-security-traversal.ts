import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {startAssessment,readAssessment,retestAssessment} from '../security/assessments.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-security-traversal-'));
const publicDir=path.join(root,'public'),secretDir=path.join(root,'secret');
fs.mkdirSync(publicDir,{recursive:true});fs.mkdirSync(secretDir,{recursive:true});
fs.writeFileSync(path.join(publicDir,'welcome.txt'),'welcome fixture-welcome-marker content');
fs.writeFileSync(path.join(secretDir,'loam-target.txt'),'internal fixture-secret-marker content');
let fixed=false;
const server=http.createServer((req,res)=>{
  const url=new URL(req.url!,'http://localhost');
  if(url.pathname==='/'&&req.method==='GET'){res.setHeader('content-type','text/html').end('<!doctype html><title>fixture</title>');return;}
  const vulnerable=(name:string)=>{
    if(fixed&&name.includes('..'))return res.writeHead(400).end('invalid name');
    // The vulnerable handler joins the raw parameter into the served root with
    // no containment check, so ../ escapes the root.
    try{res.setHeader('content-type','text/plain').end(fs.readFileSync(path.join(publicDir,name)));return;}catch{return res.writeHead(404).end('not found');}
  };
  const guarded=(name:string)=>{
    if(name.includes('..'))return res.writeHead(400).end('invalid name');
    try{res.setHeader('content-type','text/plain').end(fs.readFileSync(path.join(publicDir,name)));return;}catch{return res.writeHead(404).end('not found');}
  };
  if(url.pathname==='/files'&&req.method==='GET')return vulnerable(url.searchParams.get('name')??'');
  if(url.pathname==='/files-safe'&&req.method==='GET')return guarded(url.searchParams.get('name')??'');
  if(url.pathname==='/files-broken'&&req.method==='GET')return res.writeHead(500).end('unavailable');
  res.writeHead(404).end();
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const target='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;
const finish=async(id:string)=>{const deadline=Date.now()+60000;while(Date.now()<deadline){const r=readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,50));}throw Error('traversal assessment timed out');};
const traversal=[
  {id:'unguardedFiles',path:'/files',param:'name',benignRef:'benignName',benignMarkerRef:'benignMarker',traversalRef:'traversalPayload',markerRef:'targetMarker'},
  {id:'guardedFiles',path:'/files-safe',param:'name',benignRef:'benignName',benignMarkerRef:'benignMarker',traversalRef:'traversalPayload',markerRef:'targetMarker'},
  {id:'brokenEndpoint',path:'/files-broken',param:'name',benignRef:'benignName',benignMarkerRef:'benignMarker',traversalRef:'traversalPayload',markerRef:'targetMarker'},
];
const input={target,authorized:true,checks:['server_banner'],profile:'campaign' as const,scope:{delayMs:0,maxRequests:200},traversal,businessSecrets:{benignName:'welcome.txt',benignMarker:'fixture-welcome-marker',traversalPayload:'../secret/loam-target.txt',targetMarker:'fixture-secret-marker'}};
try{
  assert.throws(()=>startAssessment(root,{...input,profile:'quick' as any}),/campaign mode/);
  assert.throws(()=>startAssessment(root,{...input,traversal:[{...traversal[0]!,path:'/files?x=1'}]}),/exact path/);
  assert.throws(()=>startAssessment(root,{...input,traversal:[{...traversal[0]!,param:'action'}]}),/safe parameter name/);
  assert.throws(()=>startAssessment(root,{...input,businessSecrets:{}}),/fresh (business )?input/);
  const first=await finish(startAssessment(root,input).id);
  assert.equal(first.status,'partial',JSON.stringify({proofs:first.traversal?.proofs.map(p=>[p.caseId,p.outcome,p.summary]),findings:first.findings.map(f=>f.check+':'+f.verdict)}));
  assert.equal(first.completed,first.total,'progress accounting must include traversal cases');
  const proofs=first.traversal?.proofs??[];
  assert.equal(proofs.length,3,'three traversal proofs');
  const unguarded=proofs.find(p=>p.target.endsWith('/files'))!,guarded=proofs.find(p=>p.target.endsWith('/files-safe'))!,broken=proofs.find(p=>p.target.endsWith('/files-broken'))!;
  assert.ok(unguarded&&guarded&&broken,JSON.stringify(proofs.map(p=>p.target)));
  assert.equal(unguarded.kind,'traversal');
  assert.equal(unguarded.outcome,'observed',JSON.stringify(unguarded));
  assert.equal(unguarded.observations.benignServed,true);
  assert.equal(unguarded.observations.markerAbsentForMissing,true);
  assert.equal(unguarded.observations.targetServed,true);
  assert.equal(guarded.outcome,'not_observed',JSON.stringify(guarded));
  assert.equal(guarded.observations.probeStatus,400);
  assert.equal(guarded.observations.targetServed,false);
  assert.equal(broken.outcome,'inconclusive');
  assert.match(String(broken.summary),/Positive control failed/);
  const finding=first.findings.find(f=>f.check.startsWith('traversal_')&&f.verdict==='finding');
  assert.ok(finding,JSON.stringify(first.findings));
  assert.equal(finding.severity,'high');
  assert.ok(finding.target.includes('/files'));
  const fileGets=first.evidence.filter(e=>e.method==='GET'&&e.url.endsWith('/files'));
  assert.equal(fileGets.length,3,'benign, missing-name and traversal probes');
  assert.ok(!JSON.stringify(first).includes('fixture-secret-marker'),'the target marker must never be recorded');
  assert.ok(!JSON.stringify(first).includes('../secret/loam-target.txt'),'the traversal payload must never be recorded');
  const module=first.diagnostics?.modules.find(m=>m.id==='traversal');
  assert.equal(module?.state,'incomplete');assert.equal(module?.planned,3);assert.equal(module?.conclusive,2);assert.equal(module?.inconclusive,1);
  assert.ok(first.covered.some(k=>k.includes('/files-safe')&&k.includes('traversal_')));
  assert.throws(()=>retestAssessment(root,first.id,{authorized:true}),/fresh (business )?input/);
  fixed=true;
  const second=await finish(retestAssessment(root,first.id,{authorized:true,businessSecrets:input.businessSecrets}).id);
  assert.ok(second.comparison?.notObserved.includes(finding.fingerprint),JSON.stringify(second.comparison));
  assert.equal(second.traversal?.proofs.find(p=>p.target.endsWith('/files'))?.outcome,'not_observed','a rejecting repair must block the payload');
  console.log('PASS traversal: positive benign-file control, negative missing-name control, traversal payload served from outside the root observed, guarded endpoint rejecting it, broken endpoint inconclusive, markers and payload never recorded, diagnostics module and repaired retest');
}finally{server.closeAllConnections();server.close();}
