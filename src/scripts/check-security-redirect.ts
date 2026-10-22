import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {startAssessment,readAssessment,retestAssessment} from '../security/assessments.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-security-redirect-'));
let fixed=false;
const server=http.createServer((req,res)=>{
  const url=new URL(req.url!,'http://localhost');
  if(url.pathname==='/'&&req.method==='GET'){res.setHeader('content-type','text/html').end('<!doctype html><title>fixture</title>');return;}
  const go=(validate:boolean)=>{
    const to=url.searchParams.get('to')??'';
    if(validate||fixed){
      // The guarded handler allows in-origin paths only and falls back home.
      if(!to.startsWith('/')||to.startsWith('//'))return res.writeHead(302,{location:'/home'}).end();
    }
    // The vulnerable handler passes the raw value into Location.
    return res.writeHead(302,{location:to}).end();
  };
  if(url.pathname==='/go'&&req.method==='GET')return go(false);
  if(url.pathname==='/go-safe'&&req.method==='GET')return go(true);
  if(url.pathname==='/go-broken'&&req.method==='GET')return res.writeHead(500).end('unavailable');
  res.writeHead(404).end();
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const target='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;
const finish=async(id:string)=>{const deadline=Date.now()+60000;while(Date.now()<deadline){const r=readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,50));}throw Error('redirect assessment timed out');};
const redirectCases=[
  {id:'rawPassThrough',path:'/go',param:'to',safeTargetRef:'safeTarget',foreignOriginRef:'foreignOrigin'},
  {id:'allowlistedTarget',path:'/go-safe',param:'to',safeTargetRef:'safeTarget',foreignOriginRef:'foreignOrigin'},
  {id:'brokenEndpoint',path:'/go-broken',param:'to',safeTargetRef:'safeTarget',foreignOriginRef:'foreignOrigin'},
];
const input={target,authorized:true,checks:['server_banner'],profile:'campaign' as const,scope:{delayMs:0,maxRequests:200},redirect:redirectCases,businessSecrets:{safeTarget:'/dashboard',foreignOrigin:'https://example.invalid'}};
try{
  assert.throws(()=>startAssessment(root,{...input,profile:'quick' as any}),/campaign mode/);
  assert.throws(()=>startAssessment(root,{...input,redirect:[{...redirectCases[0]!,path:'/go?x=1'}]}),/exact path/);
  assert.throws(()=>startAssessment(root,{...input,redirect:[{...redirectCases[0]!,param:'action'}]}),/safe parameter name/);
  assert.throws(()=>startAssessment(root,{...input,businessSecrets:{...input.businessSecrets,safeTarget:'https://elsewhere/x'}}),/absolute in-origin path/);
  assert.throws(()=>startAssessment(root,{...input,businessSecrets:{...input.businessSecrets,foreignOrigin:'http://insecure'}}),/https URL base/);
  assert.throws(()=>startAssessment(root,{...input,businessSecrets:{}}),/fresh (business )?input/);
  const first=await finish(startAssessment(root,input).id);
  assert.equal(first.status,'partial',JSON.stringify({proofs:first.redirect?.proofs.map(p=>[p.caseId,p.outcome,p.summary]),findings:first.findings.map(f=>f.check+':'+f.verdict)}));
  assert.equal(first.completed,first.total,'progress accounting must include redirect cases');
  const proofs=first.redirect?.proofs??[];
  assert.equal(proofs.length,3,'three redirect proofs');
  const raw=proofs.find(p=>p.target.endsWith('/go'))!,guarded=proofs.find(p=>p.target.endsWith('/go-safe'))!,broken=proofs.find(p=>p.target.endsWith('/go-broken'))!;
  assert.ok(raw&&guarded&&broken,JSON.stringify(proofs.map(p=>p.target)));
  assert.equal(raw.kind,'redirect');
  assert.equal(raw.outcome,'observed',JSON.stringify(raw));
  assert.equal(raw.observations.controlInOrigin,true);
  assert.equal(raw.observations.foreignLocationPassed,true);
  assert.equal(guarded.outcome,'not_observed',JSON.stringify(guarded));
  assert.equal(guarded.observations.foreignLocationPassed,false);
  assert.equal(broken.outcome,'inconclusive');
  assert.match(String(broken.summary),/Positive control failed/);
  const finding=first.findings.find(f=>f.check.startsWith('redirect_')&&f.verdict==='finding');
  assert.ok(finding,JSON.stringify(first.findings));
  assert.equal(finding.severity,'medium');
  const goGets=first.evidence.filter(e=>e.method==='GET'&&e.url.endsWith('/go'));
  assert.equal(goGets.length,2,'control plus probe');
  assert.ok(first.covered.some(k=>k.includes('/go-safe')&&k.includes('redirect_')));
  assert.ok(!JSON.stringify(first).includes('https://example.invalid/loam'),'the tokenized foreign URL must never be recorded');
  const module=first.diagnostics?.modules.find(m=>m.id==='redirect');
  assert.equal(module?.state,'incomplete');assert.equal(module?.planned,3);assert.equal(module?.conclusive,2);assert.equal(module?.inconclusive,1);
  assert.throws(()=>retestAssessment(root,first.id,{authorized:true}),/fresh (business )?input/);
  fixed=true;
  const second=await finish(retestAssessment(root,first.id,{authorized:true,businessSecrets:input.businessSecrets}).id);
  assert.ok(second.comparison?.notObserved.includes(finding.fingerprint),JSON.stringify(second.comparison));
  assert.equal(second.redirect?.proofs.find(p=>p.target.endsWith('/go'))?.outcome,'not_observed','an allowlist repair must normalize the foreign URL away');
  console.log('PASS redirect: raw parameter passed a tokenized foreign URL into Location verbatim with an in-origin control, allowlisted handler normalized it, broken endpoint inconclusive, tokenized URL never recorded, diagnostics module and repaired retest');
}finally{server.closeAllConnections();server.close();}
