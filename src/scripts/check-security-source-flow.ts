import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startAssessment,readAssessment} from '../security/assessments.js';
import {traceSourceFlows} from '../security/source-flow.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-security-flow-'));
fs.writeFileSync(path.join(root,'routes.js'),[
  'const { getUser, renderProfile } = require("./db");',
  'const { sanitize } = require("./mw");',
  'app.get("/user", function handler(req, res) {',
  '  const id = req.query.id;',
  '  getUser(id);',
  '});',
  'app.get("/profile", function (req, res) {',
  '  sanitize(req);',
  '  renderProfile(req.query.name);',
  '});',
].join('\n'));
fs.writeFileSync(path.join(root,'db.js'),[
  'function getUser(id) {',
  '  const sql = "SELECT * FROM users WHERE id=" + id;',
  '  return db.query(sql);',
  '}',
  'function renderProfile(name) {',
  '  const box = document.createElement("div");',
  '  box.innerHTML = name;',
  '  return box;',
  '}',
  'module.exports = { getUser, renderProfile };',
].join('\n'));
fs.writeFileSync(path.join(root,'mw.js'),[
  'function sanitize(req) {',
  '  logger.exec("audit " + req.url);',
  '}',
  'module.exports = { sanitize };',
].join('\n'));
fs.writeFileSync(path.join(root,'safe.js'),[
  'const { getUser } = require("./db");',
  'app.get("/fixed", function (req, res) {',
  '  const id = "constant";',
  '  getUser(id);',
  '});',
].join('\n'));
fs.writeFileSync(path.join(root,'broken.ts'),'function broken( {');

try{
  const scan=traceSourceFlows(root);
  assert.equal(scan.filesScanned,4,'four parseable files scanned (the broken one is a parse error)');
  assert.ok(scan.importsResolved>=3,'imports resolved across files: '+scan.importsResolved);
  assert.equal(scan.coverage.parseErrors,1,'the broken file is a parse error');
  assert.equal(scan.flows.length,3,'exactly three flows: query sink, html sink, exec sink');
  const sqlFlow=scan.flows.find(f=>f.sink.kind==='sql_like')!;
  assert.ok(sqlFlow,'a SQL-like flow exists');
  assert.equal(sqlFlow.source.file,'routes.js','the reported source stays the original request entry');
  assert.match(sqlFlow.source.what,/req/,'the source is a request-shaped entry (variable or middleware parameter)');
  assert.equal(sqlFlow.sink.file,'db.js','the sink lives in another file');
  assert.ok(sqlFlow.hops.some(h=>h.file==='db.js'&&/getUser\(arg 0\) ← routes\.js/.test(h.what)),'the hop names the cross-file parameter with its origin');
  const htmlFlow=scan.flows.find(f=>f.sink.kind==='html_like')!;
  assert.ok(htmlFlow&&htmlFlow.sink.file==='db.js');
  const cmdFlow=scan.flows.find(f=>f.sink.kind==='command_like')!;
  assert.ok(cmdFlow&&cmdFlow.sink.file==='mw.js','middleware-style req passing reaches the exec sink');
  assert.ok(!scan.flows.some(f=>f.source.file==='safe.js'),'the constant-only file produces no flow');

  const started=startAssessment(root,{includeSource:true,authorized:true});
  const deadline=Date.now()+60000;let run:any;
  while(Date.now()<deadline){run=readAssessment(root,started.id);if(run.status!=='running')break;await new Promise(r=>setTimeout(r,50));}
  assert.equal(run.status,'partial','parse error keeps the run partial');
  assert.ok(run.flowScan&&run.flowScan.flows.length===3);
  const flowFindings=run.findings.filter((f:any)=>f.check==='source_flow');
  assert.equal(flowFindings.length,3);
  assert.ok(flowFindings.every((f:any)=>f.confidence==='review'),'static flows stay review-confidence');
  assert.ok(flowFindings.some((f:any)=>f.target.startsWith('db.js:')&&/SQL-like/.test(f.title)));
  assert.ok(flowFindings.some((f:any)=>f.target.startsWith('mw.js:')&&f.severity==='high'&&/command-like/.test(f.title)));
  const sarifTargets=(run.findings.filter((f:any)=>f.check==='source_flow').map((f:any)=>f.target));
  assert.ok(sarifTargets.every((t:string)=>!/^[a-zA-Z]:/.test(t)),'targets stay workspace-relative');
  console.log('PASS source flow: cross-file taint via imports (query/html sinks in db.js from routes.js), middleware req passing into an exec sink in mw.js, no flow for constants, parse errors surfaced, review-confidence findings wired into the campaign');
}finally{fs.rmSync(root,{recursive:true,force:true});}
