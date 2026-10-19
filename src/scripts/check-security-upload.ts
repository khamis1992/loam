import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {startAssessment,readAssessment,retestAssessment} from '../security/assessments.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-security-upload-'));
const store=new Map<string,string>();
let fixed=false;
const readMultipart=(req:http.IncomingMessage):Promise<Array<{name:string,filename:string,content:string}>>=>new Promise(resolve=>{
  const contentType=req.headers['content-type']??'';
  const boundary=/boundary=(.+)$/.exec(contentType)?.[1];
  const chunks:Buffer[]=[];let size=0;
  req.on('data',(chunk:Buffer)=>{if(size<200000){chunks.push(chunk);size+=chunk.length;}});
  req.on('end',()=>{
    const body=Buffer.concat(chunks).toString('binary');
    const parts:Array<{name:string;filename:string;content:string}>=[];const rawParts=body.split('--'+(boundary??''));
    const header=/filename="([^"]*)"/;
    const nameRe=/name="([^"]*)"/;
    for(const raw of rawParts){
      const split=raw.indexOf('\r\n\r\n');if(split<0)continue;
      const head=raw.slice(0,split);const content=raw.slice(split+4).replace(/\r\n$/,'');
      const filename=header.exec(head)?.[1];const name=nameRe.exec(head)?.[1];
      if(filename!==undefined&&name!==undefined)parts.push({name,filename,content});
    }
    resolve(parts);
  });
});
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url!,'http://localhost');
  const json=(status:number,payload:unknown)=>{res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(payload));};
  if(url.pathname==='/'&&req.method==='GET'){res.setHeader('content-type','text/html').end('<!doctype html><title>fixture</title>');return;}
  const upload=(allowed:boolean)=>{
    return async()=>{
      const parts=await readMultipart(req);
      const file=parts.find(p=>p.name==='file');
      if(!file)return json(400,{error:'file field missing'});
      // The guarded endpoint enforces an extension allowlist; the repair adds it to the vulnerable one.
      if((allowed||fixed)&&/\.(html|exe|svg|php)$/i.test(file.filename))return json(415,{error:'file type not allowed'});
      store.set(file.filename,file.content);
      return json(201,{stored:file.filename});
    };
  };
  if(url.pathname==='/api/upload'&&req.method==='POST')return (await upload(false))();
  if(url.pathname==='/api/upload-safe'&&req.method==='POST')return (await upload(true))();
  if(url.pathname==='/api/upload-broken'&&req.method==='POST')return json(500,{error:'unavailable'});
  if(url.pathname==='/files'&&req.method==='GET'){
    const name=url.searchParams.get('name')??'';
    const content=store.get(name);
    if(content===undefined)return json(404,{error:'not found'});
    res.setHeader('content-type','text/plain').end(content);return;
  }
  res.writeHead(404).end();
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const target='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;
const finish=async(id:string)=>{const deadline=Date.now()+60000;while(Date.now()<deadline){const r=readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,50));}throw Error('upload assessment timed out');};
const uploadInput=[
  {id:'unrestrictedUpload',path:'/api/upload',field:'file',viewPath:'/files',benignNameRef:'benignName',benignContentRef:'benignContent',probeNameRef:'probeName',probeContentRef:'probeContent',markerRef:'uploadMarker'},
  {id:'guardedUpload',path:'/api/upload-safe',field:'file',viewPath:'/files',benignNameRef:'benignName',benignContentRef:'benignContent',probeNameRef:'probeName',probeContentRef:'probeContent',markerRef:'uploadMarker'},
  {id:'brokenEndpoint',path:'/api/upload-broken',field:'file',viewPath:'/files',benignNameRef:'benignName',benignContentRef:'benignContent',probeNameRef:'probeName',probeContentRef:'probeContent',markerRef:'uploadMarker'},
];
const input={target,authorized:true,checks:['server_banner'],profile:'campaign' as const,scope:{delayMs:0,maxRequests:200},browser:{postPaths:['/api/upload','/api/upload-safe','/api/upload-broken']},upload:uploadInput,businessSecrets:{benignName:'welcome.txt',benignContent:'plain benign fixture-upload-benign text',probeName:'loam-probe.html',probeContent:'inert probe fixture-upload-marker payload',uploadMarker:'fixture-upload-marker'}};
try{
  assert.throws(()=>startAssessment(root,{...input,profile:'quick' as any}),/campaign mode/);
  assert.throws(()=>startAssessment(root,{...input,upload:[{...uploadInput[0]!,path:'/api/unknown'}]}),/allowlisted in postPaths/);
  assert.throws(()=>startAssessment(root,{...input,upload:[{...uploadInput[0]!,viewPath:'/files?x=1'}]}),/exact view path/);
  assert.throws(()=>startAssessment(root,{...input,upload:[{...uploadInput[0]!,field:'bad field'}]}),/safe multipart field name/);
  assert.throws(()=>startAssessment(root,{...input,businessSecrets:{...input.businessSecrets,probeContent:'marker missing'}}),/must contain the declared marker/);
  assert.throws(()=>startAssessment(root,{...input,businessSecrets:{}}),/fresh (business )?input/);
  const first=await finish(startAssessment(root,input).id);
  assert.equal(first.status,'partial',JSON.stringify({proofs:first.upload?.proofs.map(p=>[p.caseId,p.outcome,p.summary]),findings:first.findings.map(f=>f.check+':'+f.verdict)}));
  assert.equal(first.completed,first.total,'progress accounting must include upload cases');
  const proofs=first.upload?.proofs??[];
  assert.equal(proofs.length,3,'three upload proofs');
  const unrestricted=proofs.find(p=>p.target.endsWith('/api/upload'))!,guarded=proofs.find(p=>p.target.endsWith('/api/upload-safe'))!,broken=proofs.find(p=>p.target.endsWith('/api/upload-broken'))!;
  assert.ok(unrestricted&&guarded&&broken,JSON.stringify(proofs.map(p=>p.target)));
  assert.equal(unrestricted.kind,'upload');
  assert.equal(unrestricted.outcome,'observed',JSON.stringify(unrestricted));
  assert.equal(unrestricted.observations.benignStatus,201);
  assert.equal(unrestricted.observations.probeStatus,201);
  assert.equal(unrestricted.observations.markerServed,true);
  assert.equal(guarded.outcome,'not_observed',JSON.stringify(guarded));
  assert.equal(guarded.observations.probeStatus,415);
  assert.equal(broken.outcome,'inconclusive');
  assert.match(String(broken.summary),/Positive control failed/);
  const finding=first.findings.find(f=>f.check.startsWith('upload_')&&f.verdict==='finding');
  assert.ok(finding,JSON.stringify(first.findings));
  assert.equal(finding.severity,'high');
  const uploadPosts=first.evidence.filter(e=>e.method==='POST'&&e.url.endsWith('/api/upload'));
  assert.equal(uploadPosts.length,2,'benign upload plus probe upload');
  assert.ok(uploadPosts.every(e=>e.postPolicy==='/api/upload'&&e.requestBytes!>0));
  const viewGets=first.evidence.filter(e=>e.method==='GET'&&e.url.endsWith('/files'));
  assert.equal(viewGets.length,1,'one retrieval witness');
  for(const secret of ['fixture-upload-benign text','fixture-upload-marker','loam-probe.html'])assert.ok(!JSON.stringify(first).includes(secret),'upload values must be redacted');
  const module=first.diagnostics?.modules.find(m=>m.id==='upload');
  assert.equal(module?.state,'incomplete');assert.equal(module?.planned,3);assert.equal(module?.conclusive,2);assert.equal(module?.inconclusive,1);
  assert.ok(first.covered.some(k=>k.includes('/api/upload')&&k.includes('upload_')));
  assert.throws(()=>retestAssessment(root,first.id,{authorized:true}),/fresh (business )?input/);
  fixed=true;store.clear();
  const second=await finish(retestAssessment(root,first.id,{authorized:true,businessSecrets:input.businessSecrets}).id);
  assert.ok(second.comparison?.notObserved.includes(finding.fingerprint),JSON.stringify(second.comparison));
  assert.equal(second.upload?.proofs.find(p=>p.target.endsWith('/api/upload'))?.outcome,'not_observed','an extension-allowlist repair must reject the probe');
  console.log('PASS upload: benign control accepted, disallowed-type probe accepted and served verbatim observed on the open endpoint, extension-allowlist guard rejecting it, broken endpoint inconclusive, multipart POST policy evidence, values redacted, diagnostics module and repaired retest');
}finally{server.closeAllConnections();server.close();}
