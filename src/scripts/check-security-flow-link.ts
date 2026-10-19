import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {startAssessment,readAssessment} from '../security/assessments.js';
import {traceSourceFlows} from '../security/source-flow.js';

const users=[{name:'alice'},{name:'bob'}];
let fixed=false;
const server=http.createServer((req,res)=>{
  const url=new URL(req.url!,'http://localhost');
  const json=(status:number,payload:unknown)=>{res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(payload));};
  const sqlRows=(name:string)=>{
    if(fixed)return users.filter(u=>u.name===name.replace(/'/g,"''"));
    const taut=/' AND '1'='1$/.exec(name),fals=/' AND '1'='2$/.exec(name);
    if(taut)return users.filter(u=>u.name===name.slice(0,taut.index));
    if(fals)return [];
    return users.filter(u=>u.name===name);
  };
  if(url.pathname==='/'&&req.method==='GET'){res.setHeader('content-type','text/html').end('<!doctype html><title>fixture</title>');return;}
  if(url.pathname==='/search'&&req.method==='GET')return json(200,{rows:sqlRows(url.searchParams.get('q')??'')});
  res.writeHead(404).end();
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const target='http://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;

// Dirty workspace: the request value crosses files into a SQL-like sink.
const dirty=fs.mkdtempSync(path.join(os.tmpdir(),'loam-flow-dirty-'));
fs.writeFileSync(path.join(dirty,'routes.js'),[
  'const { lookup } = require("./db");',
  'app.get("/search", function (req, res) {',
  '  const q = req.query.q;',
  '  lookup(q);',
  '});',
].join('\n'));
fs.writeFileSync(path.join(dirty,'db.js'),[
  'function lookup(q) {',
  '  return db.query("SELECT * FROM users WHERE name=" + q);',
  '}',
  'module.exports = { lookup };',
].join('\n'));
// Sanitized workspace: the same chain, but the value passes a sanitizer first.
const clean=fs.mkdtempSync(path.join(os.tmpdir(),'loam-flow-clean-'));
fs.writeFileSync(path.join(clean,'routes.js'),[
  'const { lookup } = require("./db");',
  'function escapeHtml(value) { return String(value).replace(/[&<>"]/g, ""); }',
  'app.get("/search", function (req, res) {',
  '  const safe = escapeHtml(req.query.q);',
  '  lookup(safe);',
  '});',
].join('\n'));
fs.writeFileSync(path.join(clean,'db.js'),[
  'function lookup(q) {',
  '  return db.query("SELECT * FROM users WHERE name=\'" + q + "\'");',
  '}',
  'module.exports = { lookup };',
].join('\n'));

const finish=async(root:string,id:string)=>{const deadline=Date.now()+60000;while(Date.now()<deadline){const r=readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,50));}throw Error('flow-link assessment timed out');};
try{
  // Unit: the sanitizer cut works directly on the source-flow engine.
  const dirtyScan=traceSourceFlows(dirty);
  assert.equal(dirtyScan.flows.length,1,'the dirty chain reports one flow');
  assert.equal(dirtyScan.flows[0]!.sink.kind,'sql_like');
  assert.equal(dirtyScan.sanitized,0);
  const cleanScan=traceSourceFlows(clean);
  assert.equal(cleanScan.flows.length,0,'the sanitized chain is cut');
  assert.equal(cleanScan.sanitized,1,'the sanitizer call is counted');

  // Campaign: dynamic injection proof on /search plus includeSource, linked.
  const input={target,authorized:true,checks:['server_banner'],includeSource:true,profile:'campaign' as const,scope:{delayMs:0,maxRequests:200},injection:[{id:'searchSql',kind:'sql' as const,method:'GET' as const,path:'/search',field:'q',baselineRef:'baseline'}],businessSecrets:{baseline:'alice'}};
  const run=await finish(dirty,startAssessment(dirty,input).id);
  assert.equal(run.status,'completed','the conclusive injection proof and clean source scan complete the run');
  const injectionFinding=run.findings.find(f=>f.check.startsWith('injection_')&&f.verdict==='finding');
  assert.ok(injectionFinding,'the dynamic injection proof exists: '+JSON.stringify(run.findings.map(f=>f.check)));
  assert.ok(run.flowScan&&run.flowScan.flows.length===1);
  assert.equal(run.flowScan.sanitized,0);
  assert.ok(run.flowScan.links&&run.flowScan.links.length===1,'exactly one static→dynamic link');
  const link=run.flowScan.links[0]!;
  assert.equal(link.route,'/search','the link names the shared route');
  assert.equal(link.check,injectionFinding.check,'the link joins the flow sink with the live finding');
  assert.ok(link.url.startsWith(target)&&link.url.includes('/search'));
  const flowFinding=run.findings.find(f=>f.check==='source_flow');
  assert.ok(flowFinding&&flowFinding.detail.includes('Dynamic evidence on the same route'),'the static finding carries the dynamic evidence note');
  assert.match(flowFinding.detail,/injection_/);
  assert.equal(flowFinding.confidence,'review','linked or not, a static flow stays review-confidence');
  fixed=true;
  const second=await finish(dirty,(await import('../security/assessments.js')).retestAssessment(dirty,run.id,{authorized:true,businessSecrets:{baseline:'alice'}}).id);
  assert.ok(second.comparison?.notObserved.includes(injectionFinding.fingerprint));
  assert.equal(second.flowScan?.links?.length??0,0,'the repaired endpoint leaves no dynamic finding to link');
  console.log('PASS flow link: sanitizer cut removes the sanitized chain while the dirty chain flows, a live injection proof on the same route is joined to the static flow, the link note rides the finding, and a repaired retest clears the link');
}finally{server.closeAllConnections();server.close();fs.rmSync(dirty,{recursive:true,force:true});fs.rmSync(clean,{recursive:true,force:true});}
