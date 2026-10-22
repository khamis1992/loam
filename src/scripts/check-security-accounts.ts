import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {once} from 'node:events';
import {startAssessment,readAssessment,retestAssessment} from '../security/assessments.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-accounts-'));
let mode='vulnerable';const traffic:{url:string;user:string}[]=[];
const server=http.createServer(async(req,res)=>{
  const user=req.headers.cookie?.match(/sid=(alice|bob)/)?.[1]??'';traffic.push({url:req.url!,user});res.setHeader('content-type','text/html');
  if(req.url==='/login'&&req.method==='POST'){let body='';for await(const x of req)body+=x;const p=new URLSearchParams(body);const id=p.get('username');if(!['alice','bob'].includes(id!))return res.writeHead(401).end();res.writeHead(303,{'set-cookie':`sid=${id}; Path=/; HttpOnly`,location:'/who'}).end();return;}
  if(req.url==='/who'){res.end(user?`<div data-ready data-identity>${user}</div>`:'<div data-ready data-denied>login</div>');return;}
  if(req.url==='/api/document'){
    if(req.method==='POST'){let body='';for await(const chunk of req)body+=chunk;if(body!==JSON.stringify({id:'fixture-a'})){res.writeHead(400).end();return;}}

    if(mode==='outage'){res.writeHead(503).end('unavailable');return;}
    if(mode==='expired')res.setHeader('set-cookie','sid=; Path=/; Max-Age=0');
    if(user==='alice'||(user==='bob'&&mode!=='fixed')){res.setHeader('content-type','application/json');res.end('{"record":"alice-owned-test-record"}');return;}
    res.writeHead(403).end('denied');return;
  }
  if(req.url==='/document'){res.end(`<main data-ready></main><script>fetch('/api/document').then(async r=>{const t=await r.text();document.querySelector('main').innerHTML=r.ok?'<section data-private>'+t+'</section>':'<section data-denied>denied</section>';});</script>`);return;}
  res.end('<div data-ready><form action="/login" method="post"><input name="username" id="username"><input name="password" id="password" type="password"><button>Login</button></form></div>');
});server.listen(0,'127.0.0.1');await once(server,'listening');const target='http://127.0.0.1:'+(server.address() as any).port;
const login=(id:string)=>[{action:'navigate',path:'/'},{action:'fill',selector:'#username',secretRef:id+'User'},{action:'fill',selector:'#password',secretRef:id+'Pass'},{action:'click',selector:'button'},{action:'assertVisible',selector:'[data-identity]'}];
const browser={enabled:true,screenshots:true,readySelector:'[data-ready]',settleMs:250,maxPages:1,followRedirects:true,postPaths:['/login'],accounts:['alice','bob'].map(id=>({id,login:login(id),witness:{path:'/who',selector:'[data-identity]',textRef:id+'User'}})),authorization:[{id:'record_api',kind:'api',path:'/api/document',markerRef:'record',allowed:['alice'],denied:['bob']},{id:'record_ui',kind:'ui',path:'/document',selector:'[data-private]',deniedSelector:'[data-denied]',allowed:['alice'],denied:['bob']}]};
const browserSecrets={aliceUser:'alice',bobUser:'bob',alicePass:'alice-secret-password',bobPass:'bob-secret-password',record:'alice-owned-test-record'};
const input={target,authorized:true,checks:['server_banner'],scope:{delayMs:0,maxRequests:200,timeoutSeconds:120},browser,browserSecrets};
async function finish(id:string){for(let i=0;i<900;i++){const r=readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out');}
try{
  assert.throws(()=>startAssessment(root,{...input,browserSecrets:{...browserSecrets,bobUser:'alice'}}),/distinct expected identity/);
  assert.throws(()=>startAssessment(root,{...input,browser:{...browser,authorization:[{...browser.authorization[0],denied:['alice']}]}}),/overlap/);
  const first=await finish(startAssessment(root,input).id);assert.equal(first.status,'completed',JSON.stringify(first.browser));
  const findings=first.findings.filter(f=>f.check.startsWith('authorization_'));assert.equal(findings.length,2,JSON.stringify(first.browser));
  assert.equal(first.diagnostics?.authorizationCoverage.conclusive,4);
  assert.equal(first.browser?.proofs.filter(p=>p.kind==='session'&&p.outcome==='observed').length,2);
  assert.ok(first.evidence.some(e=>e.accountId==='alice'));assert.ok(first.evidence.some(e=>e.accountId==='bob'));
  for(const secret of [browserSecrets.alicePass,browserSecrets.bobPass,browserSecrets.record])assert.ok(!JSON.stringify(first).includes(secret));
  mode='fixed';const fixed=await finish(retestAssessment(root,first.id,{authorized:true,browserSecrets}).id);assert.equal(fixed.status,'completed',JSON.stringify(fixed.browser));
  for(const f of findings)assert.ok(fixed.comparison?.notObserved.includes(f.fingerprint),JSON.stringify(fixed.browser));
  mode='outage';const outage=await finish(retestAssessment(root,first.id,{authorized:true,browserSecrets}).id);assert.equal(outage.status,'partial');for(const f of findings)assert.ok(outage.comparison?.unverified.includes(f.fingerprint));
  mode='expired';const expired=await finish(retestAssessment(root,first.id,{authorized:true,browserSecrets}).id);assert.equal(expired.status,'partial');for(const f of findings)assert.ok(expired.comparison?.unverified.includes(f.fingerprint));
  assert.throws(()=>retestAssessment(root,first.id,{authorized:true}),/fresh browser input/);
  assert.throws(()=>retestAssessment(root,first.id,{authorized:true,browserSecrets:{...browserSecrets,record:'different-test-record'}}),/preserve expected account identities/);
  mode='vulnerable';
  const postSecrets={...browserSecrets,query:JSON.stringify({id:'fixture-a'})};
  const postInput={...input,browserSecrets:postSecrets,browser:{...browser,screenshots:false,postPaths:['/login','/api/document'],authorization:[{...browser.authorization[0],method:'POST',bodyRef:'query'}]}};
  assert.throws(()=>startAssessment(root,{...postInput,browser:{...postInput.browser,postPaths:['/login']}}),/exact allowed path/);
  assert.throws(()=>startAssessment(root,{...postInput,browserSecrets:{...postSecrets,query:'not json'}}),/valid JSON/);
  assert.throws(()=>startAssessment(root,{...postInput,browserSecrets:{...postSecrets,query:'x'.repeat(8193)}}),/8192/);
  const posted=await finish(startAssessment(root,postInput).id),postFinding=posted.findings.find(f=>f.check.startsWith('authorization_'));assert.ok(postFinding,JSON.stringify(posted.browser));
  assert.equal(posted.evidence.filter(e=>e.method==='POST'&&e.url.endsWith('/api/document')).length,2);assert.ok(!JSON.stringify(posted).includes('fixture-a'));
  for(const state of ['fixed','outage','expired']){mode=state;const checked=await finish(retestAssessment(root,posted.id,{authorized:true,browserSecrets:postSecrets}).id);assert.ok((state==='fixed'?checked.comparison?.notObserved:checked.comparison?.unverified)?.includes(postFinding.fingerprint));}
  console.log('PASS: explicit POST JSON authorization, invalid body/allowlist rejection, fixed/outage/expired POST retests, two isolated identities, API/UI authorization controls, per-account evidence, secret redaction, fixed/outage/expired-session retests and coverage');
}finally{server.closeAllConnections();server.close();}
