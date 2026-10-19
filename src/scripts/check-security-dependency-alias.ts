import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {inspectDependencies,queryAdvisories} from '../security/dependencies.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-npm-alias-'));
try{
  const file=path.join(root,'package-lock.json');
  fs.copyFileSync('src/scripts/fixtures/security-npm-alias-lock.json',file);
  const real=inspectDependencies(root);assert.equal(real.packages[0]!.name,'lodash');assert.equal(real.packages[0]!.installedName,'renamed-lodash');assert.equal(real.packages[0]!.version,'4.17.20');
  let sent:any;
  await queryAdvisories(real,new AbortController().signal,(async(_url,options)=>{sent=JSON.parse(String(options!.body));return new Response('{"results":[{"vulns":[{"id":"GHSA-fixture"}]}]}');}) as typeof fetch);
  assert.deepEqual(sent,{queries:[{package:{name:'lodash',ecosystem:'npm'},version:'4.17.20'}]});assert.equal(real.findings[0]!.target,'npm:lodash@4.17.20');
  if(process.argv.includes('--live')){
    const live=inspectDependencies(root);await queryAdvisories(live,AbortSignal.timeout(25000));
    assert.equal(live.advisories!.complete,true,live.warnings.join('; '));assert.ok(live.advisories!.matches[0]!.ids.length>0);
    assert.equal(live.advisories!.matches[0]!.name,'lodash');
    console.log('LIVE public alias fixture: '+live.advisories!.matches[0]!.ids.length+' advisory IDs matched lodash@4.17.20');
  }
  fs.writeFileSync(file,JSON.stringify({lockfileVersion:3,packages:{'node_modules/alias':{name:'@scope/actual',version:'1.2.3'},'node_modules/parent/node_modules/second-alias':{name:'@scope/actual',version:'1.2.3'},'node_modules/ordinary':{version:'2.0.0'},'node_modules/bad':{name:23,version:'1.0.0'}}}));
  const nested=inspectDependencies(root);assert.equal(nested.packages.length,3);assert.equal(nested.coverage!.complete,false);assert.equal(nested.coverage!.invalid,1);
  await queryAdvisories(nested,new AbortController().signal,(async(_url,options)=>{sent=JSON.parse(String(options!.body));return new Response('{"results":[{},{}]}');}) as typeof fetch);
  assert.equal(sent.queries.length,2);assert.deepEqual(sent.queries.map((q:any)=>q.package.name),['@scope/actual','ordinary']);assert.equal(nested.advisories!.complete,false);
  assert.ok(!JSON.stringify(sent).includes('node_modules'));assert.ok(!JSON.stringify(sent).includes('second-alias'));
  console.log('PASS npm identity: real npm-generated alias lockfile, scoped/nested aliases, canonical OSV payload, deduplication and malformed-name coverage');
}finally{fs.rmSync(root,{recursive:true,force:true});}
