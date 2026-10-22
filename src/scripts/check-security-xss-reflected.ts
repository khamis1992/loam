import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {startAssessment,readAssessment,retestAssessment} from '../security/assessments.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-security-xss-'));
let fixed=false;
const escape=(v:string)=>v.replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]!));
const page=(title:string)=>`<!doctype html><html><head><title>fixture</title></head><body><h1>${title}</h1></body></html>`;
const server=http.createServer((req,res)=>{
  const url=new URL(req.url!,'http://localhost');
  res.setHeader('content-type','text/html; charset=utf-8');
  if(url.pathname==='/search'){
    const q=url.searchParams.get('q')??'';
    // Vulnerable: the raw parameter is interpolated into HTML text without encoding.
    res.end(page(fixed?escape(q):`Results for ${q}`));return;
  }
  if(url.pathname==='/safe'){res.end(page(`Results for ${escape(url.searchParams.get('q')??'')}`));return;}
  if(url.pathname==='/ignore'){res.end(page('Static'));return;}
  if(url.pathname==='/broken'){res.writeHead(500).end('unavailable');return;}
  if(url.pathname==='/'){res.end(page('Home'));return;}
  res.writeHead(404).end();
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const target='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;
const finish=async(id:string)=>{const deadline=Date.now()+90000;while(Date.now()<deadline){const r=readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,100));}throw Error('xss assessment timed out');};
const browser={enabled:true,screenshots:false,maxPages:1,settleMs:250,networkIdleTimeoutMs:2000,xssReflected:[
  {id:'rawReflection',path:'/search',param:'q'},
  {id:'escapedReflection',path:'/safe',param:'q'},
  {id:'notReflected',path:'/ignore',param:'q'},
  {id:'brokenBaseline',path:'/broken',param:'q'},
]};
const input={target,authorized:true,checks:['server_banner'],scope:{delayMs:0,maxRequests:200},browser};
try{
  assert.throws(()=>startAssessment(root,{...input,browser:{...browser,enabled:false}}),/Reflected XSS checks require the browser engine/);
  assert.throws(()=>startAssessment(root,{...input,browser:{...browser,xssReflected:[{id:'bad',path:'/search?q=1',param:'q'}]}}),/exact scoped path/);
  assert.throws(()=>startAssessment(root,{...input,browser:{...browser,xssReflected:[{id:'bad',path:'/search',param:'action'}]}}),/safe parameter name/);
  const first=await finish(startAssessment(root,input).id);
  assert.equal(first.status,'partial',JSON.stringify({proofs:first.browser?.proofs.map(p=>[p.kind,p.outcome,p.summary]),findings:first.findings.map(f=>f.check+':'+f.verdict)}));
  const proofs=(first.browser?.proofs??[]).filter(p=>p.kind==='xss_reflected');
  assert.equal(proofs.length,4,'four reflected XSS proofs');
  const rawProof=proofs.find(p=>p.target.endsWith('/search'))!;
  const escaped=proofs.find(p=>p.target.endsWith('/safe'))!;
  const ignored=proofs.find(p=>p.target.endsWith('/ignore'))!;
  const broken=proofs.find(p=>p.target.endsWith('/broken'))!;
  assert.ok(rawProof&&escaped&&ignored&&broken,JSON.stringify(proofs.map(p=>p.target)));
  assert.equal(rawProof.outcome,'observed',JSON.stringify(rawProof));
  assert.equal((rawProof.observations as any).executed,true);
  assert.equal((rawProof.observations as any).reflected,true);
  assert.equal((rawProof.observations as any).baselineClean,true);
  assert.equal(escaped.outcome,'not_observed',JSON.stringify(escaped));
  assert.equal((escaped.observations as any).reflected,true);
  assert.equal((escaped.observations as any).executed,false);
  assert.equal(ignored.outcome,'not_observed',JSON.stringify(ignored));
  assert.equal((ignored.observations as any).reflected,false);
  assert.equal(broken.outcome,'inconclusive');
  assert.match(String(broken.summary),/Baseline control failed/);
  const finding=first.findings.find(f=>f.check.startsWith('xss_reflected_')&&f.verdict==='finding');
  assert.ok(finding,JSON.stringify(first.findings));
  assert.equal(finding.severity,'high');
  assert.ok(finding.target.includes('/search'));
  assert.ok(!JSON.stringify(first).includes('onerror='),'the canary payload must never be recorded');
  const module=first.diagnostics?.modules.find(m=>m.id==='xss_reflected');
  assert.equal(module?.state,'incomplete');assert.equal(module?.planned,4);assert.equal(module?.conclusive,3);assert.equal(module?.inconclusive,1);
  assert.ok(first.covered.some(k=>k.includes('/safe')&&k.includes('xss_reflected_')));
  fixed=true;
  const second=await finish(retestAssessment(root,first.id,{authorized:true}).id);
  assert.ok(second.comparison?.notObserved.includes(finding.fingerprint),JSON.stringify(second.comparison));
  const secondRaw=(second.browser?.proofs??[]).filter(p=>p.kind==='xss_reflected').find(p=>p.target.endsWith('/search'))!;
  assert.equal(secondRaw.outcome,'not_observed','an escaped reflection must not execute after repair');
  console.log('PASS reflected xss: raw parameter canary executed with a clean baseline control, escaped reflection neutralized, unreflected parameter reported as coverage, broken baseline inconclusive, payload never recorded, diagnostics module and repaired retest');
}finally{server.closeAllConnections();server.close();}
