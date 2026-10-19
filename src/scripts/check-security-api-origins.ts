import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {normalizeApiGrants,matchApiGrant,apiRequestHeaders} from '../security/api-grants.js';
import {startAssessment,readAssessment,retestAssessment} from '../security/assessments.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-api-origins-'));
let origin='',blockedHits=0;
const hits:Array<{method:string;url:string;authorization?:string;apikey?:string;cookie?:string}>=[];
const api=http.createServer((req,res)=>{
  hits.push({method:req.method!,url:req.url!,authorization:req.headers.authorization,apikey:req.headers.apikey as string|undefined,cookie:req.headers.cookie});
  res.setHeader('access-control-allow-origin',origin);
  res.setHeader('access-control-allow-headers','authorization,apikey,content-type');
  res.setHeader('access-control-allow-methods','GET,POST,OPTIONS');
  if(req.method==='OPTIONS'){res.writeHead(204).end();return;}
  if(req.url==='/token'){res.setHeader('content-type','application/json');res.end('{"token":"api-session-fixture"}');return;}
  if(req.url==='/record'){res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:req.headers.authorization==='Bearer api-session-fixture'}));return;}
  if(req.url==='/redirect'){res.writeHead(302,{location:origin+'/leak'}).end();return;}
  if(req.url==='/public'){res.end('{}');return;}
  blockedHits++;res.end('{}');
});
api.listen(0,'127.0.0.1');await once(api,'listening');
const apiOrigin='http://127.0.0.1:'+(api.address() as import('node:net').AddressInfo).port;
const frontend=http.createServer((req,res)=>{
  if(req.url==='/leak'){blockedHits++;res.end('leak');return;}
  res.setHeader('content-type','text/html');
  res.end(`<html><div id="ready"></div><script>(async()=>{const a=${JSON.stringify(apiOrigin)};const t=await fetch(a+'/token',{method:'POST',headers:{'content-type':'application/json','apikey':'public-test-key'},body:'{}'}).then(r=>r.json());const r=await fetch(a+'/record',{headers:{authorization:'Bearer '+t.token,apikey:'public-test-key'}}).then(r=>r.json());if(r.ok)document.getElementById('ready').dataset.ok='yes';await fetch(a+'/public',{headers:{authorization:'Bearer '+t.token}}).catch(()=>{});await fetch(a+'/unapproved').catch(()=>{});await fetch(a+'/record',{method:'DELETE'}).catch(()=>{});await fetch(a+'/redirect').catch(()=>{});})()</script></html>`);
});
frontend.listen(0,'127.0.0.1');await once(frontend,'listening');origin='http://127.0.0.1:'+(frontend.address() as import('node:net').AddressInfo).port;
const grant={origin:apiOrigin,paths:['/token','/record','/redirect'],methods:['GET','POST'],credentialHeaders:['authorization','apikey']};
async function finish(id:string){for(let i=0;i<600;i++){const r=readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,100));}throw Error('API integration timeout');}
try{
  const grants=normalizeApiGrants([grant],origin);
  assert.equal(matchApiGrant(grants,apiOrigin+'/record','GET','document'),undefined);
  assert.equal(matchApiGrant(grants,apiOrigin+'/record','DELETE','fetch'),undefined);
  assert.equal(matchApiGrant(grants,apiOrigin+'/record/child','GET','fetch'),undefined);
  assert.equal(matchApiGrant(grants,apiOrigin+'/record','OPTIONS','other','DELETE'),undefined);
  assert.throws(()=>normalizeApiGrants([{...grant,origin:apiOrigin+'/path'}],origin));
  assert.throws(()=>normalizeApiGrants([{...grant,paths:['/a/../record']}],origin));
  assert.deepEqual(apiRequestHeaders({authorization:'secret',cookie:'private',origin}, {...grants[0]!,credentialHeaders:[]}),{origin});
  const input={target:origin,authorized:true,profile:'quick',checks:['server_banner'],scope:{delayMs:0},auth:{bearer:'frontend-only-secret',cookie:'frontend=private'},browser:{enabled:true,screenshots:false,maxPages:1,settleMs:250,readySelector:'#ready[data-ok="yes"]',apiGrants:[grant]}};
  const run=await finish(startAssessment(root,input).id);
  assert.ok(run.browser?.version);
  assert.ok(hits.some(h=>h.url==='/token'&&h.method==='POST'&&h.apikey==='public-test-key'));
  assert.ok(hits.some(h=>h.url==='/record'&&h.authorization==='Bearer api-session-fixture'));
  assert.ok(hits.every(h=>h.authorization!=='Bearer frontend-only-secret'&&!h.cookie),'Frontend credentials must not reach API, even on same hostname/different port');
  assert.equal(blockedHits,0);
  assert.equal(run.status,'partial');
  assert.ok(run.browser!.blocked.some(b=>b.reason==='Redirect not followed'));
  assert.ok(run.evidence.some(e=>e.url===apiOrigin+'/record'&&e.status===200));
  assert.ok(!JSON.stringify(run).includes('api-session-fixture'));
  const again=await finish(retestAssessment(root,run.id,{authorized:true,auth:input.auth}).id);
  assert.deepEqual(again.browserOptions.apiGrants,run.browserOptions.apiGrants);
  const offset=hits.length;
  await finish(startAssessment(root,{...input,browser:{...input.browser,readySelector:'#ready',apiGrants:[{...grant,credentialHeaders:[]}]}}).id);
  assert.ok(hits.slice(offset).some(h=>h.url==='/record'));
  assert.ok(hits.slice(offset).every(h=>!h.authorization&&!h.apikey&&!h.cookie),'Application credentials require an explicit header grant');
  console.log('PASS: real cross-origin JSON POST/token/GET, application credentials, frontend credential isolation, exact paths/methods, navigation/redirect denial, redaction and preserved retest grants');
}finally{api.closeAllConnections();api.close();frontend.closeAllConnections();frontend.close();}
