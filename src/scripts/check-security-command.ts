import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {exec} from 'node:child_process';
import {promisify} from 'node:util';
import {startAssessment,readAssessment,retestAssessment} from '../security/assessments.js';

const run= promisify(exec);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-security-command-'));
let fixed=false;
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url!,'http://localhost');
  let raw='';for await(const part of req)raw+=part;
  const json=(status:number,payload:unknown)=>{res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(payload));};
  const lookup=async(host:string,validate:boolean)=>{
    if(validate||fixed){
      // The guarded handler accepts hostnames/IPs only.
      if(!/^[a-zA-Z0-9.-]+$/.test(host))return json(400,{error:'invalid host'});
    }
    try{
      // The vulnerable handler interpolates the raw value into a shell command.
      const isWin=process.platform==='win32';
      const {stdout}=await run((isWin?`ping -n 1 ${host}`:`ping -c 1 ${host}`),{timeout:15000});
      return json(200,{lines:stdout.split(/\r?\n/).length});
    }catch(error){return json(200,{lines:0,error:(error as Error).message.slice(0,80)});}
  };
  if(url.pathname==='/'&&req.method==='GET'){res.setHeader('content-type','text/html').end('<!doctype html><title>fixture</title>');return;}
  if(url.pathname==='/api/lookup'&&req.method==='POST'){let host='';try{host=JSON.parse(raw).host??'';}catch{}return lookup(host,false);}
  if(url.pathname==='/api/lookup-safe'&&req.method==='POST'){let host='';try{host=JSON.parse(raw).host??'';}catch{}return lookup(host,true);}
  if(url.pathname==='/api/lookup-broken'&&req.method==='POST')return json(500,{error:'unavailable'});
  res.writeHead(404).end();
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const target='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;
const finish=async(id:string)=>{const deadline=Date.now()+90000;while(Date.now()<deadline){const r=readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,100));}throw Error('command assessment timed out');};
const commandCases=[
  {id:'shellInterpolation',path:'/api/lookup',field:'host',benignRef:'benignHost',templateRef:'probeTemplate'},
  {id:'validatedHost',path:'/api/lookup-safe',field:'host',benignRef:'benignHost',templateRef:'probeTemplate'},
  {id:'brokenEndpoint',path:'/api/lookup-broken',field:'host',benignRef:'benignHost',templateRef:'probeTemplate'},
];
const input={target,authorized:true,checks:['server_banner'],profile:'campaign' as const,scope:{delayMs:0,maxRequests:200},browser:{postPaths:['/api/lookup','/api/lookup-safe','/api/lookup-broken']},command:commandCases,businessSecrets:{benignHost:'127.0.0.1',probeTemplate:'127.0.0.1 && @LOAM_CMD@'}};
try{
  assert.throws(()=>startAssessment(root,{...input,profile:'quick' as any}),/campaign mode/);
  assert.throws(()=>startAssessment(root,{...input,command:[{...commandCases[0]!,path:'/api/unknown'}]}),/allowlisted in postPaths/);
  assert.throws(()=>startAssessment(root,{...input,command:[{...commandCases[0]!,path:'/api/lookup?x=1'}]}),/exact path/);
  assert.throws(()=>startAssessment(root,{...input,command:[{...commandCases[0]!,field:'bad field'}]}),/safe JSON field name/);
  assert.throws(()=>startAssessment(root,{...input,businessSecrets:{...input.businessSecrets,probeTemplate:'no placeholder'}}),/must contain the command placeholder/);
  assert.throws(()=>startAssessment(root,{...input,businessSecrets:{}}),/fresh (business )?input/);
  const first=await finish(startAssessment(root,input).id);
  assert.equal(first.status,'partial',JSON.stringify({proofs:first.command?.proofs.map(p=>[p.caseId,p.outcome,p.summary]),findings:first.findings.map(f=>f.check+':'+f.verdict)}));
  assert.equal(first.completed,first.total,'progress accounting must include command cases');
  const proofs=first.command?.proofs??[];
  assert.equal(proofs.length,3,'three command proofs');
  const shell=proofs.find(p=>p.target.endsWith('/api/lookup'))!,validated=proofs.find(p=>p.target.endsWith('/api/lookup-safe'))!,broken=proofs.find(p=>p.target.endsWith('/api/lookup-broken'))!;
  assert.ok(shell&&validated&&broken,JSON.stringify(proofs.map(p=>p.target)));
  assert.equal(shell.kind,'command');
  assert.equal(shell.outcome,'observed',JSON.stringify(shell));
  assert.equal(shell.observations.baselineClean,true);
  assert.equal(shell.observations.callbackReceived,true);
  assert.equal(validated.outcome,'not_observed',JSON.stringify(validated));
  assert.equal(validated.observations.callbackReceived,false);
  assert.equal(validated.observations.probeStatus,400);
  assert.equal(broken.outcome,'inconclusive');
  assert.match(String(broken.summary),/Baseline request was not accepted/);
  const finding=first.findings.find(f=>f.check.startsWith('command_')&&f.verdict==='finding');
  assert.ok(finding,JSON.stringify(first.findings));
  assert.equal(finding.severity,'critical');
  const lookupPosts=first.evidence.filter(e=>e.method==='POST'&&e.url.endsWith('/api/lookup'));
  assert.equal(lookupPosts.length,2,'baseline plus probe');
  assert.ok(lookupPosts.every(e=>e.postPolicy==='/api/lookup'&&e.requestBytes!>0));
  for(const secret of ['127.0.0.1 &&'])assert.ok(!JSON.stringify(first).includes(secret),'the probe template must be redacted');
  const module=first.diagnostics?.modules.find(m=>m.id==='command');
  assert.equal(module?.state,'incomplete');assert.equal(module?.planned,3);assert.equal(module?.conclusive,2);assert.equal(module?.inconclusive,1);
  assert.ok(first.covered.some(k=>k.includes('/api/lookup-safe')&&k.includes('command_')));
  assert.throws(()=>retestAssessment(root,first.id,{authorized:true}),/fresh (business )?input/);
  fixed=true;
  const second=await finish(retestAssessment(root,first.id,{authorized:true,businessSecrets:input.businessSecrets}).id);
  assert.ok(second.comparison?.notObserved.includes(finding.fingerprint),JSON.stringify(second.comparison));
  assert.equal(second.command?.proofs.find(p=>p.target.endsWith('/api/lookup'))?.outcome,'not_observed','a host-validation repair must block the chain');
  console.log('PASS command: chained curl canary executed through shell interpolation and reached the tokenized witness, host validation blocked it, broken endpoint inconclusive, template redacted, diagnostics module and repaired retest');
}finally{server.closeAllConnections();server.close();}
