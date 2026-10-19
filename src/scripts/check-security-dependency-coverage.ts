import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {inspectDependencies,queryAdvisories,type DependencyInventory} from '../security/dependencies.js';
import {startAssessment,readAssessment} from '../security/assessments.js';
import {sarif} from '../security/findings.js';
import {executionDiagnostics} from '../security/diagnostics.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-dependency-coverage-'));
const file=path.join(root,'package-lock.json');
const write=(packages:unknown)=>fs.writeFileSync(file,JSON.stringify({lockfileVersion:3,packages}));
const fresh=():DependencyInventory=>({packages:[{name:'example',version:'1.0.0',dev:false}],findings:[],warnings:[]});
async function audit(item:unknown){const inventory=fresh();await queryAdvisories(inventory,new AbortController().signal,(async()=>new Response(JSON.stringify({results:[item]}))) as typeof fetch);return inventory;}
try{
  assert.equal(inspectDependencies(root).coverage!.complete,false);
  for(const malformed of [[],null,'bad']){write(malformed);assert.equal(inspectDependencies(root).coverage!.complete,false);}
  write({'':{name:'root'},'node_modules/a':{version:'1.0.0'},'node_modules/b':{version:3}});
  const invalid=inspectDependencies(root);assert.equal(invalid.packages.length,1);assert.equal(invalid.coverage!.invalid,1);assert.equal(invalid.coverage!.complete,false);
  await queryAdvisories(invalid,new AbortController().signal,(async()=>new Response('{"results":[{}]}')) as typeof fetch);
  assert.equal(invalid.advisories!.complete,false,'OSV success cannot restore missing inventory coverage');
  const entries=Object.fromEntries(Array.from({length:10000},(_,i)=>['node_modules/p'+i,{version:'1.0.0'}]));
  write(entries);assert.equal(inspectDependencies(root).coverage!.complete,true);
  write({...entries,'node_modules/overflow':{version:'1.0.0'}});const over=inspectDependencies(root);assert.equal(over.coverage!.limitReached,true);assert.equal(over.coverage!.processed,10000);assert.equal(over.coverage!.complete,false);
  for(const item of [null,[],{vulns:null},{vulns:{}},{vulns:[{}]},{vulns:[{id:'bad id'}]},{next_page_token:1}]){
    const result=await audit(item);assert.equal(result.advisories!.complete,false,JSON.stringify(item));assert.ok(result.findings.some(f=>f.verdict==='error'));
  }
  const empty=await audit({});assert.equal(empty.advisories!.complete,true);assert.equal(empty.advisories!.queried,1);
  const pagination=await audit({vulns:[{id:'GHSA-fixture'}],next_page_token:'more'});assert.equal(pagination.advisories!.complete,false);assert.equal(pagination.advisories!.matches.length,1);assert.ok(pagination.findings.some(f=>f.verdict==='error'));
  const ineligible=fresh();ineligible.packages[0]!.version='latest';let contacted=false;
  await queryAdvisories(ineligible,new AbortController().signal,(async()=>{contacted=true;throw Error('unexpected');}) as typeof fetch);
  assert.equal(contacted,false);assert.equal(ineligible.advisories!.complete,false);assert.ok(ineligible.findings.some(f=>f.verdict==='error'));
  write({'node_modules/a':{version:'1.0.0'},'node_modules/b':null});
  const created=startAssessment(root,{includeDependencies:true});let run=readAssessment(root,created.id);
  for(let n=0;n<100&&run.status==='running';n++){await new Promise(r=>setTimeout(r,20));run=readAssessment(root,created.id);}
  assert.equal(run.status,'partial');assert.equal(sarif(run.findings).runs[0]!.invocations[0]!.executionSuccessful,false);
  assert.equal(executionDiagnostics(run).modules.find(m=>m.id==='dependencies')!.state,'incomplete');
  console.log('PASS dependency coverage: invalid/missing inventory, exact entry limit, malformed OSV responses, pagination, ineligible versions and partial SARIF campaign');
}finally{fs.rmSync(root,{recursive:true,force:true});}
