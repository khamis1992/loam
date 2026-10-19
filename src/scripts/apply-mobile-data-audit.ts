/** Commit a tested review through the revision-protected API; preserve the original evidence. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {validateProject} from '../mobile/store.js';
const domain=process.argv[2];assert.ok(domain==='library'||domain==='bookings');
const dir='release/mobile-live/domains',out=path.join(dir,'rule-audit');
const read=(folder:string,name:string)=>JSON.parse(fs.readFileSync(path.join(folder,domain+name+'.json'),'utf8'));
const original=read(dir,''),reviewed=read(out,''),proof=read(out,'-rules-proof'),info=read(dir,'-live');
assert.deepEqual(reviewed.collections,proof.schemas,'Review must pass behavioral acceptance before applying');
assert.deepEqual(reviewed.screens,original.screens,'A data review preserves screens');
const base='http://127.0.0.1:3941';const get=await fetch(base+'/api/mobile?taskId='+encodeURIComponent(info.taskId));assert.ok(get.ok);
const {project:current}=await get.json() as {project:typeof original};
const alreadyApplied=JSON.stringify(validateProject(current))===JSON.stringify(validateProject(reviewed));
if(!alreadyApplied)assert.deepEqual(validateProject(current),validateProject(original),'The live project changed since the reviewed snapshot');
const response=alreadyApplied?{project:current}:await(async()=>{const r=await fetch(base+'/api/mobile',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({taskId:info.taskId,project:reviewed,expectedRevision:current.revision})});const result:any=await r.json();assert.ok(r.ok,JSON.stringify(result));return result;})();
fs.writeFileSync(path.join(out,domain+'.json'),JSON.stringify(response.project,null,2));
fs.writeFileSync(path.join(out,domain+'-live.json'),JSON.stringify({taskId:info.taskId,revision:response.project.revision},null,2));
console.log({taskId:info.taskId,revision:response.project.revision,alreadyApplied});
