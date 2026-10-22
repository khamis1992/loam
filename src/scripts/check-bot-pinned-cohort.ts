import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';

const expected=process.argv.find(a=>a.startsWith('--runtime-sha256='))?.split('=')[1]?.toLowerCase();
const collectAll=process.argv.includes('--collect-all');
const continueFrom=process.argv.find(a=>a.startsWith('--continue-from='))?.slice('--continue-from='.length);
const resolvedObservation=process.argv.find(a=>a.startsWith('--resolved-observation='))?.slice('--resolved-observation='.length);
assert.equal(Boolean(continueFrom),Boolean(resolvedObservation),'Continuation requires both prior cohort and resolved observation filenames');
assert.ok(expected&&/^[a-f0-9]{64}$/.test(expected),'Provide the exact installed runtime SHA256');
const cases=[['quote','check-bot-independent-installed.ts'],['bookings','check-bot-installed-bookings.ts'],['tickets','check-bot-tickets-fresh-full-gate.ts']] as const;
const plan=Array.from({length:3},(_,round)=>cases.map(([kind,script])=>({round:round+1,kind,script}))).flat();
const evidencePath=(name:string)=>{assert.match(name,/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/);return path.join('docs/evidence',name);};
const hash=(file:string)=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let inherited:any[]=[];let continuation:Record<string,unknown>|undefined;
if(continueFrom&&resolvedObservation){
 const priorPath=evidencePath(continueFrom),observedPath=evidencePath(resolvedObservation);
 const prior=JSON.parse(fs.readFileSync(priorPath,'utf8')),observed=JSON.parse(fs.readFileSync(observedPath,'utf8'));
 assert.equal(prior.runtimeSha256,expected);assert.equal(prior.complete,false);assert.deepEqual(prior.plan,plan);
 assert.ok(prior.attempts.length>0&&prior.attempts.length<=plan.length);
 inherited=structuredClone(prior.attempts);
 for(const [index,attempt] of inherited.entries()){
  assert.equal(attempt.round,plan[index]!.round);assert.equal(attempt.kind,plan[index]!.kind);assert.equal(attempt.script,plan[index]!.script);
  assert.equal(hash(path.join('src/scripts',attempt.script)),attempt.scriptSha256,'Trial script changed since initial attempt');
  assert.equal(hash(evidencePath(path.basename(attempt.report))),attempt.reportSha256,'Original evidence changed');
 }
 const last=inherited.at(-1)!;
 const original=JSON.parse(fs.readFileSync(evidencePath(path.basename(last.report)),'utf8'));
 assert.equal(observed.taskId,last.taskId);assert.ok(observed.observationMode,'Must use reattached observation, not a new task');
 assert.equal(observed.provenance.promptSha256,original.provenance.promptSha256,'Observed task requirements changed');
 assert.equal(observed.provenance.runtimeSha256.toLowerCase(),expected);
 assert.ok(['done','error','cancelled'].includes(observed.task?.status),'Observation is not terminal; do not launch remaining trials');
 if(observed.pass){assert.equal(observed.task.status,'done');assert.ok(observed.independentProbe?.pass);assert.equal(observed.provenance.runtimeSha256After.toLowerCase(),expected);}
 else assert.ok(observed.error,'Missing final observation outcome');
 last.resolvedObservation={report:observedPath,sha256:hash(observedPath),pass:observed.pass===true,error:observed.error};
 last.pass=observed.pass===true;
 continuation={priorCohort:priorPath,priorSha256:hash(priorPath),preservesOriginalObserverFailure:true};
}
if(!process.argv.includes('--run')){console.log(JSON.stringify({status:'prepared; no tasks started',runtimeSha256:expected,plan:plan.slice(inherited.length),inheritedTrials:inherited.length,stopOnFirstFailure:!collectAll},null,2));process.exit(0);}
assert.ok(process.env.LOCALAPPDATA);
const runtime=path.join(process.env.LOCALAPPDATA,'Programs/loam/resources/app/dist/server.cjs');
const entry=path.resolve('node_modules/tsx/dist/cli.mjs');assert.ok(fs.existsSync(entry));
const runId=Date.now();const output=`docs/evidence/bot-pinned-cohort-${runId}.json`;
const logRoot=`output/verification/bot-pinned-cohort-${runId}`;fs.mkdirSync(logRoot,{recursive:true});
const evidence:Record<string,any>={startedAt:new Date().toISOString(),runtimeSha256:expected,plan,collectAll,continuation,attempts:inherited,complete:false,pass:false,caveat:'Only a complete fixed-build cohort supports a descriptive cohort pass rate; neither an interrupted cohort nor these tasks establish external-agent parity. No failed task is automatically repaired or retried.'};
const save=()=>fs.writeFileSync(output,JSON.stringify(evidence,null,2));save();
const idle=async()=>{const r=await fetch('http://127.0.0.1:3939/api/queue',{signal:AbortSignal.timeout(15000)});assert.ok(r.ok);const q=await r.json() as any;assert.equal(q.actives.length+q.queued.length,0,'Existing active task: stop cohort, never cancel or restart it');};
try{
 assert.equal(hash(runtime),expected);await idle();
 for(const item of plan.slice(inherited.length)){
  assert.equal(hash(runtime),expected,'Installed build changed');await idle();
  const reportName=`bot-cohort-${runId}-${item.round}-${item.kind}.json`;
  let reportPath=item.kind==='quote'?path.join('docs/evidence',reportName):'';
  const script=path.join('src/scripts',item.script);const scriptHash=hash(script);
  const attempt:Record<string,any>={...item,startedAt:new Date().toISOString(),scriptSha256:scriptHash,pass:false};evidence.attempts.push(attempt);save();
  const log=path.join(logRoot,`${item.round}-${item.kind}.log`);let stdout='';
  const exitCode=await new Promise<number|null>((resolve,reject)=>{
   const child=spawn(process.execPath,[entry,script,...(item.kind==='quote'?['--output',reportName]:[])],{windowsHide:true,stdio:['ignore','pipe','pipe']});
   child.stdout.on('data',(chunk:Buffer)=>{fs.appendFileSync(log,chunk);stdout=(stdout+chunk.toString()).slice(-200000);const match=stdout.match(/(?:^|\n)Evidence: ([^\r\n]+)/);if(match&&!reportPath){reportPath=match[1]!;attempt.report=reportPath;save();}});
   child.stderr.on('data',(chunk:Buffer)=>fs.appendFileSync(log,chunk));child.once('error',reject);child.once('close',resolve);
  });
  attempt.exitCode=exitCode;attempt.report=reportPath;attempt.log=log;attempt.finishedAt=new Date().toISOString();save();
  assert.ok(reportPath,'Child did not identify its evidence');
  const resolved=path.resolve(reportPath);const relative=path.relative(path.resolve('docs/evidence'),resolved);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
  const report=JSON.parse(fs.readFileSync(resolved,'utf8'));attempt.taskId=report.taskId;attempt.reportSha256=hash(resolved);attempt.error=report.error;
  assert.equal(hash(runtime),expected);assert.equal(hash(script),scriptHash);assert.equal(report.provenance.runtimeSha256.toLowerCase(),expected);
  if(exitCode!==0||report.pass!==true){
   attempt.error=report.error??`Trial exited ${exitCode} without a pass`;save();
   if(!collectAll)throw new Error('Trial failed; stop without automatic repair/retry');
   // A timed-out observer can leave a live task: never overlap the next trial.
   await idle();
   const state=await fetch(`http://127.0.0.1:3939/api/tasks/${encodeURIComponent(String(report.taskId))}`,{signal:AbortSignal.timeout(15000)});
   assert.ok(state.ok,'Cannot prove failed trial is terminal');
   const task=await state.json() as any;
   assert.ok(['done','error','cancelled'].includes(task.task?.status),'Failed trial is not terminal; stop cohort');
   console.log(`FAIL cohort ${item.round}/${3} ${item.kind}: ${reportPath}`);
   continue;
  }
  assert.equal(report.provenance.runtimeSha256After.toLowerCase(),expected);assert.ok(report.independentProbe?.pass);
  attempt.pass=true;save();console.log(`PASS cohort ${item.round}/${3} ${item.kind}: ${reportPath}`);
 }
 evidence.complete=true;evidence.pass=evidence.attempts.every((attempt:{pass:boolean})=>attempt.pass);
 evidence.counts={passed:evidence.attempts.filter((attempt:{pass:boolean})=>attempt.pass).length,total:plan.length};
 if(!evidence.pass)process.exitCode=1;
}catch(error){evidence.error=String(error);process.exitCode=1;console.error(String(error));}
finally{evidence.finishedAt=new Date().toISOString();save();console.log(output);}
