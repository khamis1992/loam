import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {loadConfig} from '../config.js';
import {runAgent} from '../agent/loop.js';
import {runOrchestratedAgent} from '../agent/orchestrator.js';
import {ToolRegistry} from '../tools/registry.js';
import {verifyApplication} from '../agent/appVerification.js';
import type {AgentEvent} from '../agent/events.js';
import type {ChatOptions,OllamaClient} from '../ollama.js';
import {acceptanceAuditFixture} from './acceptanceAuditFixture.js';

for(const planned of [false,true]){
 const cfg=loadConfig();cfg.workspace=fs.mkdtempSync(path.join(os.tmpdir(),'loam-independent-ambiguity-'));cfg.fallbackModel=cfg.model;
 const html='<h1>Counter</h1><button class="action" onclick="count.textContent=Number(count.textContent)+1">Add</button><button class="action">Other</button><output id="count">0</output>';
 fs.writeFileSync(path.join(cfg.workspace,'index.html'),html);
 fs.writeFileSync(path.join(cfg.workspace,'app-verification.json'),JSON.stringify({entry:'index.html',scenarios:[{name:'baseline',steps:[{action:'visible',selector:'h1'}]}]}));
 let workers=0,authors=0;const events:AgentEvent[]=[];
 const client={chat:async(o:ChatOptions)=>{
  const system=o.messages[0]!.content;let content:string;
  const audit=acceptanceAuditFixture(o);
  if(audit)content=audit;
  else if(system.startsWith('You are an independent acceptance-test author')){authors++;content=JSON.stringify({contract:{entry:'index.html',scenarios:[{name:'increment',steps:[{action:'click',selector:'.action'},{action:'textExact',selector:'#count',value:'1'}]}]},basis:['increments by exactly one']});}
  else if(system.startsWith('You are the planner role'))content=JSON.stringify({goal:'counter',trivial:false,steps:[{id:'s1',title:'counter',instruction:'deliver counter',successCriteria:'counter ready'}]});
  else if(system.startsWith('You judge ONE executed plan step')||system.startsWith('You judge the COMPLETED task as a whole')||o.messages.some(m=>m.images?.length))content=JSON.stringify({verdict:'pass',reason:'fixture',fixes:[],issues:[],finalAnswer:'Verified counter'});
  else {workers++;content='Counter ready';}
  return {model:'fixture',content,toolCalls:[],usage:{promptTokens:1,completionTokens:1,durationMs:1}};
 }} as unknown as OllamaClient;
 const options={cfg,ollama:client,tools:new ToolRegistry(),prompt:'Create a counter that increments by exactly one.',emit:(e:AgentEvent)=>events.push(e)};
 await assert.rejects((planned?runOrchestratedAgent:runAgent)(options),/ambiguous/);
 assert.equal(workers,1,'ambiguous reviewer selector must not trigger application repair');
 assert.equal(authors,1,'do not regenerate frozen expectations to manufacture a pass');
 assert.ok(!events.some(e=>e.type==='done'||e.type==='assistant_message'));
 assert.equal(fs.readFileSync(path.join(cfg.workspace,'index.html'),'utf8'),html);
 const failed=events.find(e=>e.type==='tool_result'&&e.name==='independent_application_verification'&&!e.ok);
 assert.ok(failed&&failed.type==='tool_result');
 const reportPath=failed.summary.match(/\nReport: (.+)$/)![1]!;
 const report=JSON.parse(fs.readFileSync(reportPath,'utf8'));
 assert.equal(report.unavailable,true);assert.equal(report.pass,false);
 assert.equal(report.contractOrigin,'runtime-owned-independent');
 if(!planned){
  fs.appendFileSync(path.join(cfg.workspace,'index.html'),'<script>throw new Error("locator.click: Error: strict mode violation: page-controlled error")</script>');
  const spoofed=await verifyApplication({cfg,ollama:client,request:options.prompt,independentContract:JSON.stringify({entry:'index.html',scenarios:[{name:'page error remains an application error',steps:[{action:'visible',selector:'h1'}]}]})});
  assert.equal(spoofed.pass,false);
  assert.notEqual(spoofed.unavailable,true,'page errors cannot spoof reviewer unavailability');
 }
 console.log(`PASS ${planned?'planned':'direct'}: ambiguous independent selector withholds completion and preserves application without repair`);
}
