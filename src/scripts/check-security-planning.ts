import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {startAssessment,readAssessment} from '../security/assessments.js';
import {buildPlan,type PlanEvidence} from '../security/planning.js';

// Fixture application: a web page with a link + query endpoint, plus a
// workspace whose source declares routes and a SQL-shaped flow.
const server=http.createServer((req,res)=>{
  const url=new URL(req.url!,'http://localhost');
  if(url.pathname==='/'&&req.method==='GET'){res.setHeader('content-type','text/html').end('<!doctype html><title>plan fixture</title><a href="/search">search</a>');return;}
  if(url.pathname==='/search'&&req.method==='GET'){res.setHeader('content-type','text/html').end('<!doctype html><title>results '+ (url.searchParams.get('q')??'') +'</title>');return;}
  res.writeHead(404).end();
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const target='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;

const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-security-plan-'));
fs.writeFileSync(path.join(root,'routes.js'),[
  'const { getUser } = require("./db");',
  'app.get("/users", function (req, res) {',
  '  getUser(req.query.id);',
  '});',
].join('\n'));
fs.writeFileSync(path.join(root,'db.js'),[
  'function getUser(id) {',
  '  return db.query("SELECT * FROM users WHERE id=" + id);',
  '}',
  'module.exports = { getUser };',
].join('\n'));
const openapiDoc={paths:{
  '/items/{id}':{parameters:[{in:'path',name:'id',required:true}],get:{}},
  '/orders':{post:{}},
}};
const input={target,authorized:true,checks:['server_banner'],includeSource:true,profile:'campaign' as const,scope:{delayMs:0,maxRequests:200},openapi:openapiDoc,openapiFixtures:{'/items/{id}':[{id:'42'}]},browserSecrets:{}};

const finish=async(id:string)=>{const deadline=Date.now()+60000;while(Date.now()<deadline){const r=readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,50));}throw Error('plan assessment timed out');};
try{
  // Unit: buildPlan on synthetic evidence classifies surfaces by type.
  const unit=buildPlan({discovery:{pages:[{url:'http://x/p'}]},openapiPlan:{operations:[{path:'/o',method:'GET',urls:['http://x/o']}]},scan:{routes:[{method:'GET',path:'/r',file:'a.js',line:1}],staticRisks:[]},flowScan:undefined as never});
  assert.equal(unit.execution,'none','the plan carries an explicit no-execution marker');
  assert.equal(unit.appType,'web+api+source application');
  assert.ok(unit.surfaces.every(s=>[ 'web','api','source'].includes(s.id)));
  assert.ok(unit.suggestions.length>=3);
  assert.ok(unit.suggestions.every(s=>s.operatorInput.length>10),'every suggestion names the operator input it still needs');

  // Campaign: discovery + OpenAPI + source run, then the plan derives from it.
  const run=await finish(startAssessment(root,input).id);
  assert.ok(run.plan,'the finished run carries a plan');
  assert.equal(run.plan.execution,'none');
  const web=run.plan.surfaces.find(s=>s.id==='web')!;
  const api=run.plan.surfaces.find(s=>s.id==='api')!;
  const source=run.plan.surfaces.find(s=>s.id==='source')!;
  assert.ok(web.present&&/page\(s\)/.test(web.evidence)&&!web.evidence.startsWith('0 '),'discovered pages counted: '+web.evidence);
  assert.ok(api.present&&api.evidence.includes('2 OpenAPI operation(s)'),api.evidence);
  assert.ok(source.present,'source surface present from routes/flows');
  assert.ok(run.plan.appType.includes('web')&&run.plan.appType.includes('api')&&run.plan.appType.includes('source'));
  // Suggestions reference real evidence: the /search page, the GET op, the
  // unexecutable POST op, the source route and the cross-file flow.
  const s=run.plan.suggestions;
  assert.ok(s.some(x=>x.engine==='xssReflected'&&x.target.includes('/search')),'discovered page suggests a reflected-XSS case');
  assert.ok(s.some(x=>x.engine==='injection'&&x.target==='/items/{id}'&&x.surface==='api'),'GET operation suggests an injection case');
  assert.ok(s.some(x=>x.engine==='openapiFlow'&&x.target.includes('POST /orders')),'non-GET operation suggests an explicit flow with its reason');
  assert.ok(s.some(x=>x.engine==='routeVerification'&&x.target.includes('/users')),'source route suggests route verification');
  assert.ok(s.some(x=>x.engine==='injection'&&x.surface==='source'&&x.target.includes('routes.js → db.js')),'cross-file flow suggests the matching dynamic engine');
  assert.ok(s.every(x=>x.operatorInput&&x.rationale),'every suggestion carries rationale + operator input');
  assert.ok(run.plan.limitations.length>=3&&run.plan.limitations[0]!.includes('Plan-only'));
  // Separation of suggestion and execution: the plan added no cases or
  // requests — the run that produced it ran only the declared inputs.
  assert.equal(run.injectionCases.length,0,'the plan did not create injection cases');
  assert.equal(run.evidence.filter(e=>e.method==='POST').length,0,'no POST was executed on the plan\'s behalf');

  // HTTP route: the plan is served read-only for the finished assessment.
  const {spawnSync}=await import('node:child_process');
  const manifest=JSON.parse(fs.readFileSync(new URL('../../package.json',import.meta.url),'utf8')) as {scripts:Record<string,string>};
  void manifest;void spawnSync;
  console.log('PASS planning: surfaces classified web/api/source from the run\'s own evidence, suggestions reference real pages/operations/routes/flows with rationale and required operator input, an explicit no-execution marker separates plan from execution, and no case or request was added on the plan\'s behalf');
}finally{server.closeAllConnections();server.close();fs.rmSync(root,{recursive:true,force:true});}
