import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {once} from 'node:events';
import {startAssessment,readAssessment,retestAssessment,type Assessment,type AssessmentInput} from '../security/assessments.js';
import {corsPreflightAllowed,corsResponseAllowed,corsUnsafeHeaders} from '../security/cors.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-cross-accounts-'));
let mode='vulnerable',frontend='',postOnly=false;const revoked=new Set<string>(),seen:Array<{user:string;path:string;method:string;cookie?:string;authorization?:string}>=[];
const api=http.createServer(async(req,res)=>{
  res.setHeader('access-control-allow-origin',frontend);res.setHeader('access-control-allow-credentials','true');res.setHeader('access-control-allow-headers','authorization, content-type');res.setHeader('content-type','application/json');
  if(req.url==='/record'){
    if(mode==='cors-missing'&&req.method!=='OPTIONS')res.removeHeader('access-control-allow-origin');
    if(mode==='credentials-missing'&&req.method!=='OPTIONS')res.removeHeader('access-control-allow-credentials');
    if(mode==='origin-wildcard')res.setHeader('access-control-allow-origin','*');
    if(mode==='headers-wildcard')res.setHeader('access-control-allow-headers','*');
    if(mode==='preflight-denied')res.setHeader('access-control-allow-headers','content-type');
    if(mode==='preflight-credentials'&&req.method==='OPTIONS')res.removeHeader('access-control-allow-credentials');
    if(mode==='json-header-denied')res.setHeader('access-control-allow-headers','authorization');
  }
  if(req.method==='OPTIONS')seen.push({user:'',path:req.url!,method:'OPTIONS',cookie:req.headers.cookie,authorization:req.headers.authorization});
  if(req.method==='OPTIONS'){res.writeHead(204).end();return;}
  const token=req.headers.authorization??'',user=token==='Bearer token-a'?'alice':token==='Bearer token-b'?'bob':'';seen.push({user,path:req.url!,method:req.method!});
  if(!user||revoked.has(user)){res.writeHead(401).end('{}');return;}
  if(req.url==='/who'){res.end(JSON.stringify({id:mode==='wrong-identity'?'someone-else':user}));return;}
  if(req.url==='/record'){
    if(postOnly){if(req.method!=='POST'){res.writeHead(405).end('{}');return;}let body='';for await(const chunk of req)body+=chunk;if(body!==JSON.stringify({id:'fixture-a'})){res.writeHead(400).end('{}');return;}}

    if(mode==='outage'){res.writeHead(503).end('{}');return;}
    if(mode==='expired')revoked.add(user);
    if(user==='bob'&&mode==='fixed'){res.writeHead(403).end('{}');return;}
    res.end('{"data":"alice-only-synthetic-record"}');return;
  }
  res.writeHead(404).end('{}');
});api.listen(0,'127.0.0.1');await once(api,'listening');const apiOrigin='http://127.0.0.1:'+(api.address() as import('node:net').AddressInfo).port;
const app=http.createServer((req,res)=>{res.setHeader('content-type','text/html');let id=req.headers.cookie?.match(/actor=(alice|bob)/)?.[1];if(req.url?.startsWith('/as/')){id=req.url.slice(4);res.setHeader('set-cookie','actor='+id+'; Path=/; HttpOnly');}res.end('<div data-ready data-identity>'+(id??'anonymous')+'</div>');});
app.listen(0,'127.0.0.1');await once(app,'listening');frontend='http://127.0.0.1:'+(app.address() as import('node:net').AddressInfo).port;
const browser={enabled:true,screenshots:false,maxPages:1,settleMs:250,readySelector:'[data-ready]',apiGrants:[{origin:apiOrigin,paths:['/who','/record'],methods:['GET'],credentialHeaders:['authorization']}],accounts:['alice','bob'].map(id=>({id,login:[{action:'navigate',path:'/as/'+id},{action:'assertVisible',selector:'[data-identity]'}],witness:{path:'/who',selector:'[data-identity]',textRef:id},apiCredentials:[{origin:apiOrigin,headers:{authorization:id+'Token'},identityRef:id+'ApiIdentity'}]})),authorization:[{id:'remote_record',kind:'api',path:'/record',api:{origin:apiOrigin,identityPath:'/who',identityField:'id'},markerRef:'marker',markerPath:'/data',allowed:['alice'],denied:['bob']}]};
const browserSecrets={alice:'alice',bob:'bob',aliceApiIdentity:'alice',bobApiIdentity:'bob',aliceToken:'Bearer token-a',bobToken:'Bearer token-b',marker:'alice-only-synthetic-record'};
const input={target:frontend,authorized:true,checks:['server_banner'],scope:{delayMs:0,maxRequests:200},browser,browserSecrets};
const base=process.env.LOAM_SECURITY_TEST_BASE;let taskId='';
if(base&&!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw Error('Installed test requires loopback');
async function post(route:string,body:unknown){const r=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json() as Promise<any>;}
async function launch(value:AssessmentInput,id?:string):Promise<Assessment>{if(!base)return id?retestAssessment(root,id,value):startAssessment(root,value);return (await post('/api/security/assessments'+(id?'/'+id+'/retest':'')+'?taskId='+taskId,value)).run;}
async function finish(id:string){for(let i=0;i<900;i++){const r:Assessment=base?(await(await fetch(base+'/api/security/assessments/'+id+'?taskId='+taskId)).json() as any).run:readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout');}
try{
  if(base)taskId=(await post('/api/tasks/draft',{mode:'build',title:'Cross-origin CORS account regression'})).task.id;
  const wildcard=new Headers({'access-control-allow-origin':'*','access-control-allow-headers':'*'});
  assert.equal(corsResponseAllowed(wildcard,frontend,true),false);
  assert.equal(corsPreflightAllowed(wildcard,frontend,false,'GET',['authorization']),false);
  assert.equal(corsPreflightAllowed(wildcard,frontend,false,'GET',['apikey']),true);
  assert.deepEqual(corsUnsafeHeaders({'content-type':'application/json',origin:frontend,cookie:'a=b',authorization:'Bearer fixture'}),['authorization','content-type']);
  assert.throws(()=>startAssessment(root,{...input,browser:{...browser,apiGrants:[]}}),/granted/);
  assert.throws(()=>startAssessment(root,{...input,browserSecrets:{...browserSecrets,bobApiIdentity:'alice'}}),/distinct/);
  const first=await finish((await launch(input)).id);
  const finding=first.findings.find(f=>f.check.startsWith('authorization_'));assert.ok(finding,JSON.stringify(first.browser));assert.equal(first.status,'completed');assert.equal(finding.target,apiOrigin+'/record');
  const proof=first.browser!.proofs.find(p=>p.kind==='authorization'&&p.observations.account==='bob')!;assert.equal(proof.observations.apiSessionBefore,true);assert.equal(proof.observations.apiSessionAfter,true);
  assert.ok(first.evidence.some(e=>e.apiOrigin===apiOrigin&&e.accountId==='alice'));assert.ok(first.evidence.some(e=>e.apiOrigin===apiOrigin&&e.accountId==='bob'));
  assert.ok(first.evidence.some(e=>e.method==='OPTIONS'&&e.corsAllowed===true&&e.corsCredentials==='include'&&e.corsRequestHeaders?.includes('authorization')));
  for(const secret of [browserSecrets.aliceToken,browserSecrets.bobToken,browserSecrets.marker])assert.ok(!JSON.stringify(first).includes(secret));
  mode='fixed';const fixed=await finish((await launch({authorized:true,browserSecrets},first.id)).id);assert.ok(fixed.comparison?.notObserved.includes(finding.fingerprint),JSON.stringify(fixed.browser));
  for(const failure of ['outage','expired','wrong-identity','cors-missing','credentials-missing','origin-wildcard','headers-wildcard','preflight-denied','preflight-credentials']){mode=failure;revoked.clear();const offset=seen.length;const run=await finish((await launch({authorized:true,browserSecrets},first.id)).id);assert.equal(run.status,'partial');assert.ok(run.comparison?.unverified.includes(finding.fingerprint),failure);assert.equal(run.comparison?.notObserved.length,0);if(['origin-wildcard','headers-wildcard','preflight-denied','preflight-credentials'].includes(failure))assert.ok(!seen.slice(offset).some(v=>v.path==='/record'&&v.method!=='OPTIONS'),'Rejected preflight must prevent protected request: '+failure);}
  await assert.rejects(()=>launch({authorized:true,browserSecrets:{...browserSecrets,bobApiIdentity:'replacement'}},first.id),/preserve expected/);
  mode='vulnerable';postOnly=true;revoked.clear();
  const postSecrets={...browserSecrets,query:JSON.stringify({id:'fixture-a'})};
  const postInput={...input,browserSecrets:postSecrets,browser:{...browser,apiGrants:browser.apiGrants.map(g=>({...g,methods:['GET','POST']})),authorization:browser.authorization.map(c=>({...c,method:'POST',bodyRef:'query'}))}};
  assert.throws(()=>startAssessment(root,{...postInput,browser:{...postInput.browser,apiGrants:browser.apiGrants}}),/granted/);
  const posted=await finish((await launch(postInput)).id),postFinding=posted.findings.find(f=>f.check.startsWith('authorization_'));assert.ok(postFinding,JSON.stringify(posted.browser));
  assert.equal(posted.evidence.filter(e=>e.method==='POST'&&e.apiOrigin===apiOrigin).length,2);
  assert.ok(!JSON.stringify(posted).includes('fixture-a'));
  await assert.rejects(()=>launch({authorized:true,browserSecrets:{...postSecrets,query:'{"id":"different"}'}},posted.id),/preserve expected/);
  mode='fixed';const postFixed=await finish((await launch({authorized:true,browserSecrets:postSecrets},posted.id)).id);assert.ok(postFixed.comparison?.notObserved.includes(postFinding.fingerprint));
  mode='json-header-denied';const offset=seen.length;const invalid=await finish((await launch({authorized:true,browserSecrets:postSecrets},posted.id)).id);assert.ok(invalid.comparison!.unverified.includes(postFinding.fingerprint));assert.ok(!seen.slice(offset).some(v=>v.path==='/record'&&v.method==='POST'));
  assert.ok(seen.filter(v=>v.method==='OPTIONS').every(v=>!v.authorization&&!v.cookie),'Preflights must not carry credentials');
  console.log('PASS: cross-origin GET/POST account controls and retests, response CORS/credentials, wildcard denial, explicit authorization/JSON preflights, no protected request after rejected preflight, no credentials in OPTIONS, redaction and identity pinning');
}finally{api.closeAllConnections();api.close();app.closeAllConnections();app.close();}
