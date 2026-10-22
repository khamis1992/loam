import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startAssessment,readAssessment} from '../security/assessments.js';
import {traceSourceFlows} from '../security/source-flow.js';

// Guarded workspace: the same cross-file chain as the dirty one, but an
// early-return validator guard runs before the sink.
const guarded=fs.mkdtempSync(path.join(os.tmpdir(),'loam-flow-guarded-'));
fs.writeFileSync(path.join(guarded,'routes.js'),[
  'const { lookup } = require("./db");',
  'function isValidId(value) { return /^\d+$/.test(value); }',
  'app.get("/search", function (req, res) {',
  '  const q = req.query.q;',
  '  if (!isValidId(q)) return;',
  '  lookup(q);',
  '});',
].join('\n'));
fs.writeFileSync(path.join(guarded,'db.js'),[
  'function lookup(q) {',
  '  return db.query("SELECT * FROM users WHERE id=" + q);',
  '}',
  'module.exports = { lookup };',
].join('\n'));
// Unguarded control: the identical chain without the guard.
const dirty=fs.mkdtempSync(path.join(os.tmpdir(),'loam-flow-dirty-'));
fs.writeFileSync(path.join(dirty,'routes.js'),[
  'const { lookup } = require("./db");',
  'function isValidId(value) { return /^\d+$/.test(value); }',
  'app.get("/search", function (req, res) {',
  '  const q = req.query.q;',
  '  lookup(q);',
  '});',
].join('\n'));
fs.writeFileSync(path.join(dirty,'db.js'),path.join(guarded,'db.js')&&fs.readFileSync(path.join(guarded,'db.js'),'utf8'));
// Weak guard: the guard validates but does not exit early — the flow must
// survive because the value still reaches the sink unvalidated.
const weak=fs.mkdtempSync(path.join(os.tmpdir(),'loam-flow-weak-'));
fs.writeFileSync(path.join(weak,'routes.js'),[
  'const { lookup } = require("./db");',
  'function isValidId(value) { return /^\d+$/.test(value); }',
  'app.get("/search", function (req, res) {',
  '  const q = req.query.q;',
  '  if (!isValidId(q)) { res.status(400); }',
  '  lookup(q);',
  '});',
].join('\n'));
fs.writeFileSync(path.join(weak,'db.js'),fs.readFileSync(path.join(guarded,'db.js'),'utf8'));

const finish=async(root:string,id:string)=>{const deadline=Date.now()+60000;while(Date.now()<deadline){const r=readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,50));}throw Error('flow-guards assessment timed out');};
try{
  const dirtyScan=traceSourceFlows(dirty);
  assert.equal(dirtyScan.flows.length,1,'the unguarded chain reports one flow');
  assert.equal(dirtyScan.flows[0]!.sink.kind,'sql_like');
  assert.equal(dirtyScan.guardCuts,0);

  const guardedScan=traceSourceFlows(guarded);
  assert.equal(guardedScan.flows.length,0,'the early-return guard cuts the flow');
  assert.ok(guardedScan.guardCuts>=1,'the guard cut is counted: '+guardedScan.guardCuts);

  const weakScan=traceSourceFlows(weak);
  assert.equal(weakScan.flows.length,1,'a non-exiting guard does not cut the flow');

  // Campaign wiring: a guarded workspace produces no source_flow findings.
  const run=await finish(guarded,startAssessment(guarded,{includeSource:true,authorized:true}).id);
  assert.ok(!run.findings.some(f=>f.check==='source_flow'),'no flow findings for the guarded campaign');
  assert.ok(run.flowScan&&run.flowScan.flows.length===0);
  const dirtyRun=await finish(dirty,startAssessment(dirty,{includeSource:true,authorized:true}).id);
  const flowFinding=dirtyRun.findings.find(f=>f.check==='source_flow');
  assert.ok(flowFinding,'the unguarded campaign reports the flow');
  assert.equal(flowFinding.confidence,'review');
  console.log('PASS flow guards: an early-return validator guard cuts the cross-file flow position-aware, a non-exiting guard does not, cuts are counted, and the campaign emits flow findings only for the unguarded chain');
}finally{fs.rmSync(guarded,{recursive:true,force:true});fs.rmSync(dirty,{recursive:true,force:true});fs.rmSync(weak,{recursive:true,force:true});}
