import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {startAssessment,readAssessment,retestAssessment} from '../security/assessments.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-security-template-'));
let fixed=false;
const evaluate=(v:string,enabled:boolean)=>{
  if(!enabled)return v;
  // The vulnerable handler compiles the value as a template for the three
  // supported syntaxes and renders arithmetic expressions.
  const patterns=[/\{\{([\d*+\/\-\s]+)\}\}/g,/\$\{([\d*+\/\-\s]+)\}/g,/<%=\s*([\d*+\/\-\s]+)\s*%>/g];
  let out=v;
  for(const re of patterns)out=out.replace(re,(_,expr)=>String(new Function('return ('+expr+')')()));
  return out;
};
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url!,'http://localhost');
  let raw='';for await(const part of req)raw+=part;
  const json=(status:number,payload:unknown)=>{res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(payload));};
  const valueOf=()=>url.searchParams.get('tpl')??'';
  if(url.pathname==='/'&&req.method==='GET'){res.setHeader('content-type','text/html').end('<!doctype html><title>fixture</title>');return;}
  if(url.pathname==='/render'&&req.method==='GET')return json(200,{rendered:evaluate(valueOf(),!fixed)});
  if(url.pathname==='/render-safe'&&req.method==='GET')return json(200,{rendered:evaluate(valueOf(),false)});
  if(url.pathname==='/render-broken'&&req.method==='GET')return json(500,{error:'unavailable'});
  res.writeHead(404).end();
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const target='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;
const finish=async(id:string)=>{const deadline=Date.now()+60000;while(Date.now()<deadline){const r=readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,50));}throw Error('template assessment timed out');};
const template=[
  {id:'mustacheVulnerable',syntax:'mustache' as const,method:'get' as const,path:'/render',field:'tpl',baselineRef:'tplBaseline'},
  {id:'dollarVulnerable',syntax:'dollar' as const,method:'get' as const,path:'/render',field:'tpl',baselineRef:'tplBaseline'},
  {id:'guardedRender',syntax:'mustache' as const,method:'get' as const,path:'/render-safe',field:'tpl',baselineRef:'tplBaseline'},
  {id:'brokenEndpoint',syntax:'mustache' as const,method:'get' as const,path:'/render-broken',field:'tpl',baselineRef:'tplBaseline'},
];
const input={target,authorized:true,checks:['server_banner'],profile:'campaign' as const,scope:{delayMs:0,maxRequests:200},template,businessSecrets:{tplBaseline:'welcome'}};
try{
  assert.throws(()=>startAssessment(root,{...input,profile:'quick' as any}),/campaign mode/);
  assert.throws(()=>startAssessment(root,{...input,template:[{...template[0]!,syntax:'jinja' as any}]}),/syntax must be mustache, dollar or erb/);
  assert.throws(()=>startAssessment(root,{...input,template:[{...template[0]!,path:'/render?x=1'}]}),/exact path/);
  assert.throws(()=>startAssessment(root,{...input,template:[{...template[0]!,field:'action'}]}),/safe field or parameter name/);
  assert.throws(()=>startAssessment(root,{...input,businessSecrets:{tplBaseline:'contains 42 already'}}),/must not contain either computed witness/);
  assert.throws(()=>startAssessment(root,{...input,businessSecrets:{}}),/fresh (business )?input/);
  const first=await finish(startAssessment(root,input).id);
  assert.equal(first.status,'partial',JSON.stringify({proofs:first.template?.proofs.map(p=>[p.caseId,p.outcome,p.summary]),findings:first.findings.map(f=>f.check+':'+f.verdict)}));
  assert.equal(first.completed,first.total,'progress accounting must include template cases');
  const proofs=first.template?.proofs??[];
  assert.equal(proofs.length,4,'four template proofs');
  const mustache=proofs.find(p=>p.caseId==='mustacheVulnerable')!,dollar=proofs.find(p=>p.caseId==='dollarVulnerable')!,guarded=proofs.find(p=>p.caseId==='guardedRender')!,broken=proofs.find(p=>p.caseId==='brokenEndpoint')!;
  assert.ok(mustache&&dollar&&guarded&&broken,JSON.stringify(proofs.map(p=>p.caseId)));
  assert.equal(mustache.kind,'template');
  assert.equal(mustache.outcome,'observed',JSON.stringify(mustache));
  assert.equal(mustache.observations.baselineStable,true);
  assert.equal(mustache.observations.truthEvaluated,true);
  assert.equal(mustache.observations.falsyEvaluated,true);
  assert.equal(dollar.outcome,'observed',JSON.stringify(dollar));
  assert.equal(dollar.observations.truthEvaluated,true);
  assert.equal(guarded.outcome,'not_observed',JSON.stringify(guarded));
  assert.equal(guarded.observations.payloadEchoedRaw,true);
  assert.equal(guarded.observations.truthEvaluated,false);
  assert.equal(broken.outcome,'inconclusive');
  assert.match(String(broken.summary),/Baseline request was not a complete successful response/);
  const findings=first.findings.filter(f=>f.check.startsWith('template_')&&f.verdict==='finding');
  assert.equal(findings.length,2,JSON.stringify(first.findings));
  assert.ok(findings.every(f=>f.severity==='high'));
  const renderGets=first.evidence.filter(e=>e.method==='GET'&&e.url.endsWith('/render'));
  assert.equal(renderGets.length,8,'four probes for each of the two vulnerable cases');
  assert.ok(first.covered.some(k=>k.includes('/render-safe')&&k.includes('template_')));
  assert.ok(!JSON.stringify(first).includes('welcome'),'the baseline value must be redacted');
  const module=first.diagnostics?.modules.find(m=>m.id==='template');
  assert.equal(module?.state,'incomplete');assert.equal(module?.planned,4);assert.equal(module?.conclusive,3);assert.equal(module?.inconclusive,1);
  assert.throws(()=>retestAssessment(root,first.id,{authorized:true}),/fresh (business )?input/);
  fixed=true;
  const second=await finish(retestAssessment(root,first.id,{authorized:true,businessSecrets:input.businessSecrets}).id);
  for(const f of findings)assert.ok(second.comparison?.notObserved.includes(f.fingerprint),JSON.stringify(second.comparison));
  assert.equal(second.template?.proofs.find(p=>p.caseId==='mustacheVulnerable')?.outcome,'not_observed','a repair that treats input as data must stop evaluation');
  console.log('PASS template: dual-expression arithmetic canaries evaluated in mustache and dollar syntaxes with clean stable baselines, data-only render echoing them raw, broken endpoint inconclusive, baseline redacted, diagnostics module and repaired retest');
}finally{server.closeAllConnections();server.close();}
