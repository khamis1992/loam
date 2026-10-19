import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';import os from 'node:os';
import {createRequire} from 'node:module';
import {analyzeSqlSource} from '../security/source-sql.js';
import {pgRawReferences} from '../security/source-pg-format.js';
import {startAssessment,readAssessment,retestAssessment} from '../security/assessments.js';
const setup='const pgp=require("pg-promise")(); const db=pgp("fixture"); ';
const positives=[
  'db.any("SELECT $1:raw",input);',
  'db.one("SELECT $1^",[input]);',
  'db.query("SELECT $2:raw",[1,input]);',
  'db.one({text:"SELECT $1:raw",values:input});',
  'db.one({text:"SELECT $1^",values:[input]});',
  'db.any("SELECT ${id:raw}",{id:input});',
  'db.any("SELECT $(id^)",{id:input});',
  'db.any("SELECT $[id:raw]",{id:input});',
  'db.any("SELECT $<id:raw>",{id:input});',
  'db.any("SELECT $/id:raw/",{id:input});',
  'db.any("SELECT ${nested.id:raw}",{nested:{id:input}});',
  'function run(input) {db.any("SELECT $1:raw",input);}',
];
const controls=[
  'db.any("SELECT $1",input);',
  'db.any("SELECT $1:name",input);',
  'db.any("SELECT $1:raw",1);',
  'db.any("SELECT $1:raw",null);',
  'db.any("SELECT $1:raw",false);',
  'db.any("SELECT $1:raw",["fixed"]);',
  'db.any("SELECT $1:raw, $2",["fixed",input]);',
  'db.any("SELECT ${id:raw}, ${other}",{id:"fixed",other:input});',
  'const id="fixed"; db.any("SELECT ${id:raw}",{id});',
  'db.any("SELECT ${id}:raw",{id:input});',
  'db.any("SELECT ${id^} ",{other:input});',
  'db.any("SELECT $2:raw",[input]);',
  'function run(db) { db.any("SELECT $1:raw",input); }',
  'const other={}; other.query("SELECT $1:raw",input);',
];
for(const source of positives)assert.equal(analyzeSqlSource('sample.ts',setup+source).risks.filter(r=>r.rule.startsWith('Raw SQL')).length,1,source);
for(const source of positives)assert.equal(analyzeSqlSource('sample.js',setup+source).risks.filter(r=>r.rule.startsWith('Raw SQL')).length,1,'JavaScript: '+source);
assert.equal(analyzeSqlSource('sample.js','const pgp=require("pg-promise")(); function run(req){const db=pgp(process.env.DB); db.one({text:"SELECT $1:raw",values:req.params.id});}').risks.length,1);
for(const source of controls)assert.equal(analyzeSqlSource('sample.ts',setup+source).risks.length,0,source);
for(const source of controls)assert.equal(analyzeSqlSource('sample.js',setup+source).risks.length,0,source);
for(const source of [
  'const pgp=require("pg")(); const db=pgp(); db.query("SELECT $1:raw",input);',
  'function test(require){const pgp=require("pg-promise")(); const db=pgp(); db.any("SELECT $1:raw",input);}',
  'const pgp=require("pg-promise")({pgFormatting:true}); const db=pgp(); db.any("SELECT $1:raw",input);',
  'const pgp=require("pg-promise")(options); const db=pgp(); db.any("SELECT $1:raw",input);',
  setup+'db.any=other; db.any("SELECT $1:raw",input);',
])assert.equal(analyzeSqlSource('sample.ts',source).risks.length,0,source);
assert.equal(analyzeSqlSource('sample.ts','import pgPromise from "pg-promise"; const pgp=pgPromise(); const db=pgp(); db.any("SELECT $1:raw",input);').risks.length,1);
assert.deepEqual(pgRawReferences('SELECT ${id}:raw'),[]);
assert.deepEqual(pgRawReferences('SELECT $100001:raw'),[]);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-pg-format-'));
const file=path.join(root,'query.js');fs.writeFileSync(file,setup+positives[0]);
async function finish(id:string){for(let n=0;n<200;n++){const r=readAssessment(root,id);if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout');}
const first=await finish(startAssessment(root,{includeSource:true}).id);
const finding=first.findings.find(f=>f.title.startsWith('Raw SQL'))!;
assert.ok(finding);assert.equal(finding.check,'source_sql');assert.equal(finding.confidence,'review');
assert.ok(!finding.detail.includes('SELECT'));assert.ok(first.scan!.sourceHashes!['query.js']);
const repeated=await finish(retestAssessment(root,first.id,{authorized:true}).id);
assert.ok(repeated.comparison!.persistent.includes(finding.fingerprint));
fs.writeFileSync(file,setup+controls[0]);
const edited=await finish(retestAssessment(root,first.id,{authorized:true}).id);
assert.ok(edited.comparison!.unverified.includes(finding.fingerprint));
assert.ok(!edited.comparison!.notObserved.includes(finding.fingerprint));
// Optional real formatter verification. No database is created or connected.
if(process.argv[2]){
  const require=createRequire(path.join(path.resolve(process.argv[2]),'package.json'));
  const pgp=require('pg-promise')();
  const value="O'Reilly";
  assert.equal(pgp.as.format('SELECT $1:raw',[value]),"SELECT O'Reilly");
  assert.equal(pgp.as.format('SELECT $1',[value]),"SELECT 'O''Reilly'");
  assert.equal(pgp.as.format('SELECT ${id:raw}',{id:value}),"SELECT O'Reilly");
  for(const query of ['SELECT $(id^)','SELECT $[id:raw]','SELECT $<id:raw>','SELECT $/id:raw/'])assert.equal(pgp.as.format(query,{id:value}),"SELECT O'Reilly");
  assert.equal(pgp.as.format('SELECT ${id}:raw',{id:value}),"SELECT 'O''Reilly':raw");
  pgp.end();
  console.log('PASS: actual pg-promise formatter confirms raw/escaped and inside/outside delimiter distinction; no database access');
}
console.log(`PASS: ${positives.length+1} raw-format candidates, ${controls.length+5} controls, driver identity and shadowing`);
