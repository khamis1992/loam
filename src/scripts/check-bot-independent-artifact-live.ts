import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadConfig} from '../config.js';
import {OllamaClient} from '../ollama.js';
import {authorIndependentAcceptance,IndependentAcceptanceGuard} from '../agent/independentAcceptance.js';
import {verifyApplication} from '../agent/appVerification.js';

const taskId=process.argv[2];assert.ok(taskId&&/^task_[a-zA-Z0-9]+$/.test(taskId));
const read=async(route:string)=>{const r=await fetch('http://127.0.0.1:3939'+route,{signal:AbortSignal.timeout(15000)});assert.ok(r.ok);return r.json() as Promise<any>;};
const {task}=await read('/api/tasks/'+taskId);
assert.ok(['done','error','interrupted','cancelled'].includes(task.status),'Do not inspect a changing active artifact');
const queue=await read('/api/queue');assert.equal(queue.actives.length+queue.queued.length,0);
const users=task.messages.filter((m:any)=>m.role==='user');assert.equal(users.length,1,'This diagnostic targets a single original request');
const request=users[0].content;assert.equal(typeof request,'string');
const cfg=loadConfig();cfg.workspace=task.workspace;cfg.model='glm-5.3-flash:cloud';cfg.orchestrator.verifierModel=cfg.model;cfg.vision.model=cfg.model;cfg.vision.enabled=true;
const fingerprint=()=>Object.fromEntries(['index.html','server.mjs','app-verification.json'].map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(task.workspace,file))).digest('hex')]));
const before=fingerprint();const output=`docs/evidence/bot-independent-artifact-live-${taskId}-${Date.now()}.json`;
const evidence:Record<string,any>={at:new Date().toISOString(),taskId,request,sourceHashesBefore:before,pass:false,scope:'Source-runtime diagnostic of real independent author and browser/visual execution on unchanged generated artifact; not installed autonomous completion'};
console.log('Evidence: '+output);
try{
 const ollama=new OllamaClient(cfg.ollamaUrl);
 const authored=await authorIndependentAcceptance({cfg,ollama,request});evidence.authored=authored;
 const guard=new IndependentAcceptanceGuard(request);guard.freeze(authored);
 fs.writeFileSync(output,JSON.stringify(evidence,null,2));
 const report=await verifyApplication({cfg,ollama,request,independentContract:guard.get()!.contract});evidence.report=report;
 assert.equal(report.pass,true,report.reason);
 assert.ok(report.checks.every(c=>c.pass));
 const visual=report.visual as {complete:boolean;reviewedScreenshots:string[]};
 assert.equal(visual.complete,true);assert.deepEqual(visual.reviewedScreenshots,report.screenshots);
 evidence.sourceHashesAfter=fingerprint();assert.deepEqual(evidence.sourceHashesAfter,before);
 evidence.pass=true;console.log('PASS independent real author plus executed browser/visual checks on unchanged artifact');
}catch(error){evidence.error=String(error);process.exitCode=1;console.error(String(error));}
finally{evidence.sourceHashesAfter=fingerprint();if(JSON.stringify(evidence.sourceHashesAfter)!==JSON.stringify(before)){evidence.pass=false;evidence.sourceChanged=true;process.exitCode=1;}fs.writeFileSync(output,JSON.stringify(evidence,null,2));}
