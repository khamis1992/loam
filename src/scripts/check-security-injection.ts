import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {startAssessment,readAssessment,retestAssessment} from '../security/assessments.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-security-injection-'));
const users=[{name:'alice',tier:'gold'},{name:'bob',tier:'silver'},{name:'carol',tier:'bronze'}];
let fixed=false;
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url!,'http://localhost');
  let raw='';for await(const part of req)raw+=part;
  const json=(status:number,payload:unknown)=>{res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(payload));};
  const sqlRows=(name:string)=>{
    // The vulnerable handler emulates naive SQL string concatenation:
    // ... WHERE name = '<name>' — payload suffixes break out of the literal.
    const taut=/' AND '1'='1$/.exec(name),fals=/' AND '1'='2$/.exec(name);
    if(taut)return users.filter(u=>u.name===name.slice(0,taut.index));
    if(fals)return [];
    return users.filter(u=>u.name===name);
  };
  const safeRows=(name:string)=>users.filter(u=>u.name===name.replace(/'/g,"''"));
  if(url.pathname==='/'&&req.method==='GET'){res.setHeader('content-type','text/html').end('<!doctype html><title>fixture</title>');return;}
  if(url.pathname==='/search'&&req.method==='GET')return json(200,{rows:fixed?safeRows(url.searchParams.get('name')??''):sqlRows(url.searchParams.get('name')??'')});
  if(url.pathname==='/search-safe'&&req.method==='GET')return json(200,{rows:safeRows(url.searchParams.get('name')??'')});
  if(url.pathname==='/api/find'&&req.method==='POST'){
    // The vulnerable handler passes the JSON value straight into a document filter.
    let value:unknown={};try{value=JSON.parse(raw).name;}catch{}
    if(value&&typeof value==='object'&&value!==null&&'$eq' in (value as object)){
      if(fixed)return json(400,{error:'invalid name'});
      const expected=(value as {$eq:unknown}).$eq;
      return json(200,{rows:users.filter(u=>u.name===expected)});
    }
    return json(200,{rows:users.filter(u=>u.name===value)});
  }
  if(url.pathname==='/api/find-safe'&&req.method==='POST'){
    // The repair rejects operator objects with strict scalar validation.
    let value:unknown={};try{value=JSON.parse(raw).name;}catch{}
    if(value&&typeof value==='object')return json(400,{error:'invalid name'});
    return json(200,{rows:users.filter(u=>u.name===value)});
  }
  if(url.pathname==='/search-broken'&&req.method==='GET')return json(500,{error:'unavailable'});
  res.writeHead(404).end();
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const target='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;
const finish=async(id:string)=>{const deadline=Date.now()+60000;while(Date.now()<deadline){const r=readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,50));}throw Error('injection assessment timed out');};
const injection=[
  {id:'sqlVulnerable',kind:'sql' as const,method:'GET' as const,path:'/search',field:'name',baselineRef:'sqlBaseline'},
  {id:'sqlProtected',kind:'sql' as const,method:'GET' as const,path:'/search-safe',field:'name',baselineRef:'sqlBaseline'},
  {id:'nosqlVulnerable',kind:'nosql' as const,method:'POST' as const,path:'/api/find',field:'name',baselineRef:'nosqlBaseline'},
  {id:'nosqlProtected',kind:'nosql' as const,method:'POST' as const,path:'/api/find-safe',field:'name',baselineRef:'nosqlBaseline'},
  {id:'brokenBaseline',kind:'sql' as const,method:'GET' as const,path:'/search-broken',field:'name',baselineRef:'sqlBaseline'},
];
const input={target,authorized:true,checks:['server_banner'],profile:'campaign' as const,scope:{delayMs:0,maxRequests:300},browser:{postPaths:['/api/find','/api/find-safe']},injection,businessSecrets:{sqlBaseline:'alice',nosqlBaseline:'alice'}};
try{
  assert.throws(()=>startAssessment(root,{...input,profile:'quick' as any}),/campaign mode/);
  assert.throws(()=>startAssessment(root,{...input,injection:[{...injection[0]!,kind:'xss' as any}]}),/kind must be sql or nosql/);
  assert.throws(()=>startAssessment(root,{...input,injection:[{...injection[2]!,path:'/api/unknown'}]}),/allowlisted in postPaths/);
  assert.throws(()=>startAssessment(root,{...input,injection:[{...injection[0]!,path:'/search?x=1'}]}),/exact path/);
  assert.throws(()=>startAssessment(root,{...input,businessSecrets:{}}),/fresh (business )?input/);
  const first=await finish(startAssessment(root,input).id);
  assert.equal(first.status,'partial',JSON.stringify({proofs:first.injection?.proofs.map(p=>[p.caseId,p.outcome,p.summary]),findings:first.findings.map(f=>f.check+':'+f.verdict)}));
  assert.equal(first.completed,first.total,'progress accounting must include injection cases');
  const proofs=first.injection?.proofs??[];
  assert.equal(proofs.length,5,'five injection proofs');
  const sqlVuln=proofs.find(p=>p.caseId==='sqlVulnerable')!,sqlSafe=proofs.find(p=>p.caseId==='sqlProtected')!;
  const nosqlVuln=proofs.find(p=>p.caseId==='nosqlVulnerable')!,nosqlSafe=proofs.find(p=>p.caseId==='nosqlProtected')!;
  const broken=proofs.find(p=>p.caseId==='brokenBaseline')!;
  assert.ok(sqlVuln&&sqlSafe&&nosqlVuln&&nosqlSafe&&broken,JSON.stringify(proofs.map(p=>p.caseId)));
  assert.equal(sqlVuln.kind,'injection');
  assert.equal(sqlVuln.outcome,'observed',JSON.stringify(sqlVuln));
  assert.equal(sqlVuln.observations.baselineStable,true);
  assert.equal(sqlVuln.observations.tautologyAbsorbed,true);
  assert.equal(sqlVuln.observations.contradictionDistinguished,true);
  assert.equal(sqlSafe.outcome,'not_observed',JSON.stringify(sqlSafe));
  assert.equal(sqlSafe.observations.tautologyAbsorbed,false);
  assert.equal(nosqlVuln.outcome,'observed',JSON.stringify(nosqlVuln));
  assert.equal(nosqlVuln.observations.tautologyAbsorbed,true);
  assert.equal(nosqlVuln.observations.contradictionDistinguished,true);
  assert.equal(nosqlSafe.outcome,'not_observed',JSON.stringify(nosqlSafe));
  assert.equal(broken.outcome,'inconclusive');
  assert.match(String(broken.summary),/Baseline request was not a complete successful response/);
  const findings=first.findings.filter(f=>f.check.startsWith('injection_')&&f.verdict==='finding');
  assert.equal(findings.length,2,JSON.stringify(first.findings));
  assert.ok(findings.some(f=>f.target.includes('/search')&&f.title.includes('SQL')));
  assert.ok(findings.some(f=>f.target.includes('/api/find')&&f.title.includes('NoSQL')));
  assert.ok(findings.every(f=>f.severity==='high'));
  const searchGets=first.evidence.filter(e=>e.method==='GET'&&e.url.endsWith('/search'));
  assert.equal(searchGets.length,4,'baseline, tautology, contradiction and stability repeat');
  const findPosts=first.evidence.filter(e=>e.method==='POST'&&e.url.endsWith('/api/find'));
  assert.equal(findPosts.length,4);
  assert.ok(findPosts.every(e=>e.postPolicy==='/api/find'&&e.requestBytes!>0));
  assert.ok(!JSON.stringify(first).includes('alice'),'the baseline value must be redacted from stored output');
  const module=first.diagnostics?.modules.find(m=>m.id==='injection');
  assert.equal(module?.state,'incomplete');assert.equal(module?.planned,5);assert.equal(module?.conclusive,4);assert.equal(module?.inconclusive,1);
  assert.ok(first.covered.some(k=>k.includes('/search-safe')&&k.includes('injection_')));
  assert.throws(()=>retestAssessment(root,first.id,{authorized:true}),/fresh (business )?input/);
  fixed=true;
  const second=await finish(retestAssessment(root,first.id,{authorized:true,businessSecrets:input.businessSecrets}).id);
  for(const f of findings)assert.ok(second.comparison?.notObserved.includes(f.fingerprint),JSON.stringify(second.comparison));
  assert.equal(second.injection?.proofs.find(p=>p.caseId==='sqlVulnerable')?.outcome,'not_observed','an escaping repair must break the differential');
  console.log('PASS injection: repeatable boolean differentials confirmed SQL and NoSQL injection with tautology absorption and stability controls, escaping and strict-schema repairs neutralized, broken baseline inconclusive, baseline value redacted, diagnostics module and repaired retest');
}finally{server.closeAllConnections();server.close();}
