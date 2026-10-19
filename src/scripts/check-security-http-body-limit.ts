import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {safeGet,runPentestCheck} from '../tools/pentest.js';
import {startAssessment,readAssessment,retestAssessment} from '../security/assessments.js';
let mode:'vulnerable'|'oversized'|'fixed'='vulnerable';
const form='<form method="get"><input type="password"></form>';
const seenMethods:string[]=[];
const server=http.createServer((req,res)=>{
  res.setHeader('content-type','text/html');
  if(req.url==='/headers'){
    seenMethods.push(req.method!);res.setHeader('set-cookie','session=fixture');res.setHeader('server','fixture-server');
    res.setHeader('access-control-allow-origin',req.headers.origin??'*');res.setHeader('access-control-allow-credentials','true');res.setHeader('allow','GET, TRACE');
    res.end('a'.repeat(32769));return;
  }
  if(req.url==='/headers-stream'){res.flushHeaders();return;}
  if(req.url==='/redirect'){res.writeHead(302,{location:'/headers'}).end();return;}
  if(req.url==='/private'){
    if(mode==='oversized'&&!req.headers.authorization){res.writeHead(403).end('a'.repeat(32768)+'private record');return;}
    res.end('private record');return;
  }
  if(req.url?.startsWith('/files/')){res.writeHead(403).end('a'.repeat(32769));return;}
  const size=Number(req.url?.slice(1));
  if(size){res.end('a'.repeat(size));return;}
  if(req.url==='/chunked'){res.write('a'.repeat(32768));setImmediate(()=>res.end('x'));return;}
  if(req.url==='/utf8'){res.end('é'.repeat(16385));return;}
  if(req.url==='/gzip'){res.setHeader('content-encoding','gzip');res.end(gzipSync('a'.repeat(32769)));return;}
  res.end(mode==='vulnerable'?form:mode==='oversized'?'a'.repeat(32768)+form:'<html>fixed</html>');
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-http-limit-'));
async function finish(id:string){for(let n=0;n<400;n++){const run=readAssessment(root,id);if(run.status!=='running')return run;await new Promise(r=>setTimeout(r,20));}throw Error('Assessment timeout');}
try{
  for(const size of [32767,32768,32769]){const r=await safeGet(base+'/'+size);assert.equal(r.ok,size<=32768);assert.equal(r.bodyTruncated,size>32768);assert.equal(Buffer.byteLength(r.body),Math.min(size,32768));assert.equal(r.status,200);}
  for(const route of ['/chunked','/utf8','/gzip']){const r=await safeGet(base+route);assert.equal(r.ok,false);assert.equal(r.bodyTruncated,true);assert.match(r.error!,/incomplete response/);}
  const head=await safeGet(base+'/32769',{method:'HEAD'});assert.equal(head.ok,true);assert.equal(head.bodyTruncated,false);assert.equal(head.body,'');
  const streamed=await safeGet(base+'/headers-stream',{headersOnly:true,timeoutMs:1000});assert.equal(streamed.ok,true);assert.equal(streamed.bodyOmitted,true);
  assert.equal((await safeGet(base+'/redirect',{headersOnly:true})).ok,false);
  for(const check of ['security_headers','cookie_flags','server_banner','cors_policy','http_methods']){
    const findings=await runPentestCheck(base+'/headers',check);assert.ok(findings.length);assert.ok(!findings.some(f=>f.verdict==='error'),check);
    assert.ok(findings.some(f=>f.verdict===(check==='server_banner'?'info':'finding')),check);
  }
  assert.deepEqual(seenMethods,['GET','GET','GET','GET','OPTIONS'],'Header evaluation preserves actual GET/OPTIONS semantics rather than substituting HEAD');
  const headerRun=await finish(startAssessment(root,{target:base+'/headers',authorized:true,checks:['security_headers'],scope:{delayMs:0}}).id);
  assert.equal(headerRun.status,'completed');assert.equal(headerRun.evidence[0]!.bodyOmitted,true);assert.equal(headerRun.evidence[0]!.bodyHash,'');
  assert.equal(headerRun.evidence[0]!.bytes,0);
  const first=await finish(startAssessment(root,{target:base+'/',authorized:true,profile:'campaign',checks:['security_headers'],scope:{delayMs:0,maxPages:1}}).id);
  const finding=first.findings.find(f=>f.check==='credential_form')!;assert.ok(finding);
  mode='oversized';const partial=await finish(retestAssessment(root,first.id,{authorized:true}).id);
  assert.equal(partial.status,'partial');assert.ok(partial.evidence.some(e=>e.bodyTruncated));
  assert.ok(partial.covered.some(key=>key.endsWith('\nsecurity_headers')));
  assert.ok(!partial.covered.some(key=>key.endsWith('\ncredential_form')),'Header coverage must not clear an unexamined body finding');
  assert.ok(partial.comparison!.unverified.includes(finding.fingerprint));assert.ok(!partial.comparison!.notObserved.includes(finding.fingerprint));
  mode='fixed';const fixed=await finish(retestAssessment(root,first.id,{authorized:true}).id);
  assert.equal(fixed.status,'completed');assert.ok(fixed.comparison!.notObserved.includes(finding.fingerprint));
  mode='vulnerable';const auth={bearer:'test-session'};
  const protectedRun=await finish(startAssessment(root,{target:base+'/',authorized:true,checks:['security_headers'],auth,protectedPaths:['/private'],scope:{delayMs:0}}).id);
  const access=protectedRun.findings.find(f=>f.check==='access_review'&&f.verdict==='finding')!;assert.ok(access);
  mode='oversized';const denied=await finish(retestAssessment(root,protectedRun.id,{authorized:true,auth}).id);
  assert.ok(denied.comparison!.unverified.includes(access.fingerprint),'Truncated 403 cannot prove protected content is absent');
  const probes=await runPentestCheck(base+'/files','exposed_files');
  assert.ok(probes.some(f=>f.verdict==='error'));assert.ok(!probes.some(f=>f.verdict==='pass'));
  console.log('PASS HTTP body limit: exact byte boundary, chunked/UTF-8 overflow, evidence, partial campaign and unverified versus covered retest');
}finally{server.closeAllConnections();server.close();fs.rmSync(root,{recursive:true,force:true});}
