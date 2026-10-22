import assert from 'node:assert/strict';
import http from 'node:http';import {once} from 'node:events';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {startAssessment,readAssessment,retestAssessment,type Assessment,type AssessmentInput} from '../security/assessments.js';
import {normalizeAnonymousApi,anonymousCollection,validatePublicKey} from '../security/anonymous-api.js';
import {chromium} from 'playwright';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-anonymous-api-'));
let mode='vulnerable',controls=0;const received:Array<{path:string;cookie?:string;authorization?:string;apikey?:string}>=[];
const app=http.createServer((_req,res)=>res.end('Local frontend'));app.listen(0,'127.0.0.1');await once(app,'listening');
const target='http://127.0.0.1:'+(app.address() as import('node:net').AddressInfo).port+'/';
const api=http.createServer((req,res)=>{
  if(!(mode==='cors-missing'&&req.url?.startsWith('/private')&&req.method!=='OPTIONS'))res.setHeader('access-control-allow-origin',target.slice(0,-1));res.setHeader('access-control-allow-headers',mode==='preflight-denied'&&req.url?.startsWith('/private')?'content-type':'apikey');res.setHeader('access-control-allow-methods','GET');res.setHeader('content-type','application/json');
  if(req.method==='OPTIONS'){res.writeHead(204).end();return;}
  received.push({path:req.url!,cookie:req.headers.cookie,authorization:req.headers.authorization,apikey:String(req.headers.apikey??'')});
  if(req.headers.apikey!=='public-fixture-key'){res.writeHead(401).end('{"error":"key"}');return;}
  if(req.url==='/catalog'){controls++;res.end(mode==='control-empty'||mode==='control-expired'&&controls%3===0?'[]':'[{"id":"public"}]');return;}
  if(req.url?.startsWith('/private')){
    if(mode==='redirect'){res.writeHead(302,{location:target+'outside'}).end();return;}
    if(mode==='outage'){res.writeHead(503).end('{"error":"offline"}');return;}
    if(mode==='fixed'){res.writeHead(403).end('{"error":"denied"}');return;}
    if(mode==='denial-leak')res.statusCode=403;
    res.end(mode==='empty'?'[]':mode==='wrong-shape'?'{"other":[]}':mode==='malformed'?'not-json':'[{"id":"private-fixture-value"}]');return;
  }res.writeHead(404).end('{}');
});api.listen(0,'127.0.0.1');await once(api,'listening');
const origin='http://127.0.0.1:'+(api.address() as import('node:net').AddressInfo).port;
const grants=[{origin,paths:['/catalog','/private'],methods:['GET' as const],credentialHeaders:['apikey']}];
const cases=[{id:'catalog',origin,path:'/catalog',collectionPath:'',expected:'public',publicKeyRef:'appKey'},{id:'records',origin,path:'/private',query:{limit:'1'},collectionPath:'',expected:'private',publicKeyRef:'appKey',controlId:'catalog'}];
assert.equal(normalizeAnonymousApi(cases,grants).length,2);
for(const bad of [{...cases[1],controlId:'missing'},{...cases[1],publicKeyRef:'different'},{...cases[1],path:'/outside'},{...cases[1],query:{action:'delete'}}])assert.throws(()=>normalizeAnonymousApi([cases[0],bad],grants));
assert.throws(()=>validatePublicKey('sb_secret_forbidden'));assert.throws(()=>validatePublicKey('a.'+Buffer.from('{"role":"service_role"}').toString('base64url')+'.b'));
assert.deepEqual(anonymousCollection('{"a/b":{"~key":[1]}}','/a~1b/~0key'),{jsonValid:true,rows:1});
const base=process.env.LOAM_SECURITY_TEST_BASE;let taskId='';
if(base&&!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw Error('Installed verification requires loopback');
async function post(url:string,body:unknown){const r=await fetch(base+url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json() as Promise<any>;}
async function launch(input:AssessmentInput,baseline?:string):Promise<Assessment>{if(!base)return baseline?retestAssessment(root,baseline,input):startAssessment(root,input);return (await post('/api/security/assessments'+(baseline?'/'+baseline+'/retest':'')+'?taskId='+taskId,input)).run;}
async function finish(id:string){for(let i=0;i<600;i++){const r:Assessment=base?(await(await fetch(base+'/api/security/assessments/'+id+'?taskId='+taskId)).json() as any).run:readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout');}
try{
  if(base)taskId=(await post('/api/tasks/draft',{mode:'build',title:'Anonymous API regression'})).task.id;
  const input={target,authorized:true,checks:['server_banner'],scope:{delayMs:0},browser:{enabled:true,screenshots:false,maxPages:1,settleMs:250,apiGrants:grants,anonymousApi:cases},browserSecrets:{appKey:'public-fixture-key'}};
  const first=await finish((await launch(input)).id);const finding=first.findings.find(f=>f.check.startsWith('anonymous_api_'))!;assert.ok(finding,JSON.stringify(first));assert.equal(finding.confidence,'review');
  assert.ok(finding.requestIds.length>=3,'Finding must link public controls and target request evidence');
  assert.ok(!JSON.stringify(first).includes('private-fixture-value'));assert.ok(!JSON.stringify(first).includes('public-fixture-key'));
  assert.ok(received.every(r=>!r.cookie&&!r.authorization));
  if(!base)assert.throws(()=>retestAssessment(root,first.id,{authorized:true,browserSecrets:{appKey:'changed-key'}}),/preserve/);
  for(mode of ['fixed','empty','wrong-shape','malformed','control-empty','control-expired','outage','redirect','cors-missing','preflight-denied','denial-leak']){
    controls=0;const requestStart=received.length;const run=await finish((await launch({authorized:true,browserSecrets:input.browserSecrets},first.id)).id);
    const proof=run.browser!.proofs.find(p=>p.kind==='anonymous_api'&&p.observations.caseId==='records');
    if(mode==='fixed'){assert.equal(proof!.outcome,'not_observed');assert.ok(run.comparison!.notObserved.includes(finding.fingerprint));}
    else if(mode==='denial-leak'){assert.equal(proof!.outcome,'observed');assert.ok(run.comparison!.persistent.includes(finding.fingerprint));}
    else {assert.equal(proof!.outcome,'inconclusive',mode);assert.ok(run.comparison!.unverified.includes(finding.fingerprint),mode);}
    if(mode==='preflight-denied')assert.ok(!received.slice(requestStart).some(r=>r.path.startsWith('/private')),'Denied preflight must prevent the actual GET');
  }
  if(base){
    mode='vulnerable';const {task}=await post('/api/tasks/draft',{mode:'build',title:'Anonymous API UI'});
    const browser=await chromium.launch({headless:true,channel:'chrome'});
    try{const page=await browser.newPage({viewport:{width:1440,height:1000}});await page.goto(base+'/security.html');await page.locator('#task').selectOption(task.id);
      await page.locator('#target').fill(target);await page.locator('#authorized').check();
      await page.getByText('متصفح فعلي والتحقق من الثغرات',{exact:true}).click();await page.locator('#browserEnabled').check();await page.locator('#screenshots').uncheck();
      await page.locator('#apiGrants').fill(JSON.stringify(grants));await page.locator('#anonymousApi').fill(JSON.stringify(cases));await page.locator('#browserSecrets').fill(JSON.stringify(input.browserSecrets));
      await page.locator('#start').click();for(let n=0;n<600;n++){if(await page.locator('#history button').count()&&await page.locator('#start').isEnabled())break;await page.waitForTimeout(100);}
      await page.locator('[data-tab="browser"]').click();assert.match(await page.locator('#results').innerText(),/فحص API دون حساب/);assert.match(await page.locator('#results').innerText(),/declared private/i);
      assert.match(await page.locator('#executionDiagnostics').innerText(),/API دون حساب/);assert.equal(await page.locator('#browserSecrets').inputValue(),'');
      await page.screenshot({path:path.join(root,'anonymous-api-ui.png'),fullPage:true});console.log('UI screenshot: '+path.join(root,'anonymous-api-ui.png'));
    }finally{await browser.close();}
  }
  console.log('PASS: anonymous API controls, denied/empty/leaked/error distinctions, scope and key validation, no cookies/session, redaction and pinned-key retests');
}finally{app.closeAllConnections();app.close();api.closeAllConnections();api.close();}
