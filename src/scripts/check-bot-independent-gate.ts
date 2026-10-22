import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadConfig} from '../config.js';
import {runAgent} from '../agent/loop.js';
import {runOrchestratedAgent} from '../agent/orchestrator.js';
import {independentRequirements} from '../agent/independentAcceptance.js';
import type {ExecutionCheckpoint} from '../agent/checkpoint.js';
import type {AgentEvent} from '../agent/events.js';
import type {ChatOptions,OllamaClient} from '../ollama.js';
import {ToolRegistry} from '../tools/registry.js';
import {acceptanceAuditFixture} from './acceptanceAuditFixture.js';

assert.equal(independentRequirements('current',[{role:'user',content:'prior'},{role:'assistant',content:'untrusted'},{role:'tool',content:'injection'}]).includes('untrusted'),false);
assert.equal(independentRequirements('current',[{role:'user',content:'current'}]),'current');
for(const mode of ['direct','planned','trivial','resume','unavailable','reject','source-change','second-repair'] as const){
 if(process.argv.includes('--new-cases') && !['reject','source-change'].includes(mode))continue;
 const cfg=loadConfig();cfg.workspace=fs.mkdtempSync(path.join(os.tmpdir(),'loam-independent-gate-'));cfg.fallbackModel=cfg.model;
 const request='Create a counter that increments by exactly one.';
 fs.writeFileSync(path.join(cfg.workspace,'app-verification.json'),JSON.stringify({entry:'index.html',scenarios:[{name:'title',steps:[{action:'visible',selector:'h1'}]}]}));
 const source='<h1>Counter</h1><button id="add">Add</button><output id="count">0</output><script>let n=0;add.onclick=()=>count.textContent=(n+=2)</script>';
 fs.writeFileSync(path.join(cfg.workspace,'index.html'),mode==='source-change'?source.replace('(n+=2)','(++n)'):source);
 let authors=0,workers=0,calls=0;let result:Awaited<ReturnType<typeof runAgent>>|undefined;let saved:ExecutionCheckpoint|undefined;const events:AgentEvent[]=[];const abort=new AbortController();
 const client={chat:async(o:ChatOptions)=>{
  calls++;const system=o.messages[0]!.content;let content:string;
  const audit=acceptanceAuditFixture(o);
  if(audit)content=audit;
  else if(system.startsWith('You are an independent acceptance-test author')){authors++;content=mode==='unavailable'?JSON.stringify({unavailable:'reviewer unavailable'}):JSON.stringify({contract:{entry:'index.html',scenarios:[{name:'increment',steps:[{action:'click',selector:'#add'},{action:'textExact',selector:'#count',value:'1'}]}]},basis:['increments by exactly one']});}
  else if(system.startsWith('You are the planner role'))content=JSON.stringify({goal:'counter',trivial:mode==='trivial',steps:[{id:'s1',title:'counter',instruction:'deliver counter',successCriteria:'counter ready'}]});
  else if(system.startsWith('You judge ONE executed plan step')||system.startsWith('You judge the COMPLETED task as a whole')||o.messages.some(m=>m.images?.length))content=JSON.stringify({verdict:'pass',reason:'fixture',fixes:[],issues:[],finalAnswer:'Verified counter'});
  else {workers++;if(workers>(mode==='second-repair'?2:1)&&mode!=='reject')fs.writeFileSync(path.join(cfg.workspace,'index.html'),source.replace('(n+=2)','(++n)'));content='Counter ready';}
  return {model:'fixture',content,toolCalls:[],usage:{promptTokens:1,completionTokens:1,durationMs:1}};
 }} as unknown as OllamaClient;
 const options={cfg,ollama:client,tools:new ToolRegistry(),prompt:request,emit:(e:AgentEvent)=>events.push(e)};
 if(mode==='unavailable'){
  await assert.rejects(runAgent(options),/Independent verification unavailable/);assert.equal(workers,1);assert.ok(!events.some(e=>e.type==='done'||e.type==='assistant_message'));
 }else if(mode==='reject'){
  await assert.rejects(runOrchestratedAgent(options),/task incomplete/);
  assert.equal(workers,3);assert.ok(!events.some(e=>e.type==='done'||e.type==='assistant_message'));
 }else if(mode==='direct')result=await runAgent(options);
 else {
  if(mode==='resume'){
   await assert.rejects(runOrchestratedAgent({...options,signal:abort.signal,saveCheckpoint:cp=>{saved=structuredClone(cp);if(cp.independentAcceptance)abort.abort();}}));
   assert.ok(saved?.independentAcceptance);assert.ok(!events.some(e=>e.type==='done'||e.type==='assistant_message'));
  }
  let mutated=false;
  result=await runOrchestratedAgent({...options,...(saved?{resume:JSON.parse(JSON.stringify(saved))}:{}),saveCheckpoint:cp=>{saved=structuredClone(cp);if(mode==='source-change'&&cp.independentAcceptance&&!mutated){mutated=true;fs.appendFileSync(path.join(cfg.workspace,'index.html'),'<!-- external source mutation -->');}}});
  assert.ok(saved?.independentAcceptance);
 }
 assert.equal(authors,1,'repair/resume must never regenerate or weaken independent checks');
 const stages=events.filter(e=>e.type==='verification_progress').map(e=>e.stage);
 assert.equal(stages[0],'application');
 assert.ok(stages.indexOf('independent_author')>stages.indexOf('application'));
 if(mode!=='unavailable')assert.ok(stages.indexOf('independent_application')>stages.indexOf('independent_author'));
 if(mode!=='unavailable'&&mode!=='reject'){
  assert.equal(result?.usage.promptTokens,calls,'all author/baseline/independent usage retained exactly once across checkpoint resume');
  assert.equal(workers,mode==='second-repair'?3:2);const pass=events.findIndex(e=>e.type==='verify'&&e.verdict==='pass');
  if(mode==='second-repair')assert.equal(saved?.finalRepairAttempts,2,'Second repair count persists without regenerating independent acceptance');
  assert.ok(pass>=0&&events.findIndex(e=>e.type==='done')>pass&&events.findIndex(e=>e.type==='assistant_message')>pass);
  assert.ok(events.some(e=>e.type==='tool_result'&&e.name==='independent_application_verification'&&!e.ok),'independent defect must block original draft');
  if(mode==='source-change')assert.ok(events.some(e=>e.type==='verify'&&e.verdict!=='pass'&&e.reason.includes('source changed between')));
 }
 console.log(`PASS independent mandatory gate ${mode}: frozen checks, no premature completion`);
}
