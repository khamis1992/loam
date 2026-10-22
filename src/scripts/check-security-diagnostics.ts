import assert from 'node:assert/strict';
import fs from 'node:fs';
import {executionDiagnostics} from '../security/diagnostics.js';
import type {Assessment} from '../security/assessments.js';
import {blankBrowserOptions} from '../security/browser.js';
import {normalizeScope} from '../security/scope.js';

const run:Assessment={id:'diagnostics',target:'http://localhost:5173/',checks:[],includeSource:false,includeDependencies:false,queryAdvisories:false,status:'partial',createdAt:new Date(0).toISOString(),finishedAt:new Date(1000).toISOString(),completed:0,total:0,findings:[],events:[],revision:0,profile:'campaign',scope:normalizeScope('http://localhost:5173/',{seeds:['http://localhost:5173/auth']}),authenticated:false,protectedPaths:[],apiSeeds:[],covered:[],evidence:[],browserOptions:{...blankBrowserOptions(),enabled:true,flows:[{name:'signin',steps:[{action:'assertVisible',selector:'#email'}]}]},businessCases:[],businessQuotas:[],businessSteps:[],businessPricing:[],businessCancels:[],businessRaces:[],businessConsistency:[],injectionCases:[],traversalCases:[],ssrfCases:[],uploadCases:[],templateCases:[],xxeCases:[],deserCases:[],commandCases:[],redirectCases:[],browser:{engine:'chrome',version:'test',pages:[],blocked:[],incomplete:true,proofs:[{id:'p1',at:new Date(0).toISOString(),kind:'flow',target:'http://localhost:5173/auth',outcome:'inconclusive',summary:'Steps completed but resources failed',requestIds:[],observations:{completed:1,total:1}}]}};
let d=executionDiagnostics(run);
assert.equal(d.modules.find(m=>m.id==='flows')?.state,'incomplete');
assert.equal(d.modules.find(m=>m.id==='flows')?.attempted,1);
assert.equal(d.modules.find(m=>m.id==='flows')?.conclusive,0);
assert.equal(d.modules.find(m=>m.id==='flows')?.inconclusive,1);
assert.ok(!d.reasons.some(r=>r.includes('النطاق مقيد')));
run.scope=normalizeScope('http://localhost:5173/app',{});
assert.ok(executionDiagnostics(run).reasons.some(r=>r.includes('النطاق مقيد')));
run.scope=normalizeScope('http://localhost:5173/',{seeds:['http://localhost:5180/api']});
assert.ok(executionDiagnostics(run).reasons.some(r=>r.includes('النطاق مقيد')),'Root on another origin must not hide restricted scope');
run.browser!.proofs=[];
assert.equal(executionDiagnostics(run).modules.find(m=>m.id==='flows')?.state,'no_execution');
run.status='running';
assert.equal(executionDiagnostics(run).modules.find(m=>m.id==='flows')?.state,'pending');

// Optional replay of actual local evidence; generic assertions above run in CI too.
const evidence='output/verification/nutrio-assessments.json';
if(fs.existsSync(evidence)){
  const runs=JSON.parse(fs.readFileSync(evidence,'utf8').replace(/^\uFEFF/,'')) as Assessment[];
  const flowRun=runs.find(r=>r.browser?.proofs.some(p=>p.kind==='flow'))!;
  assert.ok(flowRun);
  d=executionDiagnostics(flowRun);
  assert.equal(d.modules.find(m=>m.id==='flows')?.state,'incomplete');
  assert.equal(d.modules.find(m=>m.id==='flows')?.attempted,1);
  assert.ok(!d.reasons.some(r=>r.includes('النطاق مقيد')));
}
console.log('PASS: attempted versus conclusive coverage, partial flows, pending/unexecuted distinction, origin-specific scope and local evidence replay');
