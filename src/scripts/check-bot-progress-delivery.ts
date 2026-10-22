import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { runOrchestratedAgent } from "../agent/orchestrator.js";
import { ToolRegistry } from "../tools/registry.js";
import type { AgentEvent } from "../agent/events.js";
import type { ChatOptions, OllamaClient } from "../ollama.js";
for (const accept of [true,false]) {
  const cfg=loadConfig(); cfg.workspace=fs.mkdtempSync(path.join(os.tmpdir(),"loam-progress-delivery-"));
  const draft="UNVERIFIED_WORKER_SUCCESS_CLAIM";
  const events:AgentEvent[]=[];
  let finalReviews=0;
  const client={chat:async(o:ChatOptions)=>{
    const system=o.messages[0]?.content??"";
    let content=draft;
    if(system.includes("planner role")) content=JSON.stringify({goal:"report",trivial:false,steps:[{id:"s1",title:"report",instruction:"write report",successCriteria:"correct report"}]});
    else if(system.includes("ONE executed plan step")) content=JSON.stringify({verdict:"pass",reason:"step evidence reviewed",fixes:[]});
    else if(system.includes("COMPLETED task as a whole")) {
      finalReviews++;
      assert.ok(o.messages.some(m=>m.content.includes(draft)),"final verifier retains private draft");
      assert.ok(!JSON.stringify(events).includes(draft),"draft must not leak through progress summaries");
      content=JSON.stringify({verdict:accept?"pass":"revise",reason:"whole task reviewed",fixes:accept?[]:["correct result"]});
    }
    return{model:"fixture",content,toolCalls:[],usage:{promptTokens:1,completionTokens:1,durationMs:1}};
  }} as unknown as OllamaClient;
  const promise=runOrchestratedAgent({cfg,ollama:client,tools:new ToolRegistry(),prompt:"Write report",emit:e=>events.push(e)});
  if(accept) {
    const result=await promise; assert.equal(result.verified,true);
    const verified=events.findIndex(e=>e.type==="verify"&&e.verdict==="pass");
    assert.ok(verified>=0);
    assert.ok(events.findIndex(e=>e.type==="assistant_message")>verified);
  } else {
    await assert.rejects(promise,/verification/);
    assert.ok(!JSON.stringify(events).includes(draft));
    assert.ok(!events.some(e=>e.type==="done"||e.type==="assistant_message"));
  }
  assert.ok(finalReviews>0);
  assert.ok(events.some(e=>e.type==="plan_step"&&e.phase==="done"),"neutral step progress remains available");
  console.log(`PASS progress draft isolation, final accepted=${accept}`);
}
