import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startAssessment,readAssessment,retestAssessment} from '../security/assessments.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-route-evidence-'));
let redirect=true;
const server=http.createServer((req,res)=>{
  res.setHeader('content-type','text/html');
  if(req.url==='/http-protected'){res.writeHead(302,{location:'/login?token=private-query#private-fragment'}).end();return;}
  res.end('<div id="ready">Test application</div>'+(redirect&&req.url==='/protected'?'<script>history.replaceState({},"","/login?token=private-query#private-fragment")</script>':''));
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const origin='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;
async function finish(id:string){for(let n=0;n<600;n++){const r=readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout');}
const input={target:origin+'/protected',authorized:true,profile:'quick',checks:['server_banner'],scope:{seeds:[origin],delayMs:0},browser:{enabled:true,maxPages:1,screenshots:false,readySelector:'#ready',settleMs:250,followRedirects:true}};
try{
  const moved=await finish(startAssessment(root,input).id);
  const proof=moved.browser!.proofs.find(p=>p.kind==='render')!;
  assert.equal(proof.outcome,'inconclusive');assert.equal(proof.observations.finalUrl,origin+'/login');
  assert.equal(proof.observations.routeChanged,true);assert.equal(proof.observations.documentComplete,true);
  assert.equal(moved.browser!.pages[0]!.complete,false);
  assert.ok(!moved.covered.some(k=>k.includes('browser_')),'Login DOM cannot establish protected-route coverage');
  assert.ok(!JSON.stringify(moved).includes('private-query'));assert.ok(!JSON.stringify(moved).includes('private-fragment'));
  redirect=false;
  const reached=await finish(retestAssessment(root,moved.id,{authorized:true}).id);
  const actual=reached.browser!.proofs.find(p=>p.kind==='render')!;
  assert.equal(actual.outcome,'observed');assert.equal(actual.observations.finalUrl,origin+'/protected');assert.equal(actual.observations.routeChanged,false);
  assert.ok(reached.covered.some(k=>k.includes('browser_')));
  const httpRedirect=await finish(startAssessment(root,{...input,target:origin+'/http-protected'}).id);
  assert.equal(httpRedirect.browser!.proofs.find(p=>p.kind==='render')!.observations.finalUrl,origin+'/login');
  assert.equal(httpRedirect.browser!.pages[0]!.complete,false);
  console.log('PASS: SPA and HTTP redirects cannot certify original route; final URL strips secrets; same-route retest restores coverage');
}finally{server.closeAllConnections();server.close();}
