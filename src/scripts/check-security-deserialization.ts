import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {startAssessment,readAssessment,retestAssessment} from '../security/assessments.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-security-deser-'));
const FUNC_TAG='_$$ND_FUNC_$$_';
let fixed=false;
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url!,'http://localhost');
  let raw='';for await(const part of req)raw+=part;
  const json=(status:number,payload:unknown)=>{res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(payload));};
  const unserialize=async(serialized:string,evaluate:boolean)=>{
    // Reimplements the node-serialize contract: string values tagged with the
    // function prefix are evaluated; the repair rejects the tag outright.
    const walk=async(value:unknown):Promise<unknown>=>{
      if(typeof value==='string'&&value.startsWith(FUNC_TAG)){
        if(fixed&&url.pathname==='/api/state')return '[rejected]';
        if(!evaluate)return '[stripped]';
        try{const factory=new Function('return ('+value.slice(FUNC_TAG.length)+')');const fn=factory();if(typeof fn==='function')await fn();return '[function]';}catch{return '[error]';}
      }
      if(value&&typeof value==='object'){
        if(Array.isArray(value)){const out:unknown[]=[];for(const item of value)out.push(await walk(item));return out;}
        const out:Record<string,unknown>={};for(const [k,v] of Object.entries(value))out[k]=await walk(v);return out;
      }
      return value;
    };
    let parsed:unknown;try{parsed=JSON.parse(serialized);}catch{return json(400,{error:'invalid payload'});}
    return json(200,{restored:await walk(parsed)});
  };
  if(url.pathname==='/'&&req.method==='GET'){res.setHeader('content-type','text/html').end('<!doctype html><title>fixture</title>');return;}
  if(url.pathname==='/api/state'&&req.method==='POST'){let s='';try{s=JSON.parse(raw).state??'';}catch{}return unserialize(s,true);}
  if(url.pathname==='/api/state-safe'&&req.method==='POST'){let s='';try{s=JSON.parse(raw).state??'';}catch{}return unserialize(s,false);}
  if(url.pathname==='/api/state-broken'&&req.method==='POST')return json(500,{error:'unavailable'});
  res.writeHead(404).end();
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const target='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;
const finish=async(id:string)=>{const deadline=Date.now()+60000;while(Date.now()<deadline){const r=readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,50));}throw Error('deser assessment timed out');};
const deser=[
  {id:'evaluatingUnserializer',path:'/api/state',field:'state',benignRef:'benignState',templateRef:'probeTemplate'},
  {id:'strippingUnserializer',path:'/api/state-safe',field:'state',benignRef:'benignState',templateRef:'probeTemplate'},
  {id:'brokenEndpoint',path:'/api/state-broken',field:'state',benignRef:'benignState',templateRef:'probeTemplate'},
];
const input={target,authorized:true,checks:['server_banner'],profile:'campaign' as const,scope:{delayMs:0,maxRequests:200},browser:{postPaths:['/api/state','/api/state-safe','/api/state-broken']},deser,businessSecrets:{benignState:JSON.stringify({note:'fixture-benign-state'}),probeTemplate:JSON.stringify({note:'fixture-prefix',fn:'@LOAM_FUNC@'})}};
try{
  assert.throws(()=>startAssessment(root,{...input,profile:'quick' as any}),/campaign mode/);
  assert.throws(()=>startAssessment(root,{...input,deser:[{...deser[0]!,path:'/api/unknown'}]}),/allowlisted in postPaths/);
  assert.throws(()=>startAssessment(root,{...input,deser:[{...deser[0]!,path:'/api/state?x=1'}]}),/exact path/);
  assert.throws(()=>startAssessment(root,{...input,deser:[{...deser[0]!,field:'bad field'}]}),/safe JSON field name/);
  assert.throws(()=>startAssessment(root,{...input,businessSecrets:{...input.businessSecrets,probeTemplate:'no placeholder'}}),/must contain the function placeholder/);
  assert.throws(()=>startAssessment(root,{...input,businessSecrets:{}}),/fresh (business )?input/);
  const first=await finish(startAssessment(root,input).id);
  assert.equal(first.status,'partial',JSON.stringify({proofs:first.deser?.proofs.map(p=>[p.caseId,p.outcome,p.summary]),findings:first.findings.map(f=>f.check+':'+f.verdict)}));
  assert.equal(first.completed,first.total,'progress accounting must include deserialization cases');
  const proofs=first.deser?.proofs??[];
  assert.equal(proofs.length,3,'three deserialization proofs');
  const evaluating=proofs.find(p=>p.target.endsWith('/api/state'))!,stripping=proofs.find(p=>p.target.endsWith('/api/state-safe'))!,broken=proofs.find(p=>p.target.endsWith('/api/state-broken'))!;
  assert.ok(evaluating&&stripping&&broken,JSON.stringify(proofs.map(p=>p.target)));
  assert.equal(evaluating.kind,'deser');
  assert.equal(evaluating.outcome,'observed',JSON.stringify(evaluating));
  assert.equal(evaluating.observations.baselineClean,true);
  assert.equal(evaluating.observations.callbackReceived,true);
  assert.equal(stripping.outcome,'not_observed',JSON.stringify(stripping));
  assert.equal(stripping.observations.callbackReceived,false);
  assert.equal(broken.outcome,'inconclusive');
  assert.match(String(broken.summary),/Baseline request was not accepted/);
  const finding=first.findings.find(f=>f.check.startsWith('deser_')&&f.verdict==='finding');
  assert.ok(finding,JSON.stringify(first.findings));
  assert.equal(finding.severity,'critical');
  const statePosts=first.evidence.filter(e=>e.method==='POST'&&e.url.endsWith('/api/state'));
  assert.equal(statePosts.length,2,'baseline plus probe');
  assert.ok(statePosts.every(e=>e.postPolicy==='/api/state'&&e.requestBytes!>0));
  for(const secret of ['fixture-benign-state','fixture-prefix','@LOAM_FUNC@'])assert.ok(!JSON.stringify(first).includes(secret),'deserialization values must be redacted');
  const module=first.diagnostics?.modules.find(m=>m.id==='deser');
  assert.equal(module?.state,'incomplete');assert.equal(module?.planned,3);assert.equal(module?.conclusive,2);assert.equal(module?.inconclusive,1);
  assert.ok(first.covered.some(k=>k.includes('/api/state-safe')&&k.includes('deser_')));
  assert.throws(()=>retestAssessment(root,first.id,{authorized:true}),/fresh (business )?input/);
  fixed=true;
  const second=await finish(retestAssessment(root,first.id,{authorized:true,businessSecrets:input.businessSecrets}).id);
  assert.ok(second.comparison?.notObserved.includes(finding.fingerprint),JSON.stringify(second.comparison));
  assert.equal(second.deser?.proofs.find(p=>p.target.endsWith('/api/state'))?.outcome,'not_observed','a tag-rejecting repair must stop execution');
  console.log('PASS deserialization: function-tag canary executed one tokenized loopback fetch through the evaluating unserializer, tag-stripping parser neutral, broken endpoint inconclusive, values redacted, diagnostics module and repaired retest');
}finally{server.closeAllConnections();server.close();}
