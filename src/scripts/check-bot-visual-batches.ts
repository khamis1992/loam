import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {loadConfig} from '../config.js';
import {verifyApplication} from '../agent/appVerification.js';
import type {ChatOptions,OllamaClient} from '../ollama.js';

const cfg=loadConfig();cfg.workspace=fs.mkdtempSync(path.join(os.tmpdir(),'loam-visual-batches-'));cfg.vision.enabled=true;
fs.writeFileSync(path.join(cfg.workspace,'index.html'),'<h1>Actual browser screenshot</h1>');
fs.writeFileSync(path.join(cfg.workspace,'app-verification.json'),JSON.stringify({entry:'index.html',scenarios:Array.from({length:7},(_,i)=>({name:'view '+i,steps:[{action:'visible',selector:'h1'}]}))}));
for(const mode of ['pass','late-rejection','late-unavailable','early-rejection','early-unavailable']){
 const seen:string[][]=[];
 let active=0,peak=0;const signals=new Set<AbortSignal|undefined>();const completed:string[]=[];
 const model={chat:async(o:ChatOptions)=>{
  const names=o.messages.filter(m=>m.images?.length).map(m=>m.content.replace('Actual screenshot ',''));seen.push(names);
  assert.ok(names.length>0&&names.length<=12);
  active++;peak=Math.max(peak,active);signals.add(o.signal);
  const late=names.includes('mobile-6.png');
  try {
  await new Promise(resolve=>setTimeout(resolve,late?5:60));
  if((mode==='late-unavailable'&&late)||(mode==='early-unavailable'&&!late))throw new Error('HTTP 503');
  const reject=(mode==='late-rejection'&&late)||(mode==='early-rejection'&&!late);
  completed.push(late?'late':'early');
  return {model:'fixture',content:JSON.stringify({verdict:reject?'revise':'pass',reason:reject?'late mobile defect':'fixture screenshot batch reviewed',issues:reject?['late mobile defect']:[]}),toolCalls:[],usage:{promptTokens:3,completionTokens:2,durationMs:1}};
  }finally{active--;}
 }} as unknown as OllamaClient;
 const result=await verifyApplication({cfg,ollama:model,request:'Show the page on desktop and mobile.'});
 assert.equal(result.checks.length,14);
 assert.equal(active,0,'All sibling calls must settle before returning');assert.equal(peak,2,'Two batches should overlap, never exceed concurrency two');assert.equal(signals.size,1,'All calls share the application deadline');
 const visual=result.visual as {complete:boolean;reviewedScreenshots:string[];batches:unknown[];batchRuns:Array<{batch:number;screenshots:string[];elapsedMs:number;status:string;attempts:number;error?:string}>};
 assert.deepEqual(visual.batchRuns.map(b=>b.batch),[1,2]);
 assert.deepEqual(visual.batchRuns.flatMap(b=>b.screenshots),result.screenshots);
 assert.ok(visual.batchRuns.every(b=>b.elapsedMs>=0&&b.status!=='running'));
 if(mode.endsWith('unavailable')){
  const failed=visual.batchRuns.filter(b=>b.status==='unavailable');assert.equal(failed.length,1);
  assert.equal(failed[0]!.attempts,2);assert.match(failed[0]!.error!,/HTTP 503/);
 }else assert.ok(visual.batchRuns.every(b=>b.status==='response'&&b.attempts===1));
 if(mode==='pass'){
  assert.equal(result.pass,true,result.reason);assert.equal(visual.complete,true);
  assert.deepEqual(visual.reviewedScreenshots,result.screenshots);
  assert.equal(new Set(seen.flat()).size,14);assert.equal(seen.length,2);assert.equal(result.usage.promptTokens,6);
  assert.deepEqual(completed,['late','early'],'A faster second batch must not reorder evidence');
 }else{
  assert.equal(result.pass,false);assert.equal(visual.complete,false);
  if(mode.endsWith('unavailable')){assert.equal(result.unavailable,true);assert.equal(seen.length,3);assert.deepEqual(seen[mode==='late-unavailable'?1:0],seen[2]);assert.equal(result.usage.promptTokens,3);assert.equal(visual.batches.length,1,'Preserve the successful sibling even when the first batch fails');}
  else {assert.equal(seen.length,2);assert.match(result.reason,/late mobile defect/);assert.equal(result.usage.promptTokens,6);}
 }
 console.log(`PASS visual batches ${mode}: no screenshot omission and no completion after a later batch failure`);
}

// Cancellation while both image requests are in flight must settle both before
// verification rejects; neither sibling can outlive the cancelled verification.
const cancel=new AbortController();let active=0,started=0,settled=0;
const cancelling={chat:async(o:ChatOptions)=>{
 active++;started++;
 try{
  await new Promise<void>((resolve,reject)=>{
   const aborted=()=>{clearTimeout(timer);reject(o.signal!.reason);};
   const timer=setTimeout(()=>{o.signal!.removeEventListener('abort',aborted);reject(new Error('Sibling cancellation did not propagate'));},2000);
   o.signal!.addEventListener('abort',aborted,{once:true});
   if(o.signal!.aborted)aborted();
   if(active===2)cancel.abort(new Error('User cancelled parallel verification'));
  });
  throw new Error('Unexpected successful cancelled review');
 }finally{active--;settled++;}
}} as unknown as OllamaClient;
await assert.rejects(verifyApplication({cfg,ollama:cancelling,request:'Show the page.',signal:cancel.signal}),/User cancelled parallel verification/);
assert.equal(started,2);assert.equal(settled,2);assert.equal(active,0);
console.log('PASS cancellation settles both visual batches before verification returns');
