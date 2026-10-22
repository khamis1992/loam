import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {once} from 'node:events';
import {startAssessment,readAssessment,retestAssessment} from '../security/assessments.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-json-witness-'));
let mode='vulnerable';const marker='owned-synthetic-marker';
const server=http.createServer((req,res)=>{
  let id=req.headers.cookie?.match(/actor=(alice|bob)/)?.[1]??'anonymous';
  if(req.url?.startsWith('/as/')){id=req.url.slice(4);res.setHeader('set-cookie','actor='+id+'; Path=/; HttpOnly');}
  if(req.url==='/record'){
    res.setHeader('content-type','application/json');
    if(id==='bob'){
      if(mode==='fixed'){res.writeHead(403).end('{}');return;}
      if(mode==='echo'){res.end(JSON.stringify({error:'request echoed '+marker}));return;}
      if(mode==='malformed'){res.end(marker);return;}
      if(mode==='substring'){res.end(JSON.stringify({records:[{'a/b':{'~id':'prefix-'+marker}}]}));return;}
      if(mode==='missing'){res.end('{}');return;}
      if(mode==='denial-leak')res.statusCode=403;
    }
    res.end(JSON.stringify({records:[{'a/b':{'~id':marker}}]}));return;
  }
  res.setHeader('content-type','text/html');res.end('<div data-id>'+id+'</div>');
});server.listen(0,'127.0.0.1');await once(server,'listening');
const target='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;
const authorization=[{id:'record',kind:'api',path:'/record',markerRef:'record',markerPath:'/records/0/a~1b/~0id',allowed:['alice'],denied:['bob']}];
const browser={enabled:true,screenshots:false,maxPages:1,settleMs:250,readySelector:'[data-id]',accounts:['alice','bob'].map(id=>({id,login:[{action:'navigate',path:'/as/'+id},{action:'assertVisible',selector:'[data-id]'}],witness:{path:'/identity',selector:'[data-id]',textRef:id}})),authorization};
const browserSecrets={alice:'alice',bob:'bob',record:marker};
const input={target,authorized:true,checks:['server_banner'],scope:{delayMs:0},browser,browserSecrets};
async function finish(id:string){for(let n=0;n<600;n++){const r=readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout');}
try{
  for(const markerPath of ['records','/bad~2','/bad~',9])assert.throws(()=>startAssessment(root,{...input,browser:{...browser,authorization:[{...authorization[0],markerPath}]}}),/JSON Pointer/);
  const first=await finish(startAssessment(root,input).id);
  const finding=first.findings.find(f=>f.check.startsWith('authorization_'));assert.ok(finding,JSON.stringify(first.browser));
  assert.ok(!JSON.stringify(first).includes(marker));
  const proof=first.browser!.proofs.find(p=>p.kind==='authorization'&&p.observations.account==='bob')!;
  assert.equal(proof.observations.witnessMode,'json_pointer_exact');assert.equal(proof.observations.markerPath,authorization[0]!.markerPath);
  for(const failure of ['echo','malformed','substring','missing']){
    mode=failure;const checked=await finish(retestAssessment(root,first.id,{authorized:true,browserSecrets}).id);
    assert.equal(checked.status,'partial',failure);assert.ok(!checked.findings.some(f=>f.check.startsWith('authorization_')),failure);
    assert.ok(checked.comparison!.unverified.includes(finding.fingerprint),failure);
    assert.equal(checked.browserOptions.authorization[0]!.markerPath,authorization[0]!.markerPath);
  }
  mode='denial-leak';const leaked=await finish(retestAssessment(root,first.id,{authorized:true,browserSecrets}).id);
  assert.ok(leaked.comparison!.persistent.includes(finding.fingerprint));assert.equal(leaked.comparison!.notObserved.length,0);
  mode='fixed';const fixed=await finish(retestAssessment(root,first.id,{authorized:true,browserSecrets}).id);
  assert.ok(fixed.comparison!.notObserved.includes(finding.fingerprint));
  mode='vulnerable';const legacy=await finish(startAssessment(root,{...input,browser:{...browser,authorization:authorization.map(({markerPath,...c})=>c)}}).id);
  const legacyFinding=legacy.findings.find(f=>f.check.startsWith('authorization_'))!;assert.ok(legacyFinding);
  mode='denial-leak';const ambiguous=await finish(retestAssessment(root,legacy.id,{authorized:true,browserSecrets}).id);
  assert.ok(ambiguous.comparison!.unverified.includes(legacyFinding.fingerprint));assert.equal(ambiguous.comparison!.notObserved.length,0);
  console.log('PASS: nested array/escaped JSON pointer, exact marker, echo/malformed/substring/missing inconclusive, 403 data leak remains persistent, legacy denial echo inconclusive, explicit denial, secret omission and retest preservation');
}finally{server.closeAllConnections();server.close();}
