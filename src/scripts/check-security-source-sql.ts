import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {inspectSqlConstruction,analyzeSqlSource} from '../security/source-sql.js';
import {startAssessment,readAssessment,retestAssessment} from '../security/assessments.js';
const candidates=[
  'db.query("SELECT * FROM users WHERE id=" + req.params.id);',
  'db.execute(`UPDATE users SET name=${input}`);',
  'db.query({text: `SELECT * FROM records WHERE owner=${owner}`, values: []});',
  'db.execute({sql: "DELETE FROM records WHERE id=" + input});',
  'knex.raw("SELECT * FROM " + table);',
  'prisma.$queryRawUnsafe(queryFromCaller);',
  'prisma.$executeRawUnsafe(`DELETE FROM records WHERE id=${input}`);',
  'db.query(\n  ("SELECT * FROM records WHERE id=" + input) as string\n);',
  'const sql = "SELECT * FROM users WHERE id=" + req.params.id; db.query(sql);',
  'function load(input:string) { const prefix="SELECT * FROM users WHERE id="; const sql=prefix+input; const alias=sql; db.execute(alias); }',
  'const sql=`DELETE FROM records WHERE id=${input}`; db.query({text:sql});',
  'const sql="static"; { const sql="SELECT "+input; db.query(sql); }',
  'var sql="SELECT "+input; db.query(sql);',
  'let sql="SELECT "+input; db.query(sql);',
  'db.get("SELECT * FROM records WHERE id="+input);',
  'var sql="SELECT * FROM records WHERE id="+input; db.any(sql);',
  'conn.prepare("SELECT * FROM records WHERE id="+input);',
];
const controls=[
  'db.query("SELECT * FROM users WHERE id=$1", [req.params.id]);',
  'db.execute("SELECT * FROM users WHERE id=?", [input]);',
  'db.query({text:"SELECT * FROM users WHERE id=$1", values:[input]});',
  'knex.raw("SELECT * FROM ?? WHERE id=?", [table, input]);',
  'prisma.$queryRaw`SELECT * FROM records WHERE id=${input}`;',
  'prisma.$queryRawUnsafe("SELECT * FROM records WHERE id=$1", input);',
  'db.query("SELECT " + "1");',
  'db.query(`SELECT ${1}`);',
  '// db.query("SELECT " + input);',
  'const example = \'db.query("SELECT " + input)\';',
  'search.query("search:" + input);',
  'const sql="SELECT * FROM users WHERE id=$1"; db.query(sql,[input]);',
  'const sql="SELECT "+input; function load(sql:string) { db.query(sql); }',
  'const sql="SELECT "+input; { const sql="SELECT 1"; db.query(sql); }',
  'db.query(sql); const sql="SELECT "+input;',
  'let sql="SELECT "+input; sql="SELECT 1"; db.query(sql);',
  'const sql="SELECT "+input; function load() { db.query(sql); }',
  'const a=b; const b=a; db.query(a);',
  'const sql="SELECT "+input; try {} catch(sql) { db.query(sql); }',
  'const sql="SELECT "+input; function load({sql}:any) { db.query(sql); }',
  'let sql="SELECT "+input; function change(){sql="SELECT 1";} change(); db.query(sql);',
  'let sql="SELECT "+input; [sql]=["SELECT 1"]; db.query(sql);',
  'let sql="SELECT "+input; ({sql}=other); db.query(sql);',
  'let sql="SELECT "+input; sql++; db.query(sql);',
  'let sql="SELECT "+input; for(sql of queries) { db.query(sql); }',
  'let sql="SELECT "+input; sql += " LIMIT 1"; db.query(sql);',
  'let sql="SELECT 1"; {let sql="other"; sql=input;} db.query(sql);',
  'db.get("SELECT * FROM records WHERE id=?",input);',
  'db.any("SELECT * FROM records WHERE id=$1",[input]);',
  'conn.prepare("SELECT * FROM records WHERE id=?").get(input);',
  'app.get("/users/"+input,handler);',
  'array.map(item=>item+input);',
];
for(const source of candidates)assert.equal(inspectSqlConstruction('fixture.ts',source).length,1,source);
for(const source of controls)assert.equal(inspectSqlConstruction('fixture.ts',source).length,0,source);
for(const filename of ['src/db/query.ts','src/db/query.js','query.mjs','query.cjs','component.tsx']){
  assert.equal(inspectSqlConstruction(filename,candidates[8]!).length,1,filename);
}
assert.deepEqual(inspectSqlConstruction('fixture.py',candidates[0]!),[]);
assert.deepEqual(inspectSqlConstruction('broken.ts','db.query('),[]);
// Repeated aliases must not expand exponentially or hang a source campaign.
const repeatedAliases=['const q0="SELECT ";',...Array.from({length:30},(_,i)=>`const q${i+1}=q${i}+q${i};`),'db.query(q30+input);'].join('\n');
assert.ok(inspectSqlConstruction('bounded.ts',repeatedAliases).length<=1);
assert.equal(analyzeSqlSource('bounded.ts',repeatedAliases).status,'limit_reached');
const deepAliases=['const q0="SELECT "+input;',...Array.from({length:40},(_,i)=>`const q${i+1}=q${i};`),'db.query(q40);'].join('\n');
assert.equal(analyzeSqlSource('deep.ts',deepAliases).status,'limit_reached');
assert.equal(analyzeSqlSource('prefix.ts',`db.query("${' '.repeat(4097)}"+"SELECT "+input);`).status,'limit_reached');
assert.equal(analyzeSqlSource('normal.ts',candidates[8]!).status,'analyzed');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-source-sql-'));
fs.writeFileSync(path.join(root,'query.ts'),'// fixture\n'+candidates[8]);
async function finish(id:string){for(let n=0;n<300;n++){const run=readAssessment(root,id);if(run.status!=='running')return run;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout');}
const first=await finish(startAssessment(root,{includeSource:true}).id);
const finding=first.findings.find(f=>f.check==='source_sql')!;
assert.ok(finding);assert.equal(finding.target,'query.ts:2');assert.equal(finding.confidence,'review');
assert.ok(first.scan!.sourceHashes!['query.ts']);
assert.ok(!finding.detail.includes('users'),'Query contents must not appear in evidence');
const repeated=await finish(retestAssessment(root,first.id,{authorized:true}).id);
assert.ok(repeated.comparison!.persistent.includes(finding.fingerprint));
fs.writeFileSync(path.join(root,'query.ts'),'// fixture\n'+controls[0]);
const repaired=await finish(retestAssessment(root,first.id,{authorized:true}).id);
assert.ok(!repaired.findings.some(f=>f.check==='source_sql'));
assert.ok(repaired.comparison!.unverified.includes(finding.fingerprint));
assert.ok(!repaired.comparison!.notObserved.includes(finding.fingerprint),'Static disappearance cannot confirm runtime repair');
console.log(`PASS: ${candidates.length} dynamic SQL candidates, ${controls.length} controls, source hashes/locations, review confidence, persistent and inconclusive repair retests`);
