import fs from 'node:fs';
import {loadConfig} from '../config.js';
import {OllamaClient} from '../ollama.js';
const cfg=loadConfig();const client=new OllamaClient(cfg.ollamaUrl);
const models=process.argv.slice(2);if(!models.length)throw new Error('Provide observed installed model names');
const available=await client.listModels();for(const model of models)if(!available.includes(model))throw new Error('Model is not in the configured local catalog: '+model);
const rows=[];
for(const model of models){
 const started=Date.now();
 try{const result=await client.chat({model,messages:[{role:'user',content:'Return exactly this JSON object and nothing else: {"ok":true}'}],temperature:0,timeoutMs:45000});
 rows.push({model,elapsedMs:Date.now()-started,transportComplete:true,exactResponse:result.content.trim()==='{"ok":true}',response:result.content,usage:result.usage});
 }catch(error){rows.push({model,elapsedMs:Date.now()-started,transportComplete:false,error:String(error)});}
 console.log(JSON.stringify(rows.at(-1)));
}
const output=`docs/evidence/bot-model-health-${Date.now()}.json`;
fs.writeFileSync(output,JSON.stringify({at:new Date().toISOString(),scope:'Tiny text transport diagnostic only; no capability, vision or comparative quality claim; no application settings changed',rows},null,2));console.log(output);
