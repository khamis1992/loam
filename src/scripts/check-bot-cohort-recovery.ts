import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

// Dry-run fixtures live outside the real evidence tree; no server calls/tasks.
const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-cohort-recovery-'));
const runner=path.resolve('src/scripts/check-bot-pinned-cohort.ts');
const tsx=path.resolve('node_modules/tsx/dist/cli.mjs');
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const runtime='a'.repeat(64);
const cases=[['quote','check-bot-independent-installed.ts'],['bookings','check-bot-installed-bookings.ts'],['tickets','check-bot-tickets-fresh-full-gate.ts']];
const plan=Array.from({length:3},(_,i)=>cases.map(([kind,script])=>({round:i+1,kind,script}))).flat();
fs.mkdirSync(path.join(root,'docs/evidence'),{recursive:true});
fs.mkdirSync(path.join(root,'src/scripts'),{recursive:true});
const fixtureScript='// fixture, never executed';
fs.writeFileSync(path.join(root,'src/scripts/check-bot-independent-installed.ts'),fixtureScript);
const original=JSON.stringify({taskId:'task_fixture',error:'transport disconnected',provenance:{promptSha256:'prompt'}});
fs.writeFileSync(path.join(root,'docs/evidence/original.json'),original);
const prior={runtimeSha256:runtime,complete:false,plan,attempts:[{...plan[0],taskId:'task_fixture',report:'docs/evidence/original.json',reportSha256:sha(original),scriptSha256:sha(fixtureScript),pass:false,error:'transport disconnected'}]};
const observed={taskId:'task_fixture',observationMode:'reattached',task:{status:'done'},pass:true,independentProbe:{pass:true},provenance:{runtimeSha256:runtime,runtimeSha256After:runtime,promptSha256:'prompt'}};
const write=(name:string,value:unknown)=>fs.writeFileSync(path.join(root,'docs/evidence',name),JSON.stringify(value));
const run=()=>spawnSync(process.execPath,[tsx,runner,'--collect-all',`--runtime-sha256=${runtime}`,'--continue-from=prior.json','--resolved-observation=observed.json'],{cwd:root,encoding:'utf8',windowsHide:true,timeout:15000});
write('prior.json',prior);write('observed.json',observed);
const good=run();assert.equal(good.status,0,good.stderr);
const result=JSON.parse(good.stdout);assert.equal(result.inheritedTrials,1);assert.equal(result.plan.length,8);assert.deepEqual(result.plan[0],plan[1]);
for(const [label,changed] of [
 ['live task',{...observed,task:{status:'running'}}],
 ['wrong task',{...observed,taskId:'task_other'}],
 ['changed runtime',{...observed,provenance:{...observed.provenance,runtimeSha256:'b'.repeat(64)}}],
 ['changed request',{...observed,provenance:{...observed.provenance,promptSha256:'other'}}],
 ['missing probe',{...observed,independentProbe:{pass:false}}],
 ['missing terminal result',{...observed,pass:false}],
] as const){write('observed.json',changed);assert.notEqual(run().status,0,label);}
write('observed.json',{...observed,pass:false,task:{status:'error'},error:'real task failure'});
assert.equal(run().status,0,'A failed terminal task remains in the cohort instead of being retried');
write('observed.json',observed);
fs.appendFileSync(path.join(root,'docs/evidence/original.json'),' ');
assert.notEqual(run().status,0,'Changed original evidence must reject continuation');
assert.equal(fs.readdirSync(path.join(root,'docs/evidence')).length,3,'Dry runs cannot create trial reports');
console.log('PASS cohort recovery: eight remaining tasks, terminal failures retained, live/mismatched/changed evidence rejected, no tasks started');
