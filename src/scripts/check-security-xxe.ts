import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {startAssessment,readAssessment,retestAssessment} from '../security/assessments.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-security-xxe-'));
let fixed=false;
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url!,'http://localhost');
  let raw='';for await(const part of req)raw+=part;
  const json=(status:number,payload:unknown)=>{res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(payload));};
  const processXml=async(xml:string,resolveEntities:boolean)=>{
    if(fixed&&req.url==='/api/xml')resolveEntities=false;
    if(!resolveEntities)return json(200,{parsed:xml.replace(/<!DOCTYPE[^>]*\[[\s\S]*?\]>/,'').replace(/&loam;/,'')});
    // The vulnerable handler resolves external SYSTEM entities verbatim.
    const entity=/<!ENTITY\s+loam\s+SYSTEM\s+"([^"]+)">/.exec(xml);
    const reference=/&loam;/.test(xml);
    if(!entity||!reference)return json(200,{parsed:xml});
    try{const r=await fetch(entity[1]!,{signal:AbortSignal.timeout(5000)});const content=await r.text();return json(200,{parsed:xml.replace(/&loam;/,content)});}
    catch{return json(502,{error:'entity fetch failed'});}
  };
  if(url.pathname==='/'&&req.method==='GET'){res.setHeader('content-type','text/html').end('<!doctype html><title>fixture</title>');return;}
  if(url.pathname==='/api/xml'&&req.method==='POST'){let xml='';try{xml=JSON.parse(raw).xml??'';}catch{}return processXml(xml,true);}
  if(url.pathname==='/api/xml-safe'&&req.method==='POST'){let xml='';try{xml=JSON.parse(raw).xml??'';}catch{}return processXml(xml,false);}
  if(url.pathname==='/api/xml-broken'&&req.method==='POST')return json(500,{error:'unavailable'});
  res.writeHead(404).end();
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const target='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;
const finish=async(id:string)=>{const deadline=Date.now()+60000;while(Date.now()<deadline){const r=readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,50));}throw Error('xxe assessment timed out');};
const xxe=[
  {id:'entityResolving',path:'/api/xml',field:'xml',benignXmlRef:'benignXml',templateRef:'probeTemplate'},
  {id:'entityStripped',path:'/api/xml-safe',field:'xml',benignXmlRef:'benignXml',templateRef:'probeTemplate'},
  {id:'brokenEndpoint',path:'/api/xml-broken',field:'xml',benignXmlRef:'benignXml',templateRef:'probeTemplate'},
];
const input={target,authorized:true,checks:['server_banner'],profile:'campaign' as const,scope:{delayMs:0,maxRequests:200},browser:{postPaths:['/api/xml','/api/xml-safe','/api/xml-broken']},xxe,businessSecrets:{benignXml:'<?xml version="1.0"?><note><value>fixture-benign-note</value></note>',probeTemplate:'<?xml version="1.0"?><note><value>fixture-prefix @LOAM_ENTITY_REF@ suffix</value></note>'}};
try{
  assert.throws(()=>startAssessment(root,{...input,profile:'quick' as any}),/campaign mode/);
  assert.throws(()=>startAssessment(root,{...input,xxe:[{...xxe[0]!,path:'/api/unknown'}]}),/allowlisted in postPaths/);
  assert.throws(()=>startAssessment(root,{...input,xxe:[{...xxe[0]!,path:'/api/xml?x=1'}]}),/exact path/);
  assert.throws(()=>startAssessment(root,{...input,xxe:[{...xxe[0]!,field:'bad field'}]}),/safe JSON field name/);
  assert.throws(()=>startAssessment(root,{...input,businessSecrets:{...input.businessSecrets,probeTemplate:'no placeholder'}}),/must contain the entity placeholder/);
  assert.throws(()=>startAssessment(root,{...input,businessSecrets:{}}),/fresh (business )?input/);
  const first=await finish(startAssessment(root,input).id);
  assert.equal(first.status,'partial',JSON.stringify({proofs:first.xxe?.proofs.map(p=>[p.caseId,p.outcome,p.summary]),findings:first.findings.map(f=>f.check+':'+f.verdict)}));
  assert.equal(first.completed,first.total,'progress accounting must include XXE cases');
  const proofs=first.xxe?.proofs??[];
  assert.equal(proofs.length,3,'three XXE proofs');
  const resolving=proofs.find(p=>p.target.endsWith('/api/xml'))!,stripped=proofs.find(p=>p.target.endsWith('/api/xml-safe'))!,broken=proofs.find(p=>p.target.endsWith('/api/xml-broken'))!;
  assert.ok(resolving&&stripped&&broken,JSON.stringify(proofs.map(p=>p.target)));
  assert.equal(resolving.kind,'xxe');
  assert.equal(resolving.outcome,'observed',JSON.stringify(resolving));
  assert.equal(resolving.observations.baselineClean,true);
  assert.equal(resolving.observations.entityReflected,true);
  assert.equal(resolving.observations.entityCallback,true);
  assert.equal(stripped.outcome,'not_observed',JSON.stringify(stripped));
  assert.equal(stripped.observations.entityReflected,false);
  assert.equal(stripped.observations.entityCallback,false);
  assert.equal(broken.outcome,'inconclusive');
  assert.match(String(broken.summary),/Baseline request was not a complete successful response/);
  const finding=first.findings.find(f=>f.check.startsWith('xxe_')&&f.verdict==='finding');
  assert.ok(finding,JSON.stringify(first.findings));
  assert.equal(finding.severity,'high');
  const xmlPosts=first.evidence.filter(e=>e.method==='POST'&&e.url.endsWith('/api/xml'));
  assert.equal(xmlPosts.length,2,'baseline plus probe');
  assert.ok(xmlPosts.every(e=>e.postPolicy==='/api/xml'&&e.requestBytes!>0));
  for(const secret of ['fixture-benign-note','fixture-prefix','loam<!ENTITY'])assert.ok(!JSON.stringify(first).includes(secret),'XXE values must be redacted');
  const module=first.diagnostics?.modules.find(m=>m.id==='xxe');
  assert.equal(module?.state,'incomplete');assert.equal(module?.planned,3);assert.equal(module?.conclusive,2);assert.equal(module?.inconclusive,1);
  assert.ok(first.covered.some(k=>k.includes('/api/xml-safe')&&k.includes('xxe_')));
  assert.throws(()=>retestAssessment(root,first.id,{authorized:true}),/fresh (business )?input/);
  fixed=true;
  const second=await finish(retestAssessment(root,first.id,{authorized:true,businessSecrets:input.businessSecrets}).id);
  assert.ok(second.comparison?.notObserved.includes(finding.fingerprint),JSON.stringify(second.comparison));
  assert.equal(second.xxe?.proofs.find(p=>p.target.endsWith('/api/xml'))?.outcome,'not_observed','a parser-disabling repair must stop entity resolution');
  console.log('PASS xxe: local entity server witnessed both entity fetch and reflection, DOCTYPE-stripping parser neutral, broken endpoint inconclusive, values redacted, diagnostics module and repaired retest');
}finally{server.closeAllConnections();server.close();}
