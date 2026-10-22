import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {startAssessment,readAssessment,retestAssessment} from '../security/assessments.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-security-flows-'));
let fixed=false, unavailable=false, deniedWrites=0, queries=0, loginCount=0, outsideHits=0;
const external=http.createServer((_req,res)=>{outsideHits++;res.end('outside');});external.listen(0,'127.0.0.1');await once(external,'listening');
const externalUrl='http://127.0.0.1:'+(external.address() as any).port;
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url!,'http://localhost');res.setHeader('content-type','text/html');
  const logged=!!req.headers.cookie?.includes('session=issued-private-cookie');
  if(url.pathname==='/api/login'&&req.method==='POST'){
    let body='';for await(const part of req)body+=part;
    assert.match(body,/test-password/);loginCount++;
    res.writeHead(303,{'set-cookie':['session=issued-private-cookie; Path=/; HttpOnly','other=value; Path=/'],'location':'/app'}).end();return;
  }
  if(url.pathname==='/api/query'&&req.method==='POST'){
    queries++;let body='';for await(const part of req)body+=part;assert.equal(JSON.parse(body).query,'fixture');
    assert.equal(req.headers['x-csrf-token'],'csrf-fixture');assert.equal(req.headers.authorization,'Bearer issued-private-token');
    res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:logged}));return;
  }
  if(req.method==='POST'){deniedWrites++;res.end('unexpected');return;}
  if(url.pathname==='/login'||url.pathname==='/'){
    res.end('<form method="post" action="/api/login"><input id="username" name="username"><input id="password" name="password" type="password"><button type="submit">Login</button></form>');return;
  }
  if(url.pathname==='/app'){
    if(!logged){res.end('<div data-denied>Sign in</div>');return;}
    if(unavailable){res.writeHead(503).end('unavailable');return;}
    res.end(`<div data-account>Account</div><button id="load">Query API</button><main id="result"></main><script>
      localStorage.setItem('token','issued-private-token');sessionStorage.setItem('csrf','csrf-fixture');
      document.getElementById('load').onclick=async()=>{const r=await fetch('/api/query',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+localStorage.token,'x-csrf-token':sessionStorage.csrf},body:JSON.stringify({query:'fixture'})});await r.json();document.getElementById('result').innerHTML='<section data-result>Result</section>${fixed?'':'<form method="get"><input type="password"></form>'}';history.pushState(null,'','/app#/results');};
      </script>`);return;
  }
  if(url.pathname==='/blocked'){res.end(`<div data-ready>Ready</div><script>fetch('/api/write',{method:'POST'}).catch(()=>{});fetch('/api/query/child',{method:'POST'}).catch(()=>{});fetch('/api/query',{method:'POST',body:'x'.repeat(65537)}).catch(()=>{});fetch('/escape').catch(()=>{});</script>`);return;}
  if(url.pathname==='/escape'){res.writeHead(302,{location:externalUrl}).end();return;}
  res.writeHead(404).end();
});server.listen(0,'127.0.0.1');await once(server,'listening');
const target='http://127.0.0.1:'+(server.address() as any).port;
const finish=async(id:string)=>{const deadline=Date.now()+60000;while(Date.now()<deadline){const r=readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,100));}throw Error('flow timed out');};
const browser={enabled:true,screenshots:false,maxPages:1,settleMs:250,followRedirects:true,postPaths:['/api/login','/api/query'],login:[{action:'navigate',path:'/login'},{action:'fill',selector:'#username',secretRef:'username'},{action:'fill',selector:'#password',secretRef:'password'},{action:'click',selector:'button'},{action:'assertVisible',selector:'[data-account]'}],flows:[{name:'Query account',steps:[{action:'navigate',path:'/app#/start'},{action:'click',selector:'#load'},{action:'assertVisible',selector:'[data-result]'}]}],accessAssertions:[{path:'/app',selector:'[data-account]',deniedSelector:'[data-denied]'}]};
const input={target,authorized:true,checks:['server_banner'],scope:{delayMs:0,maxRequests:100},browser,browserSecrets:{username:'test-user',password:'test-password'}};
try{
  assert.throws(()=>startAssessment(root,{...input,browserSecrets:{}}),/fresh browser input/);
  assert.throws(()=>startAssessment(root,{...input,browser:{...browser,postPaths:['/api/query?x=1']}}),/POST allowlist/);
  const first=await finish(startAssessment(root,input).id);
  assert.equal(first.status,'completed',JSON.stringify(first.browser));
  assert.ok(first.browser?.proofs.some(p=>p.kind==='login'&&p.outcome==='observed'));
  assert.ok(first.browser?.proofs.some(p=>p.kind==='flow'&&p.outcome==='observed'));
  const finding=first.findings.find(f=>f.check.startsWith('flow_')&&f.check.endsWith('credential_form'));assert.ok(finding,JSON.stringify(first));
  assert.ok(first.evidence.some(e=>e.method==='POST'&&e.status===303));assert.ok(queries>0);assert.ok(loginCount>0);
  assert.ok(first.evidence.filter(e=>e.method==='POST').every(e=>e.postPolicy&&e.requestBytes!>0));
  for(const secret of ['test-password','issued-private-cookie','issued-private-token','csrf-fixture'])assert.ok(!JSON.stringify(first).includes(secret));
  assert.throws(()=>retestAssessment(root,first.id,{authorized:true}),/fresh browser input/);
  fixed=true;
  const second=await finish(retestAssessment(root,first.id,{authorized:true,browserSecrets:input.browserSecrets}).id);
  assert.ok(second.comparison?.notObserved.includes(finding.fingerprint),JSON.stringify(second));
  unavailable=true;
  const failed=await finish(retestAssessment(root,first.id,{authorized:true,browserSecrets:input.browserSecrets}).id);
  assert.equal(failed.status,'partial');assert.ok(failed.comparison?.unverified.includes(finding.fingerprint));unavailable=false;
  const blocked=await finish(startAssessment(root,{...input,browser:{...browser,login:[],accessAssertions:[],flows:[{name:'Blocked paths',steps:[{action:'navigate',path:'/blocked'},{action:'assertVisible',selector:'[data-ready]'}]}]}}).id);
  assert.equal(blocked.status,'partial');assert.equal(deniedWrites,0);assert.equal(outsideHits,0);
  console.log('PASS: native POST login, multiple cookies, scoped redirect, isolated SPA flow, JSON POST API with token/CSRF, session separation, redaction, fixed/unavailable retests, denied POST and external redirects');
}finally{server.closeAllConnections();server.close();external.closeAllConnections();external.close();}
