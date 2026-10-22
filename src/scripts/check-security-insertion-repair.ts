import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {once} from 'node:events';
import {chromium} from 'playwright';
import {startAssessment,readAssessment,retestAssessment,type Assessment,type AssessmentInput} from '../security/assessments.js';
import {prepareRepair,changeRepair} from '../security/repairs.js';
import {htmlInsertionRisks} from '../security/source-html.js';
let root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-insertion-repair-')),taskId='';
const base=process.env.LOAM_SECURITY_TEST_BASE;
if(base&&!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw Error('Installed test requires loopback');
async function post(route:string,body:unknown){const r=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json() as Promise<any>;}
if(base){
  const {task}=await post('/api/tasks/draft',{mode:'build',title:'Reviewed HTML insertion repair'});taskId=task.id;
  const data=await(await fetch(base+'/api/security/assessments?taskId='+taskId)).json() as any;
  root=path.resolve(data.workspace);assert.equal(path.basename(root),taskId);assert.equal(path.basename(path.dirname(root)),'.loam-tasks');
}
const file=path.join(root,'insertion.js');
const server=http.createServer((req,res)=>{
  if(req.url==='/app.js'){res.setHeader('content-type','application/javascript');res.end(fs.readFileSync(file));return;}
  res.setHeader('content-type','text/html');res.end('<!doctype html><main id="container"><span>B</span><div id="app"><i id="child">C</i></div><span>A</span></main><script src="/app.js"></script>');
});server.listen(0,'127.0.0.1');await once(server,'listening');
const target='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port+'/';
async function launch(input:AssessmentInput,id?:string):Promise<Assessment>{if(!base)return id?retestAssessment(root,id,input):startAssessment(root,input);return (await post('/api/security/assessments'+(id?'/'+id+'/retest':'')+'?taskId='+taskId,input)).run;}
async function finish(id:string){for(let i=0;i<900;i++){const run:Assessment=base?(await(await fetch(base+'/api/security/assessments/'+id+'?taskId='+taskId)).json() as any).run:readAssessment(root,id);if(run.status!=='running')return run;await new Promise(r=>setTimeout(r,100));}throw Error('Assessment observation timeout');}
async function prepare(id:string,fingerprint:string){return base?(await post('/api/security/assessments/'+id+'/repairs?taskId='+taskId,{fingerprint})).repair:prepareRepair(root,id,{fingerprint});}
async function change(id:string,repairId:string,rollback=false){return base?(await post('/api/security/assessments/'+id+'/repairs/'+repairId+'/'+(rollback?'rollback':'apply')+'?taskId='+taskId,{reviewed:true})).repair:changeRepair(root,id,repairId,{reviewed:true},rollback);}
try{
  let lastOriginal='';
  for(const sample of ['// a.insertAdjacentHTML("beforeend", input);','const s=\'a.insertAdjacentHTML("beforeend", input)\';','a.insertAdjacentText("beforeend", input);'])assert.equal(htmlInsertionRisks('sample.js',sample).length,0);
  assert.equal(htmlInsertionRisks('sample.ts','a.insertAdjacentHTML(\n"beforeend", input);').length,1);
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{for(const position of ['beforebegin','afterbegin','beforeend','afterend']){
    const original='document.getElementById("app").insertAdjacentHTML('+JSON.stringify(position)+', decodeURIComponent(location.hash.slice(1)));\n';lastOriginal=original;fs.writeFileSync(file,original);
    const first=await finish((await launch({target,authorized:true,includeSource:true,checks:['server_banner'],scope:{delayMs:0},browser:{enabled:true,screenshots:false,maxPages:1,settleMs:250,domCanary:true}})).id);
    const source=first.findings.find(f=>f.check==='source_html')!,canary=first.findings.find(f=>f.check==='browser_dom_canary')!;assert.ok(source,position);assert.ok(canary,position);
    const draft=await prepare(first.id,source.fingerprint);assert.equal(fs.readFileSync(file,'utf8'),original);assert.equal(draft.edit.before,'insertAdjacentHTML');assert.equal(draft.edit.after,'insertAdjacentText');
    await change(first.id,draft.id);assert.equal(fs.readFileSync(file,'utf8'),original.replace('.insertAdjacentHTML','.insertAdjacentText'));
    const fixed=await finish((await launch({authorized:true},first.id)).id);assert.ok(fixed.comparison!.notObserved.includes(canary.fingerprint));assert.ok(fixed.comparison!.unverified.includes(source.fingerprint));
    const page=await browser.newPage();try{
      await page.goto(target+'#'+encodeURIComponent('<b>literal</b>'));
      const state=await page.evaluate(`(()=>{const app=document.getElementById('app'),node=(${JSON.stringify(position)}==='beforebegin'?app.previousSibling:${JSON.stringify(position)}==='afterend'?app.nextSibling:${JSON.stringify(position)}==='afterbegin'?app.firstChild:app.lastChild);return {text:node.textContent,nodeType:node.nodeType,child:document.getElementById('child').textContent,markup:document.querySelectorAll('b').length};})()`);
      assert.deepEqual(state,{text:'<b>literal</b>',nodeType:3,child:'C',markup:0},position);
    }finally{await page.close();}
    await change(first.id,draft.id,true);assert.equal(fs.readFileSync(file,'utf8'),original);
    const restored=await finish((await launch({authorized:true},first.id)).id);assert.ok(restored.comparison!.persistent.includes(canary.fingerprint));
  }}finally{await browser.close();}
  for(const invalid of ['app.insertAdjacentHTML(position, value);','app.insertAdjacentHTML("invalid", value);','app.insertAdjacentHTML(...args);','app?.insertAdjacentHTML("beforeend", value);','app.insertAdjacentHTML("beforeend", a); app.innerHTML=b;']){
    fs.writeFileSync(file,invalid);const run=await finish((await launch({includeSource:true})).id);const source=run.findings.find(f=>f.check==='source_html');assert.ok(source,invalid);await assert.rejects(()=>prepare(run.id,source.fingerprint),/ambiguous|supported/);
  }
  fs.writeFileSync(file,lastOriginal);const review=await finish((await launch({includeSource:true})).id);const source=review.findings.find(f=>f.check==='source_html')!;await prepare(review.id,source.fingerprint);
  console.log('PASS: four real-browser insertion positions, text preservation and markup refusal, reviewed token edit, browser canary repair/rollback retests, static disappearance unverified, AST controls and unsupported/ambiguous repair rejection');
  console.log('Task evidence: '+(taskId||root));
  console.log('Review run: '+review.id);
}finally{server.closeAllConnections();server.close();}
