import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {once} from 'node:events';
import {startAssessment,readAssessment,retestAssessment,cancelAssessment} from '../security/assessments.js';import {prepareRepair,changeRepair,listRepairs} from '../security/repairs.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-repairs-')),file=path.join(root,'app.js');
const original='document.getElementById("app").innerHTML = decodeURIComponent(location.hash.slice(1));\n';fs.writeFileSync(file,original);
const server=http.createServer((req,res)=>{if(req.url==='/app.js'){res.setHeader('content-type','application/javascript');res.end(fs.readFileSync(file));return;}res.setHeader('content-type','text/html');res.end('<div id="app"></div><script src="/app.js"></script>');});server.listen(0,'127.0.0.1');await once(server,'listening');const target='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;
async function finish(id:string){for(let i=0;i<900;i++){const r=readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout');}
try{
  const input={target,authorized:true,includeSource:true,checks:['server_banner'],scope:{delayMs:0},browser:{enabled:true,screenshots:false,maxPages:1,settleMs:250,domCanary:true}};
  const first=await finish(startAssessment(root,input).id);const source=first.findings.find(f=>f.check==='source_html')!,canary=first.findings.find(f=>f.check==='browser_dom_canary')!;assert.ok(source);assert.ok(canary);
  const draft=prepareRepair(root,first.id,{fingerprint:source.fingerprint});assert.equal(fs.readFileSync(file,'utf8'),original);assert.equal(draft.edit.before,'innerHTML');assert.equal(draft.edit.after,'textContent');
  assert.throws(()=>changeRepair(root,first.id,draft.id,{}),/review/);
  const active=startAssessment(root,{target,authorized:true,checks:['server_banner']});assert.throws(()=>changeRepair(root,first.id,draft.id,{reviewed:true}),/active assessment/);cancelAssessment(root,active.id);await finish(active.id);assert.equal(fs.readFileSync(file,'utf8'),original);
  fs.appendFileSync(file,'// concurrent edit');assert.throws(()=>changeRepair(root,first.id,draft.id,{reviewed:true}),/changed/);fs.writeFileSync(file,original);
  changeRepair(root,first.id,draft.id,{reviewed:true});assert.equal(fs.readFileSync(file,'utf8'),original.replace('.innerHTML','.textContent'));assert.equal(listRepairs(root,first.id)[0]!.state,'applied');
  const fixed=await finish(retestAssessment(root,first.id,{authorized:true}).id);assert.ok(fixed.comparison?.notObserved.includes(canary.fingerprint),JSON.stringify(fixed.browser));assert.ok(fixed.comparison?.unverified.includes(source.fingerprint),'Static-pattern disappearance alone must not be promoted to verified repair');
  assert.equal(readAssessment(root,first.id).findings.find(f=>f.fingerprint===source.fingerprint)!.workflow.state,'open');
  fs.appendFileSync(file,'// new edit');assert.throws(()=>changeRepair(root,first.id,draft.id,{reviewed:true},true),/changed/);fs.writeFileSync(file,original.replace('.innerHTML','.textContent'));
  changeRepair(root,first.id,draft.id,{reviewed:true},true);assert.equal(fs.readFileSync(file,'utf8'),original);assert.equal(listRepairs(root,first.id)[0]!.state,'rolled_back');
  const restored=await finish(retestAssessment(root,first.id,{authorized:true}).id);assert.ok(restored.comparison?.persistent.includes(canary.fingerprint));
  const manifest=path.join(root,'.loam/security/repairs',draft.id+'.json');
  // Emulate process termination on either side of the atomic source replacement.
  for(const pending of ['apply','rollback'] as const)for(const applied of [false,true]){
    fs.writeFileSync(file,applied?original.replace('.innerHTML','.textContent'):original);
    fs.writeFileSync(manifest,JSON.stringify({...draft,state:pending==='apply'?'draft':'applied',pending}));
    const recovered=listRepairs(root,first.id)[0]!;
    assert.equal(recovered.state,pending==='apply'?(applied?'applied':'draft'):(applied?'applied':'rolled_back'));assert.equal(recovered.pending,undefined);assert.ok(recovered.recovery);
    assert.equal(fs.readFileSync(file,'utf8'),applied?original.replace('.innerHTML','.textContent'):original,'Recovery must not rewrite source');
  }
  fs.writeFileSync(file,'// user edit after interruption');fs.writeFileSync(manifest,JSON.stringify({...draft,pending:'apply'}));
  assert.equal(listRepairs(root,first.id)[0]!.state,'conflict');assert.throws(()=>changeRepair(root,first.id,draft.id,{reviewed:true}),/draft/);assert.equal(fs.readFileSync(file,'utf8'),'// user edit after interruption');
  fs.writeFileSync(file,original);fs.writeFileSync(manifest,JSON.stringify({...draft,pending:'apply'}));assert.equal(listRepairs(root,first.id)[0]!.state,'draft');
  changeRepair(root,first.id,draft.id,{reviewed:true});changeRepair(root,first.id,draft.id,{reviewed:true},true);
  const backup=path.join(root,'.loam/security/repairs',draft.id+'.before');fs.writeFileSync(backup,'corrupt backup');fs.writeFileSync(manifest,JSON.stringify({...draft,pending:'apply'}));assert.equal(listRepairs(root,first.id)[0]!.state,'conflict');assert.equal(fs.readFileSync(file,'utf8'),original);fs.writeFileSync(backup,original);
  for(const invalid of ['// element.innerHTML = userInput;','const sample="element.innerHTML = userInput";','a.innerHTML = x; b.innerHTML = y;']){
    fs.writeFileSync(file,invalid);const scan=await finish(startAssessment(root,{includeSource:true}).id);const f=scan.findings.find(f=>f.check==='source_html')!;assert.ok(f);assert.throws(()=>prepareRepair(root,scan.id,{fingerprint:f.fingerprint}),/ambiguous|direct/);
  }
  console.log('PASS: AST-bound draft, no mutation before review, stale-source refusal, reversible apply, persistent repair state, active-assessment guard, interruption recovery, conflict/backup integrity, browser reproduction/fix/rollback retests and no automatic closure');
}finally{server.closeAllConnections();server.close();}
