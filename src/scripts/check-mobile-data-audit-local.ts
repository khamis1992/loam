/** Review the unmodified, previously generated draft against its original product request. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {OllamaClient} from '../ollama.js';
import {buildMobile} from '../mobile/build.js';
import {readMobile,saveMobile} from '../mobile/store.js';
import {verifyDomain} from './mobile-domain-acceptance.js';
const domain=process.argv[2]||'bookings';assert.ok(domain==='bookings'||domain==='library');
const dir='release/mobile-live/domains',out=path.join(dir,'rule-audit');fs.mkdirSync(out,{recursive:true});
const original=JSON.parse(fs.readFileSync(path.join(dir,domain+'.json'),'utf8'));
const {brief}=JSON.parse(fs.readFileSync(path.join(dir,domain+'-generation.json'),'utf8'));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'loam-rule-audit-'));const current=saveMobile(root,original,0);
const model='qwen2.5:14b',client=new OllamaClient('http://127.0.0.1:11434'),events:unknown[]=[],responses:unknown[]=[];
await buildMobile({root,model,brief,operation:'review-data',expectedRevision:current.revision,signal:AbortSignal.timeout(240000),
 emit:event=>{events.push(event);console.log(event.type,event.phase||'');fs.writeFileSync(path.join(out,domain+'-events.json'),JSON.stringify({brief,events},null,2));},
 ollama:{chat:async options=>{const response=await client.chat(options);responses.push(response);fs.writeFileSync(path.join(out,domain+'-responses.json'),JSON.stringify(responses,null,2));return response;}}
});
const project=readMobile(root)!;assert.deepEqual(project.screens,current.screens,'Review preserves every screen and block');
fs.writeFileSync(path.join(out,domain+'.json'),JSON.stringify(project,null,2));
console.log(await verifyDomain(domain,project,out));
