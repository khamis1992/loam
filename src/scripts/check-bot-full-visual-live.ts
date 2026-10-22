import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadConfig} from '../config.js';
import {OllamaClient} from '../ollama.js';
import {verifyApplication} from '../agent/appVerification.js';

const taskId=process.argv[2];assert.ok(taskId&&/^task_[a-zA-Z0-9]+$/.test(taskId));
const base='http://127.0.0.1:3939';
const read=async(route:string)=>{const response=await fetch(base+route,{signal:AbortSignal.timeout(15000)});assert.ok(response.ok);return response.json() as Promise<any>;};
const {task}=await read('/api/tasks/'+taskId);
assert.ok(['done','error','cancelled','interrupted'].includes(task.status),'Do not verify a changing active artifact');
const queue=await read('/api/queue');assert.equal(queue.actives.length+queue.queued.length,0);
const caps=await read('/api/bot/capabilities');assert.equal(caps.applicationVerification.visualReviewCoverage?.allCapturedScreenshots,true,'Install verified full-coverage runtime first');
const cfg=loadConfig();cfg.workspace=task.workspace;cfg.vision.enabled=true;cfg.vision.model=caps.visualModel;
const fingerprint=()=>Object.fromEntries(['index.html','server.mjs','app-verification.json'].map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(task.workspace,file))).digest('hex')]));
const before=fingerprint();
const output=`docs/evidence/bot-full-visual-live-${taskId}-${Date.now()}.json`;
const evidence:Record<string,any>={at:new Date().toISOString(),taskId,originalTaskStatus:task.status,scope:'separate real-model verification of unchanged generated artifact; not an autonomous task retry',sourceHashesBefore:before,pass:false};
try{
 const report=await verifyApplication({cfg,ollama:new OllamaClient(cfg.ollamaUrl),request:task.prompt,signal:AbortSignal.timeout(360000)});
 evidence.report=report;evidence.sourceHashesAfter=fingerprint();assert.deepEqual(evidence.sourceHashesAfter,before);
 assert.equal(report.pass,true,report.reason);assert.ok(report.screenshots.length>12,'Exercise more than one visual batch');
 const visual=report.visual as {complete:boolean;reviewedScreenshots:string[];batches:unknown[]};
 assert.equal(visual.complete,true);assert.deepEqual(visual.reviewedScreenshots,report.screenshots);assert.ok(visual.batches.length>1);
 evidence.pass=true;console.log('PASS full real-model visual coverage on unchanged artifact: '+report.screenshots.length+' screenshots');
}catch(error){evidence.error=String(error);process.exitCode=1;console.error(String(error));}
finally{fs.writeFileSync(output,JSON.stringify(evidence,null,2));console.log(output);}
