import assert from 'node:assert/strict';import http from 'node:http';import {once} from 'node:events';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {planOpenApi} from '../security/openapi.js';import {normalizeScope} from '../security/scope.js';import {startAssessment,readAssessment,retestAssessment} from '../security/assessments.js';
const requests:string[]=[];const server=http.createServer((req,res)=>{requests.push(req.url!);res.setHeader('content-type','application/json');res.end('{}');});server.listen(0,'127.0.0.1');await once(server,'listening');const target='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;
const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-openapi-'));
const openapi={servers:[{url:'https://not-authorized.invalid'}],paths:{'/records/{id}':{parameters:[{name:'id',in:'path',required:true}],get:{},post:{}},'/missing/{id}':{parameters:[{name:'id',in:'path',required:true}],get:{}},'/search':{get:{parameters:[{name:'q',in:'query',required:true}]}},'/referenced':{get:{parameters:[{$ref:'https://outside.invalid/parameter'}]}},'/static':{get:{}},'/blocked':{get:{}}}};
const fixtures={'/records/{id}':[{id:'fixture-a'},{id:'fixture-b'}]};const scope=normalizeScope(target,{delayMs:0,exclusions:['/blocked']});
async function finish(id:string){for(let i=0;i<300;i++){const r=readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,20));}throw Error('Timeout');}
try{
  const plan=planOpenApi(openapi,scope,fixtures)!;assert.equal(plan.operations.length,7);assert.deepEqual(plan.seeds,[target+'/records/fixture-a',target+'/records/fixture-b',target+'/static']);assert.equal(plan.operations.filter(o=>o.reason).length,5);
  assert.throws(()=>planOpenApi(openapi,scope,{'/records/{id}':[{id:'../secret'}]}),/simple path/);
  assert.throws(()=>planOpenApi(openapi,scope,{'/records/{id}':[{wrong:'a'}]}),/exactly match/);
  assert.throws(()=>planOpenApi(undefined,scope,fixtures),/require a document/);
  const input={target,authorized:true,profile:'campaign',scope:{delayMs:0,exclusions:['/blocked']},checks:['server_banner'],openapi,openapiFixtures:fixtures};
  assert.throws(()=>startAssessment(root,{...input,profile:'quick'}),/campaign mode/);
  const first=await finish(startAssessment(root,input).id);assert.equal(first.status,'completed');
  for(const url of ['/records/fixture-a','/records/fixture-b','/static'])assert.ok(requests.includes(url));
  for(const url of ['/search','/referenced','/blocked','/missing/{id}'])assert.ok(!requests.includes(url));
  const row=first.diagnostics!.apiOperations!.find(o=>o.path==='/records/{id}'&&o.method==='GET')!;assert.equal(row.requestedUrls.length,2);assert.equal(row.successfulUrls.length,2);
  const retest=await finish(retestAssessment(root,first.id,{authorized:true}).id);assert.deepEqual(retest.openapiPlan,first.openapiPlan);assert.deepEqual(retest.apiSeeds,first.apiSeeds);
  const bounded=await finish(startAssessment(root,{...input,scope:{delayMs:0,maxPages:1}}).id);assert.equal(bounded.status,'partial');assert.equal(bounded.diagnostics!.apiOperations!.find(o=>o.path==='/records/{id}'&&o.method==='GET')!.requestedUrls.length,0);
  console.log('PASS: explicit parameter fixtures reach real routes, missing inputs and unsupported methods reported, scope/URI containment, no external reference fetch, retest plan preservation and unrequested budget coverage');
}finally{server.closeAllConnections();server.close();}
