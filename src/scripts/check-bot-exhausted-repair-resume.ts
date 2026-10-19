import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadConfig} from '../config.js';
import {runOrchestratedAgent} from '../agent/orchestrator.js';
import type {ExecutionCheckpoint} from '../agent/checkpoint.js';
import type {AgentEvent} from '../agent/events.js';
import type {ChatOptions,OllamaClient} from '../ollama.js';
import {ToolRegistry} from '../tools/registry.js';

for(const again of [false,true]){
 const cfg=loadConfig();cfg.fallbackModel=cfg.model;cfg.orchestrator.maxStepsPerWorker=1;
 cfg.workspace=fs.mkdtempSync(path.join(os.tmpdir(),'loam-exhausted-repair-'));
 const artifact=path.join(cfg.workspace,'correction.txt');
 let checkpoint:ExecutionCheckpoint|undefined;let writes=0,reads=0,calls=0;
 const events:AgentEvent[]=[];const tools=new ToolRegistry();
 tools.register({name:'file_write',description:'append once',parameters:{},run:async()=>{writes++;fs.appendFileSync(artifact,'correction saved\n');return {ok:true,content:'correction saved'};}});
 tools.register({name:'file_read',description:'inspect saved correction',parameters:{},run:async()=>{reads++;return {ok:true,content:fs.existsSync(artifact)?fs.readFileSync(artifact,'utf8'):'missing'};}});
 const client={chat:async(o:ChatOptions)=>{
  calls++;const system=o.messages[0]?.content??'';let content='draft';let toolCalls:any[]=[];
  if(system.includes('planner role'))content=JSON.stringify({goal:'correct report',trivial:false,steps:[{id:'s1',title:'draft',instruction:'draft report',successCriteria:'draft exists'}]});
  else if(system.includes('ONE executed plan step'))content=JSON.stringify({verdict:'pass',reason:'draft reviewed'});
  else if(system.includes('COMPLETED task as a whole')){
   if(writes&&!o.messages.some(m=>m.role==='tool')){content='';toolCalls=[{function:{name:'file_read',arguments:{}}}];}
   else {const pass=Boolean(writes&&o.messages.some(m=>m.content.includes('corrected answer')));content=JSON.stringify({verdict:pass?'pass':'revise',reason:'inspect correction and answer',fixes:pass?[]:['save correction and return corrected answer']});}
  }else if(o.messages.some(m=>m.role==='user'&&m.content.includes('Fix the final answer now'))){
   if(!o.messages.some(m=>m.role==='tool')){content='';toolCalls=[{function:{name:'file_write',arguments:{}}}];}
   else if(again){content='';toolCalls=[{function:{name:'file_read',arguments:{}}}];}
   else content='corrected answer';
  }
  return {model:'fixture',content,toolCalls,usage:{promptTokens:1,completionTokens:1,durationMs:1}};
 }} as unknown as OllamaClient;
 const options={cfg,ollama:client,tools,prompt:'Create correct report',emit:(e:AgentEvent)=>events.push(e),saveCheckpoint:(cp:ExecutionCheckpoint)=>{checkpoint=structuredClone(cp);}};
 await assert.rejects(runOrchestratedAgent(options),/final revision worker failed: stopped after 1 steps/);
 assert.equal(writes,1);assert.equal(checkpoint?.worker?.steps,1);assert.ok(checkpoint?.finalRepairPrompt);
 assert.ok(!events.some(e=>e.type==='done'||e.type==='assistant_message'));
 const saved=structuredClone(checkpoint!);const before=calls;
 if(again){
  await assert.rejects(runOrchestratedAgent({...options,resume:saved}),/stopped after 2 steps/);
  assert.equal(calls-before,1,'Only one extra bounded slice, no automatic budget renewal');
  assert.equal(checkpoint?.worker?.steps,2);assert.ok(!events.some(e=>e.type==='done'));
 }else{
  const result=await runOrchestratedAgent({...options,resume:saved});assert.equal(result.verified,true);
  assert.equal(result.text,'corrected answer');assert.equal(result.usage.promptTokens,calls,'Saved usage counted once');
  const gate=events.findIndex(e=>e.type==='verify'&&e.verdict==='pass');assert.ok(gate>=0&&events.findIndex(e=>e.type==='done')>gate);
 }
 assert.equal(writes,1,'Never replay the saved append');assert.ok(reads>0);
 assert.equal(fs.readFileSync(artifact,'utf8'),'correction saved\n');
 console.log('PASS exhausted repair resume '+(again?'stops at next budget':'finishes after mandatory gate')+'; saved effect not replayed');
}
